/**
 * SSEParser 单测
 *
 * 重点是 First Chunk Latency 的观测边界：
 * - onChunk 必须在每次 read() 拿到数据时触发，且在解码/解析之前（最早可观测时刻）
 * - 首个数据块只含半条 SSE 帧时，onChunk 已触发但 onData 不应触发（两者本就不同）
 * - done 分支不再触发 onChunk
 */

import { describe, it, expect } from 'vitest'
import { SSEParser, type SSECallbacks } from '../sse-parser'

/** 用给定的分块构造一个流式 reader */
function readerOf(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }).getReader()
}

/**
 * 先吐出给定分块、再以指定错误终止的 reader
 *
 * 必须用 pull 惰性供给：如果在 start 里 enqueue 紧接 error，规范会直接丢弃队列里的分块，
 * 那就测不出"中断前已收到的数据仍然分发"这一真实行为（真实 fetch 也是先给数据、后抛错）。
 */
function erroringReader(chunks: string[], error: Error): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
        return
      }
      controller.error(error)
    },
  }).getReader()
}

/** 读取时抛 AbortError 的 reader（用户点停止 / 浏览器取消请求） */
function abortingReader(chunks: string[] = []): ReadableStreamDefaultReader<Uint8Array> {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return erroringReader(chunks, error)
}

function collect() {
  const chunks: number[] = []
  const events: Array<{ type: string; content?: string }> = []
  const callbacks: SSECallbacks = {
    onChunk: (bytes) => chunks.push(bytes),
    onData: (data) => events.push(data as { type: string; content?: string }),
  }
  return { chunks, events, callbacks }
}

describe('SSEParser 数据块与事件', () => {
  it('每个数据块触发一次 onChunk，每个完整帧触发一次 onData', async () => {
    const { chunks, events, callbacks } = collect()

    await SSEParser.parseStream(
      readerOf(['data: {"type":"thinking","content":"你"}\n\n', 'data: {"type":"answer","content":"好"}\n\n']),
      callbacks
    )

    expect(chunks).toHaveLength(2)
    expect(events).toEqual([
      { type: 'thinking', content: '你' },
      { type: 'answer', content: '好' },
    ])
  })

  it('首个数据块只有半条帧：onChunk 已记首块，onData 要等帧补齐', async () => {
    const { chunks, events, callbacks } = collect()

    await SSEParser.parseStream(
      readerOf(['data: {"type":"thin', 'king","content":"你"}\n\n']),
      callbacks
    )

    // 首块延迟在第一个数据块到达时就成立了（这正是它与"首个事件"的区别）
    expect(chunks).toHaveLength(2)
    expect(events).toEqual([{ type: 'thinking', content: '你' }])
  })

  it('一个数据块包含多个帧时只算一个数据块、多个事件', async () => {
    const { chunks, events, callbacks } = collect()

    await SSEParser.parseStream(
      readerOf([
        'data: {"type":"thinking","content":"a"}\n\ndata: {"type":"answer","content":"b"}\n\n',
      ]),
      callbacks
    )

    expect(chunks).toHaveLength(1)
    expect(events).toHaveLength(2)
  })

  it('[DONE] 映射为 complete 事件，且不产生多余事件', async () => {
    const { events, callbacks } = collect()

    await SSEParser.parseStream(
      readerOf(['data: {"type":"complete"}\n\n', 'data: [DONE]\n\n']),
      callbacks
    )

    expect(events).toEqual([{ type: 'complete' }, { type: 'complete' }])
  })

  it('流结束时残留的不完整帧也会被解析（不留半条数据）', async () => {
    const { events, callbacks } = collect()

    await SSEParser.parseStream(readerOf(['data: {"type":"answer","content":"尾"}\n']), callbacks)

    expect(events).toEqual([{ type: 'answer', content: '尾' }])
  })

  it('未提供 onChunk 回调时不影响解析（向后兼容）', async () => {
    const events: Array<{ type: string; content?: string }> = []

    await SSEParser.parseStream(readerOf(['data: {"type":"answer","content":"x"}\n\n']), {
      onData: (data) => events.push(data as { type: string; content?: string }),
    })

    expect(events).toEqual([{ type: 'answer', content: 'x' }])
  })
})

describe('SSEParser 中断通道', () => {
  it('AbortError 走 onAbort，不再被当成正常读完', async () => {
    const calls: string[] = []

    await SSEParser.parseStream(abortingReader(), {
      onData: () => calls.push('data'),
      onAbort: () => calls.push('abort'),
      onComplete: () => calls.push('complete'),
      onError: () => calls.push('error'),
    })

    expect(calls).toEqual(['abort'])
  })

  it('中断前已到达的内容仍然分发（不丢已收到的数据）', async () => {
    const events: Array<{ type: string; content?: string }> = []
    let aborted = false

    await SSEParser.parseStream(abortingReader(['data: {"type":"answer","content":"半"}\n\n']), {
      onData: (data) => events.push(data as { type: string; content?: string }),
      onAbort: () => {
        aborted = true
      },
    })

    expect(events).toEqual([{ type: 'answer', content: '半' }])
    expect(aborted).toBe(true)
  })

  it('未提供 onAbort 时回退到 onComplete（旧调用不破坏）', async () => {
    const calls: string[] = []

    await SSEParser.parseStream(abortingReader(), {
      onData: () => calls.push('data'),
      onComplete: () => calls.push('complete'),
    })

    expect(calls).toEqual(['complete'])
  })

  it('普通读错误仍走 onError 并向上抛', async () => {
    const reader = erroringReader(
      ['data: {"type":"answer","content":"x"}\n\n'],
      new Error('socket hang up')
    )

    const calls: string[] = []
    await expect(
      SSEParser.parseStream(reader, {
        onData: () => calls.push('data'),
        onError: () => calls.push('error'),
        onComplete: () => calls.push('complete'),
      })
    ).rejects.toThrow('socket hang up')

    expect(calls).toEqual(['data', 'error'])
  })
})

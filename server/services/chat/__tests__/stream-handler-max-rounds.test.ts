/**
 * 集成回归测试：多轮 Function Calling 达到轮次上限时，落库正文不能为空
 *
 * 这个用例真的把 createSSEStreamWithTools 跑完 5 轮：
 * 每一轮上游都返回「一段正文 + 一个 tool_call」，所以循环是因为
 * `while (round < MAX_TOOL_ROUNDS)` 条件失败而退出的 —— 没有"最后一轮无工具调用"的收尾路径。
 *
 * 修复前：finalAnswerContent 只在"无工具调用"分支赋值 → 运行时是 ''
 *        → persistMessage 收到 answerContent: '' （前端已显示最后一轮正文，刷新后消失）
 * 修复后：每轮都用 pickPersistedAnswer 更新 → 落库的是最后一轮正文
 *
 * 外部依赖（上游 HTTP / 数据库 / 工具实现）全部 mock，只验证本模块的编排与落库内容。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  /** 每次 createChatCompletion 返回的下一个 reader（含第 1 轮之后发起的每一轮） */
  readers: [] as unknown[],
  readerIndex: 0,
  /** 每轮请求携带的消息条数，用于验证多轮上下文确实在累积 */
  messageCounts: [] as number[],
  persistMessage: vi.fn(),
  processImageResults: vi.fn((answer: string) => answer),
  executeByName: vi.fn(
    async (
      _name: string,
      _args: Record<string, unknown>,
      _signal?: AbortSignal,
      _context?: unknown
    ): Promise<string> => JSON.stringify({ ok: true })
  ),
}))

vi.mock('@/server/services/ai/siliconflow', () => ({
  createChatCompletion: vi.fn(
    async (_apiKey: string, options: { messages: unknown[] }) => {
      h.messageCounts.push(options.messages.length)
      const reader = h.readers[h.readerIndex]
      h.readerIndex++
      if (!reader) throw new Error('测试没有准备足够的上游流')
      return { reader }
    }
  ),
}))

vi.mock('@/server/services/chat/message-persister', () => ({
  persistMessage: h.persistMessage,
  processImageResults: h.processImageResults,
}))

vi.mock('@/server/services/tools', () => ({
  toolRegistry: {
    executeByName: h.executeByName,
  },
}))

vi.mock('@/server/services/tools/image-generation', () => ({
  executeImageGeneration: vi.fn(async () => ({ url: 'https://example.com/x.png' })),
}))

import { createSSEStreamWithTools } from '@/server/services/chat/stream.handler'

const encoder = new TextEncoder()

/** 把若干"OpenAI 兼容流式 chunk"拼成一个上游流 */
function makeUpstreamStream(chunks: unknown[]): ReadableStreamDefaultReader<Uint8Array> {
  const payload =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  const bytes = encoder.encode(payload)
  let sent = false
  return {
    read: async () => {
      if (sent) return { done: true, value: undefined }
      sent = true
      return { done: false, value: bytes }
    },
    cancel: async () => {},
  } as unknown as ReadableStreamDefaultReader<Uint8Array>
}

/** 一轮的上游响应：一段正文 + 一个 tool_call（arguments 分两片到达，验证按 index 累加） */
function makeRoundChunks(round: number) {
  return [
    { choices: [{ delta: { content: `第${round}轮正文` } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: `call_${round}`, function: { name: 'web_search', arguments: '{"que' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } },
      ],
    },
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

const allowedTools = [
  {
    name: 'web_search',
    description: '联网搜索',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
] as never

function makeContext() {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    userId: 'user-1',
    sessionId: 'sess-1',
    apiKey: 'sk-test',
    model: 'test-model',
    contextMessages: [{ role: 'user', content: '帮我查一下' }],
    enableThinking: false,
    thinkingBudget: 4096,
    allowedTools,
  }
}

/** 把 SSE 流读空（模拟客户端消费），返回收到的事件类型序列 */
async function drain(stream: ReadableStream): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (raw === '[DONE]') {
        events.push('done')
        continue
      }
      try {
        events.push((JSON.parse(raw) as { type: string }).type)
      } catch {
        /* 非法行忽略 */
      }
    }
  }
  return events
}

describe('createSSEStreamWithTools：轮次跑满上限时的持久化内容', () => {
  beforeEach(() => {
    h.readerIndex = 0
    h.messageCounts.length = 0
    h.persistMessage.mockClear()
    h.processImageResults.mockClear()
    h.executeByName.mockClear()
    // 第 1 轮的流由用例显式传入，这里准备的是"第 2~5 轮"各发起一次请求所需的流。
    // 第 5 轮循环体末尾还会再发一次请求（代码里那次请求的 reader 未被消费），所以多给一个兜底。
    h.readers = [2, 3, 4, 5, 6].map((r) => makeUpstreamStream(makeRoundChunks(r)))
  })

  it('5 轮全部带工具调用时，落库正文是最后一轮的正文明文（不是空字符串）', async () => {
    const stream = createSSEStreamWithTools(
      makeUpstreamStream(makeRoundChunks(1)) as unknown as ReadableStreamDefaultReader<Uint8Array>,
      makeContext() as never
    )

    const events = await drain(stream)

    // 落库只发生一次，且内容不是空的
    expect(h.persistMessage).toHaveBeenCalledTimes(1)
    const [, , , content] = h.persistMessage.mock.calls[0] as [string, string, string, { answerContent: string }]
    expect(content.answerContent).toBe('第5轮正文')

    // 工具确实被调用了 5 次（一轮一次），且参数分片被正确拼成合法 JSON
    expect(h.executeByName).toHaveBeenCalledTimes(5)
    expect(h.executeByName.mock.calls[0][1]).toEqual({ query: 'x' })

    // 第 1 轮的流由调用方传入，所以 createChatCompletion 只被调用 5 次（第 2~6 轮）。
    // 第 6 轮那次是循环体末尾发出的请求、其 reader 未被消费 —— 见下方注释断言。
    expect(h.messageCounts).toHaveLength(5)
    // 每轮把「assistant(tool_calls) + 1 条 tool 结果」追加进上下文，所以消息数每轮 +2
    expect(h.messageCounts).toEqual([3, 5, 7, 9, 11])

    // 客户端侧拿到了完整收尾事件
    expect(events.filter((e) => e === 'tool_call')).toHaveLength(5)
    expect(events.filter((e) => e === 'complete')).toHaveLength(1)
    expect(events.at(-1)).toBe('done')
  })

  it('对照：某一轮不再调用工具时，落库的就是那一轮正文（原有正常路径未被破坏）', async () => {
    // 第 2 轮没有 tool_call → 循环在 round=2 就 break
    h.readers = [
      makeUpstreamStream([{ choices: [{ delta: { content: '最终回答' } }] }]),
    ]

    const stream = createSSEStreamWithTools(
      makeUpstreamStream(makeRoundChunks(1)) as unknown as ReadableStreamDefaultReader<Uint8Array>,
      makeContext() as never
    )
    await drain(stream)

    const [, , , content] = h.persistMessage.mock.calls[0] as [string, string, string, { answerContent: string }]
    expect(content.answerContent).toBe('最终回答')
    expect(h.executeByName).toHaveBeenCalledTimes(1)
    // 只有第 2 轮这一次后续请求，上下文为「原始 1 条 + assistant + tool」= 3 条
    expect(h.messageCounts).toEqual([3])
  })
})

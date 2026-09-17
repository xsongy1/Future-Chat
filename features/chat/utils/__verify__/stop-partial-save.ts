/**
 * 独立验证脚本：用户点 Stop 时，rAF 缓冲里"尚未 flush"的内容会不会落库？
 *
 * 为什么不用 vitest：
 *   vitest → vite → esbuild 需要以管道方式 spawn 子进程，在受限沙箱下固定 EPERM。
 *   本脚本改为纯 node 运行（tsx --test 也不需要，直接 node 跑）。
 *
 * 运行：pnpm tsx features/chat/utils/__verify__/stop-partial-save.ts
 *   （或 node --experimental-strip-types）
 *
 * StreamBuffer 实现与 features/chat/utils/stream-buffer.ts 完全一致（逐行对照抄写），
 * 唯一区别是把 requestAnimationFrame 换成了可手动控制的手动帧。
 */

import assert from 'node:assert/strict'

// ===========================================================================
// 与 features/chat/utils/stream-buffer.ts 逐行一致的实现
// ===========================================================================
class StreamBuffer {
  private buffer = ''
  private rafId: number | null = null
  private onFlush: (content: string) => void
  private isSSR: boolean
  private scheduleRaf: (cb: () => void) => number
  private cancelRaf: (id: number) => void

  constructor(options: {
    onFlush: (content: string) => void
    scheduleRaf: (cb: () => void) => number
    cancelRaf: (id: number) => void
    isSSR?: boolean
  }) {
    this.onFlush = options.onFlush
    this.scheduleRaf = options.scheduleRaf
    this.cancelRaf = options.cancelRaf
    this.isSSR = options.isSSR ?? false
  }

  append(chunk: string): void {
    this.buffer += chunk
    if (this.isSSR) {
      this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return // 幂等：同一帧内只调度一次
    this.rafId = this.scheduleRaf(() => {
      this.flush()
      this.rafId = null
    })
  }

  private flush(): void {
    if (this.buffer) {
      this.onFlush(this.buffer)
      this.buffer = ''
    }
  }

  forceFlush(): void {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId)
      this.rafId = null
    }
    this.flush()
  }

  clear(): void {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId)
      this.rafId = null
    }
    this.buffer = ''
  }
}

// ===========================================================================
// 手动可控的 rAF：不自动执行，必须显式调 flushFrame()
// 这精确模拟真实浏览器：rAF 回调一定在本轮同步代码 + 微任务之后才执行
// ===========================================================================
function installManualRaf() {
  const pending = new Map<number, () => void>()
  let nextId = 1
  return {
    scheduleRaf(cb: () => void): number {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelRaf(id: number): void {
      pending.delete(id)
    },
    flushFrame(): void {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb()
    },
    get pendingCount(): number {
      return pending.size
    },
  }
}

// ===========================================================================
// 最小 store
// ===========================================================================
interface FakeMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
}

function createFakeStore(initial: FakeMessage[]) {
  let messages = initial
  return {
    get messages() {
      return messages
    },
    appendContent(id: string, chunk: string) {
      messages = messages.map((m) => (m.id === id ? { ...m, content: m.content + chunk } : m))
    },
    appendThinking(id: string, chunk: string) {
      messages = messages.map((m) => (m.id === id ? { ...m, thinking: (m.thinking || '') + chunk } : m))
    },
  }
}

// ===========================================================================
// 场景 1：复现问题
// ===========================================================================
function case1_reproduce(): { displayed: string; persisted: string } {
  const raf = installManualRaf()
  const store = createFakeStore([
    { id: 'm1', role: 'user', content: '你好' },
    { id: 'm2', role: 'assistant', content: '' },
  ])

  const answerBuffer = new StreamBuffer({
    onFlush: (content) => store.appendContent('m2', content),
    scheduleRaf: raf.scheduleRaf,
    cancelRaf: raf.cancelRaf,
  })

  // 同一帧内到达 3 个 SSE answer 分片
  answerBuffer.append('第一段回答。')
  answerBuffer.append('第二段回答。')
  answerBuffer.append('第三段回答。')

  const storeAtAbortTime = store.messages[1].content
  const pendingFramesAtAbortTime = raf.pendingCount

  // ---- 用户点 Stop：abortStream() 同步块里立刻组请求体并 fetch ----
  const sentBody = {
    content: store.messages[1].content || '',
    thinking: store.messages[1].thinking || '',
  }

  // ---- 之后 rAF / AbortError 微任务才触发 finishStream() → forceFlush ----
  answerBuffer.forceFlush()

  const displayed = store.messages[1].content
  const persisted = sentBody.content

  console.log('\n=== 场景 1：复现（当前实现） ===')
  console.log('  abort 那一刻 store.content :', JSON.stringify(storeAtAbortTime))
  console.log('  abort 那一刻待处理 rAF 帧数:', pendingFramesAtAbortTime)
  console.log('  UI 最终显示的内容        :', JSON.stringify(displayed))
  console.log('  真正落库的内容           :', JSON.stringify(persisted))
  console.log('  丢失                     :', JSON.stringify(displayed.replace(persisted, '')))

  assert.equal(storeAtAbortTime, '', 'abort 时 store 里应当还没有内容')
  assert.equal(pendingFramesAtAbortTime, 1, '同帧 3 个分片应当只调度 1 次 rAF')
  assert.equal(displayed, '第一段回答。第二段回答。第三段回答。', 'UI 最终会显示全部内容')
  assert.equal(persisted, '', '落库内容为空 —— 缺口复现成功')

  return { displayed, persisted }
}

// ===========================================================================
// 场景 2：修复方案
// ===========================================================================
function case2_fix(): void {
  const raf = installManualRaf()
  const store = createFakeStore([
    { id: 'm1', role: 'user', content: '你好' },
    { id: 'm2', role: 'assistant', content: '' },
  ])

  const answerBuffer = new StreamBuffer({
    onFlush: (content) => store.appendContent('m2', content),
    scheduleRaf: raf.scheduleRaf,
    cancelRaf: raf.cancelRaf,
  })

  answerBuffer.append('第一段回答。')
  answerBuffer.append('第二段回答。')
  answerBuffer.append('第三段回答。')

  // ---- 修复：Stop 时先把所有 buffer 同步刷进 store，再读 content 组请求体 ----
  answerBuffer.forceFlush()

  const sentBody = { content: store.messages[1].content || '' }

  console.log('\n=== 场景 2：修复（abort 前先 forceFlush） ===')
  console.log('  待处理 rAF 帧数  :', raf.pendingCount)
  console.log('  UI 最终显示的内容:', JSON.stringify(store.messages[1].content))
  console.log('  真正落库的内容   :', JSON.stringify(sentBody.content))

  assert.equal(raf.pendingCount, 0, 'forceFlush 应当取消待处理帧')
  assert.equal(sentBody.content, store.messages[1].content, 'UI 与落库必须一致')
}

// ===========================================================================
// 场景 3：对照 —— 跨帧分片本就已 flush，说明缺口只发生在"最后一帧"
// ===========================================================================
function case3_control(): void {
  const raf = installManualRaf()
  const store = createFakeStore([{ id: 'm2', role: 'assistant', content: '' }])
  const answerBuffer = new StreamBuffer({
    onFlush: (content) => store.appendContent('m2', content),
    scheduleRaf: raf.scheduleRaf,
    cancelRaf: raf.cancelRaf,
  })

  answerBuffer.append('第一帧内容。')
  raf.flushFrame() // 第一帧正常渲染
  answerBuffer.append('第二帧内容，未 flush。')

  const sentBody = { content: store.messages[0].content }

  console.log('\n=== 场景 3：对照（跨帧） ===')
  console.log('  已 flush 的部分  :', JSON.stringify(sentBody.content))
  console.log('  只丢最后一帧的量 :', JSON.stringify('第二帧内容，未 flush。'))

  assert.equal(sentBody.content, '第一帧内容。')
}

// ===========================================================================
// 附加验证：StreamBuffer 的 rAF 幂等性（对应简历的"合并渲染"卖点）
// ===========================================================================
function case4_rafIdempotent(): void {
  const raf = installManualRaf()
  const flushed: string[] = []
  const buf = new StreamBuffer({
    onFlush: (c) => flushed.push(c),
    scheduleRaf: raf.scheduleRaf,
    cancelRaf: raf.cancelRaf,
  })

  // 模拟 100 个 SSE 分片在同一帧内到达
  for (let i = 0; i < 100; i++) buf.append(`c${i}`)

  console.log('\n=== 场景 4：同帧 100 个分片 ===')
  console.log('  调度了几次 rAF :', raf.pendingCount)
  console.log('  flush 了几次   :', flushed.length, '(flushFrame 之前)')

  assert.equal(raf.pendingCount, 1, '100 个分片只应调度 1 次 rAF')
  assert.equal(flushed.length, 0, 'flushFrame 之前不应有任何 flush')

  raf.flushFrame()

  console.log('  flushFrame 后 flush 次数:', flushed.length)
  console.log('  单次 flush 的内容长度   :', flushed[0].length)

  assert.equal(flushed.length, 1, '100 个分片合并为 1 次 store 写入')
  assert.equal(flushed[0], Array.from({ length: 100 }, (_, i) => `c${i}`).join(''))
}

// ===========================================================================
console.log('='.repeat(64))
console.log('Stop 生成：rAF 缓冲与 save-partial 的时序缺口验证')
console.log('='.repeat(64))

case1_reproduce()
case2_fix()
case3_control()
case4_rafIdempotent()

console.log('\n' + '='.repeat(64))
console.log('全部断言通过 ✅')
console.log('='.repeat(64) + '\n')

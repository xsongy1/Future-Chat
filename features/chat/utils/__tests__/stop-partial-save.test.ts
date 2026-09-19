/**
 * 回归测试：用户点 Stop 时，rAF 缓冲里"尚未 flush"的内容会不会落库？
 *
 * 背景（真实实现）：
 * - features/chat/utils/stream-buffer.ts 的 StreamBuffer 用 requestAnimationFrame 批量刷新，
 *   所以任意时刻 buffer 里都可能压着"最长一帧"的未 flush 内容。
 * - features/chat/services/chat.service.ts 的 abortStream() 曾在同步块里直接读 store 组
 *   save-partial 请求体，而 buffer 的 forceFlush() 要到之后的微任务（AbortError → finishStream）
 *   才发生 —— 于是"最后一帧"只显示在 UI、不进数据库，刷新后消失。
 *
 * 现在 abortStream() 会先调用 store.activeStreamHandler.flushBuffers() 再读 content。
 * 本文件直接测这个顺序：只 mock store 与埋点，StreamBuffer / ChatService.abortStream
 * 用的是真实实现，关键行为没有被 mock 掉。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// store / 埋点 mock（必须在 import ChatService 之前声明）
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  interface FakeTool {
    toolCallId: string
    state: string
  }
  interface FakeMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    thinking?: string
    toolInvocations?: FakeTool[]
  }

  const messages: FakeMessage[] = [
    { id: 'm1', role: 'user', content: '你好' },
    { id: 'm2', role: 'assistant', content: '' },
  ]

  const state = {
    messages,
    streamingMessageId: 'm2' as string | null,
    streamAbortController: null as AbortController | null,
    abortControllerAborted: false,
    activeStreamHandler: null as { flushBuffers: () => void } | null,
    updateMessage: vi.fn(),
    cancelTool: vi.fn(),
    setStreamAbortController: vi.fn(),
    setActiveStreamHandler: vi.fn(),
  }

  const fetchMock = vi.fn()

  return { state, messages, fetchMock }
})

vi.mock('@/features/chat/store/chat.store', () => ({
  useChatStore: {
    getState: () => h.state,
    subscribe: () => () => {},
  },
}))

vi.mock('@/lib/monitor/trace-helper', () => ({
  startTrace: vi.fn(),
  endTrace: vi.fn(),
  getCurrentTraceId: () => null,
  getLastTraceId: () => null,
  markRequestStart: vi.fn(),
  markFirstByte: vi.fn(),
  classifyStreamError: () => 'unknown',
}))

vi.mock('@/lib/monitor', () => ({ getMonitor: () => null }))
vi.mock('@/lib/monitor/user-actions', () => ({ trackUserAction: vi.fn() }))

import { ChatService } from '@/features/chat/services/chat.service'
import { StreamBuffer } from '@/features/chat/utils/stream-buffer'

/**
 * 把 rAF 变成"手动可控"：不自动执行，必须显式调用 flushFrame()
 *
 * 注意：必须同时给 globalThis.window 打个桩。
 * StreamBuffer 在构造时用 `typeof window === 'undefined'` 判断 SSR，
 * node 测试环境里 window 不存在 → 它会走"直接 flush"分支，rAF 缓冲完全不生效，
 * 这样测的就不是真实浏览器行为（这也正是原 spec 文件里被掩盖的问题）。
 */
function installManualRaf() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextId = 1

  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++
    pending.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pending.delete(id)
  })

  return {
    flushFrame() {
      const cbs = [...pending.values()]
      pending.clear()
      cbs.forEach((cb) => cb(performance.now()))
    },
    get pendingCount() {
      return pending.size
    },
  }
}

/** 取出 save-partial 请求体 */
function lastSavePartialBody(): { content: string; thinking: string } {
  const call = h.fetchMock.mock.calls.find(
    (c) => typeof c[0] === 'string' && String(c[0]).includes('/save-partial')
  )
  if (!call) throw new Error('未发出 save-partial 请求')
  const init = call[1] as RequestInit
  return JSON.parse(String(init.body))
}

describe('Stop 生成：rAF 缓冲与 save-partial 的时序', () => {
  beforeEach(() => {
    h.fetchMock.mockReset()
    h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    vi.stubGlobal('fetch', h.fetchMock)

    const controller = new AbortController()
    // 逐用例重置消息内容，避免上一个用例 flush 进去的内容泄漏到下一个用例
    h.state.messages[1] = { id: 'm2', role: 'assistant', content: '', thinking: '' }
    h.state.streamingMessageId = 'm2'
    h.state.streamAbortController = controller
    h.state.abortControllerAborted = false
    h.state.activeStreamHandler = null
    h.state.updateMessage.mockClear()
    h.state.cancelTool.mockClear()
    h.state.setStreamAbortController.mockClear()
    h.state.setActiveStreamHandler.mockClear()
    controller.signal.addEventListener('abort', () => {
      h.state.abortControllerAborted = true
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('修复后：Stop 时先同步 flush 缓冲，最后一帧也进 save-partial 请求体（UI 与落库一致）', () => {
    const raf = installManualRaf()

    // 真实写入路径：StreamHandler 的 answerBuffer 就是这么写 store 的
    const answerBuffer = new StreamBuffer({
      onFlush: (content) => {
        h.state.messages[1].content += content
      },
    })

    // 同一帧内到达 3 个 SSE 分片 → rAF 只被调度一次，内容全压在 buffer 里
    answerBuffer.append('第一段回答。')
    answerBuffer.append('第二段回答。')
    answerBuffer.append('第三段回答。')
    expect(h.state.messages[1].content).toBe('')
    expect(raf.pendingCount).toBe(1) // 同帧分片已被合并

    // 登记"在飞的 handler"（真实代码里由 sendMessage 在 run() 之前登记）
    h.state.activeStreamHandler = { flushBuffers: () => answerBuffer.forceFlush() }

    // ---- 用户点击 Stop ----
    ChatService.abortStream()

    // 结论 1：请求体里包含缓冲中的全部内容（缺口已修）
    expect(lastSavePartialBody().content).toBe('第一段回答。第二段回答。第三段回答。')
    // 结论 2：UI 显示的内容与落库内容一致
    expect(lastSavePartialBody().content).toBe(h.state.messages[1].content)
    // 结论 3：待处理帧已被 flush 清掉
    expect(raf.pendingCount).toBe(0)
  })

  it('回归对照：没登记 handler（旧实现路径）时最后一帧会丢 —— 证明上面的断言确实有效', () => {
    const raf = installManualRaf()

    const answerBuffer = new StreamBuffer({
      onFlush: (content) => {
        h.state.messages[1].content += content
      },
    })
    answerBuffer.append('第一段回答。')
    answerBuffer.append('第二段回答。')
    answerBuffer.append('第三段回答。')

    // 旧行为：abortStream 不 flush，直接读 store（等价于 activeStreamHandler 为空）
    h.state.activeStreamHandler = null
    ChatService.abortStream()

    // 落库为空 —— 正是被修掉的那个缺口
    expect(lastSavePartialBody().content).toBe('')
    // 但 UI 最终仍会显示（finishStream 里的 forceFlush），所以表现为"刷新后少一段"
    expect(raf.pendingCount).toBe(1)
    answerBuffer.forceFlush()
    expect(h.state.messages[1].content).toBe('第一段回答。第二段回答。第三段回答。')
  })

  it('对照：跨帧到达的分片本就已 flush，说明缺口只发生在"最后一帧"', () => {
    const raf = installManualRaf()

    const answerBuffer = new StreamBuffer({
      onFlush: (content) => {
        h.state.messages[1].content += content
      },
    })

    answerBuffer.append('第一帧内容。')
    raf.flushFrame() // 第一帧正常渲染
    expect(h.state.messages[1].content).toBe('第一帧内容。')

    answerBuffer.append('第二帧内容，未 flush。')
    expect(h.state.messages[1].content).toBe('第一帧内容。') // 只差"最后一帧"的量
  })

  it('abort 仍然会中断请求并取消在跑的工具（修复没有破坏原有语义）', () => {
    installManualRaf()

    h.state.messages[1].toolInvocations = [
      { toolCallId: 't1', state: 'running' },
      { toolCallId: 't2', state: 'completed' },
    ]

    ChatService.abortStream()

    expect(h.state.abortControllerAborted).toBe(true)
    expect(h.state.setStreamAbortController).toHaveBeenCalledWith(null)
    // 只取消 running 的那个
    expect(h.state.cancelTool).toHaveBeenCalledWith('m2', 't1')
    expect(h.state.cancelTool).not.toHaveBeenCalledWith('m2', 't2')
    // 消息回到 idle（阶段由 selectors 从消息数据派生）
    expect(h.state.updateMessage).toHaveBeenCalledWith('m2', { displayState: 'idle' })
  })
})

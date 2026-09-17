/**
 * 验证：用户点 Stop 时，rAF 缓冲里"尚未 flush"的内容会不会落库？
 *
 * 背景（真实实现）：
 * - features/chat/utils/stream-buffer.ts 的 StreamBuffer 用 requestAnimationFrame 批量刷新，
 *   所以任意时刻 buffer 里都可能压着"最长一帧"的未 flush 内容。
 * - features/chat/services/chat.service.ts 的 abortStream() 在同步块里：
 *     ① streamAbortController.abort()
 *     ② 读 store 里当前 content → fetch('/api/message/{id}/save-partial')
 *   而 Buffer 的 forceFlush() 发生在之后的微任务里（由 AbortError 触发 finishStream）。
 *
 * 本文件用一个最小的 store / 消息模型复现这个时序，不 mock 掉任何关键行为。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { StreamBuffer } from '@/features/chat/utils/stream-buffer'

// ---------------------------------------------------------------------------
// 最小 store，只保留与"保存部分内容"有关的部分
// ---------------------------------------------------------------------------
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
      messages = messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m
      )
    },
    appendThinking(id: string, chunk: string) {
      messages = messages.map((m) =>
        m.id === id ? { ...m, thinking: (m.thinking || '') + chunk } : m
      )
    },
  }
}

describe('Stop 生成：rAF 缓冲与 save-partial 的时序缺口', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /**
   * 把 rAF 变成"手动可控"：不自动执行，必须显式调用 flushFrame()。
   * 这模拟真实浏览器：rAF 回调一定在本轮同步代码 + 微任务之后才执行。
   */
  function installManualRaf() {
    const pending: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      pending.push(cb)
      return pending.length
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.splice(id - 1, 1)
    })
    return {
      flushFrame() {
        const cbs = pending.splice(0)
        cbs.forEach((cb) => cb(performance.now()))
      },
      get pendingCount() {
        return pending.length
      },
    }
  }

  it('复现问题：Stop 时缓冲区未 flush 的内容会落库丢失（当前实现的真实行为）', () => {
    const raf = installManualRaf()

    const store = createFakeStore([
      { id: 'm1', role: 'user', content: '你好' },
      { id: 'm2', role: 'assistant', content: '' },
    ])

    // ---- 真实写入路径：StreamHandler 的 answerBuffer ----
    const answerBuffer = new StreamBuffer({
      onFlush: (content) => store.appendContent('m2', content),
    })

    // SSE 到达 3 个 answer 分片（同一帧内，所以 rAF 只被调度一次）
    answerBuffer.append('第一段回答。')
    answerBuffer.append('第二段回答。')
    answerBuffer.append('第三段回答。')

    // 此刻：内容全在 buffer 里，store 的 content 仍是空
    expect(store.messages[1].content).toBe('')
    expect(raf.pendingCount).toBe(1) // 只有一次待处理帧 → 同帧分片已被合并

    // ---- 用户此刻点击 Stop：abortStream() 的同步块 ----
    // 真实代码：fetch('/api/message/m2/save-partial', { body: JSON.stringify({
    //   content: msg.content || '' ... }) })
    const sentBody = {
      content: store.messages[1].content || '',
      thinking: store.messages[1].thinking || '',
    }

    // ---- 之后 rAF 才执行，finishStream() 里 forceFlush ----
    answerBuffer.forceFlush()

    // 结论 1：内容最终【会】显示在 UI 上
    expect(store.messages[1].content).toBe('第一段回答。第二段回答。第三段回答。')
    // 结论 2：但【不会】进 save-partial 的请求体 → 刷新页面后消失
    expect(sentBody.content).toBe('')

    console.log('  [复现] 实际显示的内容 :', store.messages[1].content)
    console.log('  [复现] 实际落库的内容 :', JSON.stringify(sentBody.content))
  })

  it('修复方案：abortStream 中先同步 forceFlush 再组请求体，缺口消失', () => {
    const raf = installManualRaf()

    const store = createFakeStore([
      { id: 'm1', role: 'user', content: '你好' },
      { id: 'm2', role: 'assistant', content: '' },
    ])

    const answerBuffer = new StreamBuffer({
      onFlush: (content) => store.appendContent('m2', content),
    })

    answerBuffer.append('第一段回答。')
    answerBuffer.append('第二段回答。')
    answerBuffer.append('第三段回答。')

    // ---- 修复：Stop 时先把所有 buffer 同步刷进 store，再读 content ----
    answerBuffer.forceFlush() // thinkingBuffer.forceFlush() 同理

    const sentBody = {
      content: store.messages[1].content || '',
      thinking: store.messages[1].thinking || '',
    }

    expect(raf.pendingCount).toBe(0) // 待处理帧已被 cancelAnimationFrame 清掉
    expect(sentBody.content).toBe('第一段回答。第二段回答。第三段回答。')
    expect(sentBody.content).toBe(store.messages[1].content) // UI 与落库一致
  })

  it('对照：跨帧到达的分片本就已 flush，说明缺口只发生在"最后一帧"', () => {
    const raf = installManualRaf()

    const store = createFakeStore([{ id: 'm2', role: 'assistant', content: '' }])
    const answerBuffer = new StreamBuffer({
      onFlush: (content) => store.appendContent('m2', content),
    })

    answerBuffer.append('第一帧内容。')
    raf.flushFrame() // 第一帧正常渲染
    expect(store.messages[1].content).toBe('第一帧内容。')

    answerBuffer.append('第二帧内容，未 flush。')

    const sentBody = { content: store.messages[1].content }
    expect(sentBody.content).toBe('第一帧内容。') // 只丢"最后一帧"的量
  })
})

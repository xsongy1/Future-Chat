/**
 * Trace 单测：SSE 生命周期 / TTFB/TTLB / 阶段 / 工具调用 / 卡顿检测 / 幂等
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Trace } from '../src/core/trace'

/** 收集 Trace 发出的事件 */
function createTraceWithCollector(options: {
  aiMessageId: string
  stallThreshold?: number
  model?: string
  provider?: string
}) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const trace = new Trace(options, (type, data) => {
    events.push({ type, data })
  })
  return { trace, events }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-17T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Trace 生命周期', () => {
  it('完整生命周期发出标准事件序列并携带 traceId/aiMessageId', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.firstChunk()
    trace.phaseStart('thinking')
    trace.phaseEnd('thinking')
    trace.complete()

    expect(events.map((e) => e.type)).toEqual([
      'sse_start',
      'sse_first_chunk',
      'phase_start',
      'phase_end',
      'sse_complete',
    ])
    for (const e of events) {
      expect(e.data.traceId).toBe(trace.traceId)
    }
    expect(events[0].data.aiMessageId).toBe('msg_1')
  })

  it('firstChunk 计算 TTFB，complete 计算 TTLB', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    vi.advanceTimersByTime(500)
    trace.firstChunk()
    vi.advanceTimersByTime(1500)
    trace.complete()

    expect(events[1].data.ttfb).toBe(500)
    expect(events[2].data.ttlb).toBe(2000)
  })

  it('complete/error/abort 幂等：只会发一次结束事件', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.complete()
    trace.complete()
    trace.error('oops')
    trace.abort()

    const endTypes = events.filter((e) =>
      ['sse_complete', 'sse_error', 'sse_abort'].includes(e.type)
    )
    expect(endTypes).toHaveLength(1)
    expect(endTypes[0].type).toBe('sse_complete')
  })

  it('error/abort 携带原因与耗时', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    vi.advanceTimersByTime(300)
    trace.error('模型超时')

    expect(events[1].type).toBe('sse_error')
    expect(events[1].data.message).toBe('模型超时')
    expect(events[1].data.duration).toBe(300)

    trace.abort('user_cancel')
    expect(events).toHaveLength(2) // abort 被幂等拦截
  })

  it('阶段与工具调用事件携带完整载荷', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.phaseStart('answer')
    trace.toolStart('web_search', { query: 'AI' }, 'tool_123')
    trace.toolEnd('web_search', { toolCallId: 'tool_123', success: true, resultCount: 5 })
    trace.phaseEnd('answer')

    const toolStart = events.find((e) => e.type === 'tool_start')!
    expect(toolStart.data.name).toBe('web_search')
    expect(toolStart.data.toolCallId).toBe('tool_123')
    expect(toolStart.data.args).toEqual({ query: 'AI' })

    const toolEnd = events.find((e) => e.type === 'tool_end')!
    expect(toolEnd.data.success).toBe(true)
    expect(toolEnd.data.resultCount).toBe(5)
  })
})

describe('Trace 卡顿检测', () => {
  it('chunk 间隔超过阈值触发 sse_stall，恢复后触发 sse_resume', () => {
    const { trace, events } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      stallThreshold: 3000,
    })

    trace.start()
    trace.firstChunk() // t=0

    vi.advanceTimersByTime(1000)
    trace.recordChunk() // 正常间隔
    expect(events.some((e) => e.type === 'sse_stall')).toBe(false)

    vi.advanceTimersByTime(4000)
    trace.recordChunk() // 超过阈值 → stall

    const stall = events.find((e) => e.type === 'sse_stall')!
    expect(stall).toBeDefined()
    expect(stall.data.stallDuration).toBe(4000)

    vi.advanceTimersByTime(500)
    trace.recordChunk() // 恢复

    const resume = events.find((e) => e.type === 'sse_resume')!
    expect(resume).toBeDefined()
    expect(resume.data.stallDuration).toBe(500)
  })

  it('阈值可配置，默认 3000ms', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1' })
    expect(trace.stallThreshold).toBe(3000)

    const custom = createTraceWithCollector({ aiMessageId: 'msg_1', stallThreshold: 1500 })
    expect(custom.trace.stallThreshold).toBe(1500)
  })
})

describe('Trace 状态', () => {
  it('getState 反映生命周期状态', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    expect(trace.getState()).toBe('active')
    trace.complete()
    expect(trace.getState()).toBe('completed')
  })
})

describe('Trace 结构化错误', () => {
  it('error 接受结构化对象，sse_error 携带 errorCode/statusCode/retryable', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.error({
      code: 'RATE_LIMIT',
      message: '请求频率超限',
      statusCode: 429,
      retryable: true,
    })

    const errorEvent = events.find((e) => e.type === 'sse_error')!
    expect(errorEvent.data).toMatchObject({
      errorCode: 'RATE_LIMIT',
      message: '请求频率超限',
      statusCode: 429,
      retryable: true,
    })
  })

  it('未提供 errorCode 时按 statusCode 自动分类（429→RATE_LIMIT，5xx→PROVIDER_ERROR）', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.error({ message: 'upstream down', statusCode: 503 })
    expect(events.find((e) => e.type === 'sse_error')!.data.errorCode).toBe('PROVIDER_ERROR')

    trace.abort() // 幂等拦截，不影响
    const rateLimited = createTraceWithCollector({ aiMessageId: 'msg_2' })
    rateLimited.trace.start()
    rateLimited.trace.error({ message: 'too many', statusCode: 429 })
    expect(rateLimited.events.find((e) => e.type === 'sse_error')!.data.errorCode).toBe('RATE_LIMIT')
  })

  it('error 兼容字符串形态（旧调用不破坏）', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.error('模型超时')

    const errorEvent = events.find((e) => e.type === 'sse_error')!
    expect(errorEvent.data.message).toBe('模型超时')
    expect(errorEvent.data.errorCode).toBe('STREAM_ERROR')
  })
})

describe('Trace model / provider / 用量', () => {
  it('sse_start 携带 model 与 provider', () => {
    const { trace, events } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      model: 'deepseek-ai/DeepSeek-V3.2',
      provider: 'siliconflow',
    })

    trace.start()

    expect(events[0].data).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V3.2',
      provider: 'siliconflow',
    })
    expect(trace.model).toBe('deepseek-ai/DeepSeek-V3.2')
  })

  it('setUsage 发出 sse_usage：token 明细 + 估算成本 + tokensPerSec', () => {
    const { trace, events } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      model: 'deepseek-ai/DeepSeek-V3.2',
    })

    trace.start()
    vi.advanceTimersByTime(1000) // 已耗时 1s
    trace.setUsage({ inputTokens: 1000, outputTokens: 2000 })

    const usageEvent = events.find((e) => e.type === 'sse_usage')!
    expect(usageEvent.data).toMatchObject({
      inputTokens: 1000,
      outputTokens: 2000,
      totalTokens: 3000,
      model: 'deepseek-ai/DeepSeek-V3.2',
      // 1000/1M*0.27 + 2000/1M*1.1 = 0.00027 + 0.0022 = 0.00247
      estimatedCost: 0.00247,
      currency: 'USD',
      tokensPerSec: 3000,
    })
  })

  it('setUsage 的 model 缺省用 Trace 的 model', () => {
    const { trace, events } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      model: 'deepseek-ai/DeepSeek-V3',
    })

    trace.start()
    trace.setUsage({ inputTokens: 100, outputTokens: 100 })

    expect(events.find((e) => e.type === 'sse_usage')!.data.model).toBe('deepseek-ai/DeepSeek-V3')
  })

  it('setUsage 未知模型时 estimatedCost 为 null（不硬造数字）', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.setUsage({ inputTokens: 100, outputTokens: 100 })

    const usageEvent = events.find((e) => e.type === 'sse_usage')!
    expect(usageEvent.data.estimatedCost).toBeNull()
    expect(usageEvent.data.totalTokens).toBe(200)
  })

  it('complete 携带 chunksPerSec 吞吐指标', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    for (let i = 0; i < 10; i += 1) trace.recordChunk()
    vi.advanceTimersByTime(2000)
    trace.complete()

    expect(events.find((e) => e.type === 'sse_complete')!.data.chunksPerSec).toBe(5)
  })
})

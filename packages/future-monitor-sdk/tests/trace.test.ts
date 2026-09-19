/**
 * Trace 单测：SSE 生命周期 / 延迟指标口径（TTFB·FCL·TTFT·TTFA·TTLB）/ 阶段 / 工具 /
 * 卡顿检测 / 幂等 / Resource Timing 校准
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Trace } from '../src/core/trace'
import { Monitor } from '../src/core/monitor'
import { DebugPlugin } from '../src/plugins/debug'
import type { ResourceTimingSample } from '../src/core/timing'
import { readResourceTtfb, resourcePath } from '../src/core/timing'

/** 收集 Trace 发出的事件 */
function createTraceWithCollector(options: {
  aiMessageId: string
  stallThreshold?: number
  model?: string
  provider?: string
  resourceEntries?: () => ResourceTimingSample[]
}) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const trace = new Trace(options, (type, data) => {
    events.push({ type, data })
  })
  return { trace, events }
}

/** 取某类事件的载荷（不存在则抛错，避免断言静默通过） */
function payloadOf(
  events: Array<{ type: string; data: Record<string, unknown> }>,
  type: string
): Record<string, unknown> {
  const event = events.find((e) => e.type === type)
  if (!event) throw new Error(`event not found: ${type}`)
  return event.data
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

    trace.markRequestStart({ url: '/api/chat' })
    trace.start()
    trace.firstByte()
    trace.firstChunk()
    trace.firstToken('thinking')
    trace.phaseStart('thinking')
    trace.phaseEnd('thinking')
    trace.complete()

    expect(events.map((e) => e.type)).toEqual([
      'sse_start',
      'sse_first_byte',
      'sse_first_chunk',
      'sse_first_token',
      'phase_start',
      'phase_end',
      'sse_complete',
    ])
    for (const e of events) {
      expect(e.data.traceId).toBe(trace.traceId)
    }
    expect(events[0].data.aiMessageId).toBe('msg_1')
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

/**
 * 延迟指标口径：三者的区别是本套测试的核心
 * - TTFB = 首字节（响应头到达），不含模型生成时间
 * - First Chunk Latency = 首个响应体数据块
 * - TTFT = 首个模型 token（首个带内容增量）
 */
describe('Trace 延迟指标', () => {
  it('TTFB / First Chunk Latency / TTFT / TTFA / TTLB 各按自己的事件时刻计算', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' }) // T0 = 请求发出

    vi.advanceTimersByTime(120)
    trace.firstByte() // 响应头到达 → TTFB = 120

    vi.advanceTimersByTime(30)
    trace.rawChunk(64) // 首个数据块 → FCL = 150

    vi.advanceTimersByTime(400)
    trace.firstToken('thinking') // 首个 token（思考） → TTFT = 550

    vi.advanceTimersByTime(1000)
    trace.firstToken('answer') // 首个 answer token → TTFA = 1550

    vi.advanceTimersByTime(1650)
    trace.complete() // 流关闭 → TTLB = 3200

    // 各自的事件载荷
    expect(payloadOf(events, 'sse_first_byte')).toMatchObject({
      ttfb: 120,
      source: 'fetch-headers',
    })
    expect(payloadOf(events, 'sse_first_chunk')).toMatchObject({ firstChunkLatency: 150 })
    expect(payloadOf(events, 'sse_first_token')).toMatchObject({ ttft: 550, phase: 'thinking' })

    // 结束事件打包全部指标（口径一致，可直接对比）
    expect(payloadOf(events, 'sse_complete')).toMatchObject({
      ttfb: 120,
      ttfbSource: 'fetch-headers',
      firstChunkLatency: 150,
      ttft: 550,
      ttftPhase: 'thinking',
      ttfa: 1550,
      ttlb: 3200,
      duration: 3200,
      rawChunkCount: 1,
      bytesReceived: 64,
    })

    expect(trace.getMetrics()).toMatchObject({
      ttfb: 120,
      firstChunkLatency: 150,
      ttft: 550,
      ttftPhase: 'thinking',
      ttfa: 1550,
      ttlb: 3200,
      rawChunkCount: 1,
      bytesReceived: 64,
    })
  })

  it('恒等关系：0 ≤ TTFB ≤ First Chunk Latency ≤ TTFT ≤ TTLB', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(80)
    trace.firstByte()
    vi.advanceTimersByTime(20)
    trace.rawChunk(32)
    vi.advanceTimersByTime(300)
    trace.firstToken('answer')
    vi.advanceTimersByTime(700)
    trace.complete()

    const m = trace.getMetrics()
    expect(m.ttfb).not.toBeNull()
    expect(m.ttfb!).toBeLessThanOrEqual(m.firstChunkLatency!)
    expect(m.firstChunkLatency!).toBeLessThanOrEqual(m.ttft!)
    expect(m.ttft!).toBeLessThanOrEqual(m.ttlb!)
    expect(m.ttfb!).toBeGreaterThanOrEqual(0)
  })

  it('恒等关系在任意时间线下都成立（200 组随机时间线）', () => {
    for (let i = 0; i < 200; i += 1) {
      const { trace } = createTraceWithCollector({ aiMessageId: `msg_${i}` })
      const step = () => vi.advanceTimersByTime(Math.round(Math.random() * 2000))

      trace.start()
      trace.markRequestStart({ url: '/api/chat' })
      step()
      trace.firstByte()
      step()
      trace.rawChunk(16)
      step()
      trace.firstToken(Math.random() > 0.5 ? 'thinking' : 'answer')
      step()
      trace.complete()

      const m = trace.getMetrics()
      expect(m.ttfb).toBeGreaterThanOrEqual(0)
      expect(m.ttfb!).toBeLessThanOrEqual(m.firstChunkLatency!)
      expect(m.firstChunkLatency!).toBeLessThanOrEqual(m.ttft!)
      expect(m.ttft!).toBeLessThanOrEqual(m.ttlb!)
    }
  })

  it('未标记请求发出时刻时，基准退回 Trace 构造时刻', () => {
    const createdAt = performance.now()
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    expect(trace.getRequestStartTime()).toBe(createdAt)

    trace.start()
    vi.advanceTimersByTime(200)
    trace.firstByte()

    expect(payloadOf(events, 'sse_first_byte').ttfb).toBe(200)
  })

  it('T0 只认第一次标记：重复标记不会让已算出的 TTFB 变小', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(100)
    trace.markRequestStart({ url: '/api/chat' }) // 无效：重试应该新建 Trace
    vi.advanceTimersByTime(100)
    trace.firstByte()

    expect(payloadOf(events, 'sse_first_byte').ttfb).toBe(200)
  })

  it('firstByte / firstChunk / firstToken 幂等：不重复发事件、不覆盖首次值', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })

    vi.advanceTimersByTime(100)
    trace.firstByte()
    vi.advanceTimersByTime(50)
    trace.firstByte() // 重复：忽略

    vi.advanceTimersByTime(50)
    trace.rawChunk(10)
    vi.advanceTimersByTime(50)
    trace.rawChunk(20) // 第二个数据块：只计数，不改 FCL

    vi.advanceTimersByTime(50)
    trace.firstToken('thinking')
    vi.advanceTimersByTime(50)
    trace.firstToken('answer') // TTFT 不变，但 TTFA 记录

    expect(events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'sse_first_chunk')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'sse_first_token')).toHaveLength(1)

    expect(trace.getMetrics()).toMatchObject({
      ttfb: 100,
      firstChunkLatency: 200,
      ttft: 300,
      ttftPhase: 'thinking',
      ttfa: 350,
      rawChunkCount: 2,
      bytesReceived: 30,
    })
  })

  it('TTFA 只认第一个 answer token（重复 answer 增量不覆盖）', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(500)
    trace.firstToken('answer')
    vi.advanceTimersByTime(500)
    trace.firstToken('answer')

    expect(trace.getMetrics().ttfa).toBe(500)
    expect(trace.getMetrics().ttft).toBe(500)
  })

  it('首个数据块就带 token 时：FCL 与 TTFT 可以相等，但都不会小于 TTFB', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(100)
    trace.firstByte()
    vi.advanceTimersByTime(50)
    trace.rawChunk(128) // 同一数据块里既有数据块到达也有 token
    trace.firstToken('answer')

    const m = trace.getMetrics()
    expect(m.ttfb).toBe(100)
    expect(m.firstChunkLatency).toBe(150)
    expect(m.ttft).toBe(150)
  })

  it('出错时也带上指标快照：可以区分"首字前失败"和"流中途失败"', () => {
    const beforeToken = createTraceWithCollector({ aiMessageId: 'msg_a' })
    beforeToken.trace.start()
    beforeToken.trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(200)
    beforeToken.trace.error({ message: 'upstream down', statusCode: 503 })

    expect(payloadOf(beforeToken.events, 'sse_error')).toMatchObject({
      ttfb: null,
      firstChunkLatency: null,
      ttft: null,
      duration: 200,
    })

    const midStream = createTraceWithCollector({ aiMessageId: 'msg_b' })
    midStream.trace.start()
    midStream.trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(120)
    midStream.trace.firstByte()
    vi.advanceTimersByTime(80)
    midStream.trace.rawChunk(64)
    vi.advanceTimersByTime(600)
    midStream.trace.error('stream broke')

    expect(payloadOf(midStream.events, 'sse_error')).toMatchObject({
      ttfb: 120,
      firstChunkLatency: 200,
      ttft: null,
      duration: 800,
    })
  })
})

describe('Trace TTFB 的 Resource Timing 校准', () => {
  const CHAT_URL = 'http://localhost/api/chat'

  it('用网络层 responseStart 校准，并把来源标成 resource-timing', () => {
    let entryStart = 0
    const { trace, events } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      resourceEntries: () => [
        { name: CHAT_URL, startTime: entryStart, responseStart: entryStart + 90 },
      ],
    })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    entryStart = trace.getRequestStartTime()

    vi.advanceTimersByTime(120)
    trace.firstByte() // 主线程观测到响应头：120ms

    vi.advanceTimersByTime(1000)
    trace.complete()

    // 网络层首字节 90ms 更接近真实值，且不晚于主线程观测值
    expect(payloadOf(events, 'sse_first_byte').ttfb).toBe(120) // 事件已发出，保持原值
    expect(payloadOf(events, 'sse_complete')).toMatchObject({
      ttfb: 90,
      ttfbSource: 'resource-timing',
    })
    expect(trace.getMetrics()).toMatchObject({ ttfb: 90, ttfbSource: 'resource-timing' })
  })

  it('读数不合理时保留主线程观测值（防止匹配到别的请求）', () => {
    let entryStart = 0
    const { trace } = createTraceWithCollector({
      aiMessageId: 'msg_1',
      resourceEntries: () => [
        // 网络层首字节居然比主线程观测到的响应头晚 300ms → 判定为别的请求
        { name: CHAT_URL, startTime: entryStart, responseStart: entryStart + 420 },
      ],
    })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    entryStart = trace.getRequestStartTime()

    vi.advanceTimersByTime(120)
    trace.firstByte()
    vi.advanceTimersByTime(1000)
    trace.complete()

    expect(trace.getMetrics()).toMatchObject({ ttfb: 120, ttfbSource: 'fetch-headers' })
  })

  it('没有条目时保留主线程观测值', () => {
    const { trace } = createTraceWithCollector({ aiMessageId: 'msg_1', resourceEntries: () => [] })

    trace.start()
    trace.markRequestStart({ url: '/api/chat' })
    vi.advanceTimersByTime(120)
    trace.firstByte()
    vi.advanceTimersByTime(1000)
    trace.complete()

    expect(trace.getMetrics()).toMatchObject({ ttfb: 120, ttfbSource: 'fetch-headers' })
  })
})

describe('Resource Timing 读数', () => {
  const url = '/api/chat'

  it('按路径匹配，忽略跨域被屏蔽（responseStart=0）与更早的条目', () => {
    const entries: ResourceTimingSample[] = [
      { name: 'http://localhost/api/chat', startTime: 100, responseStart: 250 },
      { name: 'http://localhost/api/chat', startTime: 1000, responseStart: 0 }, // TAO 屏蔽
      { name: 'http://localhost/other', startTime: 1000, responseStart: 1100 },
      { name: 'http://localhost/api/chat?v=2', startTime: 2000, responseStart: 2180 },
    ]

    expect(readResourceTtfb(url, { source: () => entries })).toBe(180)
  })

  it('过滤掉早于本次请求 T0 的条目（同一 URL 的历史请求）', () => {
    const entries: ResourceTimingSample[] = [
      { name: 'http://localhost/api/chat', startTime: 100, responseStart: 900 }, // 上一次请求
      { name: 'http://localhost/api/chat', startTime: 2000, responseStart: 2150 },
    ]

    expect(readResourceTtfb(url, { requestStart: 1900, source: () => entries })).toBe(150)
  })

  it('取最近开始的一条（重试/多轮场景）', () => {
    const entries: ResourceTimingSample[] = [
      { name: 'http://localhost/api/chat', startTime: 100, responseStart: 300 },
      { name: 'http://localhost/api/chat', startTime: 500, responseStart: 620 },
    ]

    expect(readResourceTtfb(url, { source: () => entries })).toBe(120)
  })

  it('无 API / 空条目返回 null，而不是编造数字', () => {
    expect(readResourceTtfb(url, { source: () => [] })).toBeNull()
  })

  it('resourcePath 把相对路径与绝对地址对齐', () => {
    expect(resourcePath('/api/chat?v=1')).toBe('/api/chat')
    expect(resourcePath('http://localhost:3000/api/chat')).toBe('/api/chat')
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

describe('Trace 阶段收尾', () => {
  it('结束前自动关闭未闭合的阶段（phase_end 带 auto: true）', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.phaseStart('thinking')
    trace.phaseStart('answer')
    trace.abort('user_cancel') // 用户点停止：宿主没有机会再调 phaseEnd

    expect(events.map((e) => e.type)).toEqual([
      'sse_start',
      'phase_start',
      'phase_start',
      'phase_end',
      'phase_end',
      'sse_abort',
    ])
    const autoEnds = events.filter((e) => e.type === 'phase_end')
    expect(autoEnds.map((e) => e.data.phase)).toEqual(['thinking', 'answer'])
    expect(autoEnds.every((e) => e.data.auto === true)).toBe(true)
  })

  it('error / complete 同样会关闭未闭合阶段', () => {
    const onError = createTraceWithCollector({ aiMessageId: 'msg_err' })
    onError.trace.start()
    onError.trace.phaseStart('answer')
    onError.trace.error('stream broke')
    expect(onError.events.map((e) => e.type)).toEqual([
      'sse_start',
      'phase_start',
      'phase_end',
      'sse_error',
    ])

    const onComplete = createTraceWithCollector({ aiMessageId: 'msg_ok' })
    onComplete.trace.start()
    onComplete.trace.phaseStart('answer')
    onComplete.trace.complete()
    expect(onComplete.events.map((e) => e.type)).toEqual([
      'sse_start',
      'phase_start',
      'phase_end',
      'sse_complete',
    ])
  })

  it('宿主已正常收尾时不会重复关闭阶段', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.phaseStart('thinking')
    trace.phaseEnd('thinking')
    trace.complete()

    const phaseEnds = events.filter((e) => e.type === 'phase_end')
    expect(phaseEnds).toHaveLength(1)
    expect(phaseEnds[0].data.auto).toBeUndefined()
  })

  it('同一个阶段重复 phaseStart 也只补一次 phase_end', () => {
    const { trace, events } = createTraceWithCollector({ aiMessageId: 'msg_1' })

    trace.start()
    trace.phaseStart('answer')
    trace.phaseStart('answer')
    trace.complete()

    expect(events.filter((e) => e.type === 'phase_end')).toHaveLength(1)
  })
})

describe('Trace TTFB 的延迟补校', () => {
  function createRefinableTrace() {
    let entryStart = 0
    let entries: ResourceTimingSample[] = []
    const collector = createTraceWithCollector({
      aiMessageId: 'msg_1',
      resourceEntries: () => entries,
    })
    const { trace, events } = collector
    const url = 'http://localhost/api/chat'

    return {
      trace,
      events,
      /** 让 Resource Timing 从这一刻起"看得到"本次请求的条目（模拟浏览器写完缓冲区） */
      publishEntry: (ttfb: number) => {
        entries = [{ name: url, startTime: entryStart, responseStart: entryStart + ttfb }]
      },
      start: () => {
        trace.start()
        trace.markRequestStart({ url: '/api/chat' })
        entryStart = trace.getRequestStartTime()
      },
    }
  }

  it('同步读不到条目时补读一次，并补发 refined 事件（最终值以它为准）', () => {
    const { trace, events, publishEntry, start } = createRefinableTrace()

    start()
    vi.advanceTimersByTime(120)
    trace.firstByte() // 主线程观测值 120
    vi.advanceTimersByTime(1000)
    trace.complete() // 同步读：条目还没发布 → 保留 120

    expect(payloadOf(events, 'sse_complete')).toMatchObject({
      ttfb: 120,
      ttfbSource: 'fetch-headers',
    })
    expect(events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(1)

    // 响应体收完之后浏览器才把条目写进缓冲区
    publishEntry(90)
    vi.runAllTimers()

    const corrections = events.filter(
      (e) => e.type === 'sse_first_byte' && e.data.refined === true
    )
    expect(corrections).toHaveLength(1)
    expect(corrections[0].data).toMatchObject({
      ttfb: 90,
      source: 'resource-timing',
      refined: true,
    })
    expect(trace.getMetrics()).toMatchObject({ ttfb: 90, ttfbSource: 'resource-timing' })
  })

  it('同步已经校准成功就不再补发（避免同一指标出现两个值）', () => {
    const { trace, events, publishEntry, start } = createRefinableTrace()

    start()
    vi.advanceTimersByTime(120)
    trace.firstByte()
    publishEntry(90)
    vi.advanceTimersByTime(1000)
    trace.complete() // 同步读到条目 → 直接校准
    vi.runAllTimers()

    expect(payloadOf(events, 'sse_complete')).toMatchObject({
      ttfb: 90,
      ttfbSource: 'resource-timing',
    })
    expect(events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(1)
  })

  it('始终取不到条目时不补发、不改大 TTFB（不编造数字）', () => {
    const { trace, events, start } = createRefinableTrace()

    start()
    vi.advanceTimersByTime(120)
    trace.firstByte()
    vi.advanceTimersByTime(1000)
    trace.complete()
    vi.runAllTimers()

    expect(events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(1)
    expect(trace.getMetrics()).toMatchObject({ ttfb: 120, ttfbSource: 'fetch-headers' })
  })

  it('没有 URL / 没有首字节观测时不安排补校', () => {
    const noUrl = createTraceWithCollector({ aiMessageId: 'msg_a' })
    noUrl.trace.start()
    noUrl.trace.markRequestStart()
    vi.advanceTimersByTime(100)
    noUrl.trace.firstByte()
    noUrl.trace.complete()
    vi.runAllTimers()
    expect(noUrl.events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(1)

    const noFirstByte = createTraceWithCollector({ aiMessageId: 'msg_b' })
    noFirstByte.trace.start()
    noFirstByte.trace.markRequestStart({ url: '/api/chat' })
    noFirstByte.trace.complete()
    vi.runAllTimers()
    expect(noFirstByte.events.filter((e) => e.type === 'sse_first_byte')).toHaveLength(0)
  })

  it('补发的事件仍能按 traceId 归属（currentTrace 已清空时补齐 context.traceId）', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const debug = new DebugPlugin()
    monitor.use(debug)

    let entryStart = 0
    let entries: ResourceTimingSample[] = []
    const trace = monitor.createTrace({ aiMessageId: 'msg_1', resourceEntries: () => entries })

    trace.markRequestStart({ url: '/api/chat' })
    entryStart = trace.getRequestStartTime()
    vi.advanceTimersByTime(120)
    trace.firstByte()
    vi.advanceTimersByTime(1000)
    trace.complete()
    monitor.setCurrentTrace(null) // 模拟 trace-helper.endTrace 的收尾

    entries = [
      { name: 'http://localhost/api/chat', startTime: entryStart, responseStart: entryStart + 90 },
    ]
    vi.runAllTimers()

    const correction = debug
      .getEvents()
      .find((e) => e.type === 'sse_first_byte' && e.data.refined === true)!
    expect(correction.data.traceId).toBe(trace.traceId)
    expect(correction.context.traceId).toBe(trace.traceId)
  })
})

/**
 * 调试面板的"链路模拟"是给人看指标口径的样板，必须自身自洽：
 * 模拟是同步的，如果用真实时钟，所有指标都会是 0ms，甚至出现 FCL < TTFB。
 */
describe('DebugPlugin 链路模拟', () => {
  function createSimulation() {
    const monitor = new Monitor({ appId: 'test-app' })
    const debug = new DebugPlugin()
    monitor.use(debug)
    return { monitor, debug }
  }

  it('模拟链路给出自洽的指标时间线（180 / 220 / 460 / 1520 / 3200）', () => {
    const { debug } = createSimulation()
    debug.simulateTrace('success')

    const complete = debug.getEvents().find((e) => e.type === 'sse_complete')!
    expect(complete.data).toMatchObject({
      ttfb: 180,
      firstChunkLatency: 220,
      ttft: 460,
      ttftPhase: 'thinking',
      ttfa: 1520,
      ttlb: 3200,
      duration: 3200,
      rawChunkCount: 1,
      bytesReceived: 64,
    })
  })

  it('模拟链路不参与 Resource Timing 校准（读数不会被真实请求污染）', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const debug = new DebugPlugin()
    // 故意把"真实请求"的条目喂进去：只有注入条目的 Trace 会被校准，模拟 Trace 必须忽略它
    const realEntries = () => [
      { name: 'http://localhost/api/chat', startTime: 1000, responseStart: 1005 },
    ]
    const trace = monitor.createTrace({
      aiMessageId: 'demo',
      now: () => 1000,
      resourceEntries: realEntries,
    })
    monitor.use(debug)
    debug.simulateTrace('success')

    // 直接构造的 Trace（注入真实条目）会被校准，说明注入源本身是有效的
    trace.markRequestStart({ url: '/api/chat' })
    trace.firstByte()
    trace.complete()
    const calibrated = debug
      .getEvents()
      .filter((e) => e.type === 'sse_complete')
      .pop()!
    expect(calibrated.data.ttfb).toBe(5)
    expect(calibrated.data.ttfbSource).toBe('resource-timing')

    // 而模拟 Trace 的 TTFB 仍是时间线里的 180
    const simulated = debug.getEvents().find((e) => e.type === 'sse_complete')!
    expect(simulated.data.ttfb).toBe(180)
    expect(simulated.data.ttfbSource).toBe('fetch-headers')
  })

  it('error / abort 模拟带指标快照且在中途结束', () => {
    const { debug } = createSimulation()

    debug.simulateTrace('error')
    const error = debug.getEvents().find((e) => e.type === 'sse_error')!
    expect(error.data).toMatchObject({ ttfb: 180, firstChunkLatency: 220, ttft: 460 })
    expect(error.data.ttlb).toBeUndefined()
    expect(Number(error.data.duration)).toBeGreaterThan(460)

    debug.simulateTrace('abort')
    const aborted = debug.getEvents().filter((e) => e.type === 'sse_abort').pop()!
    expect(aborted.data).toMatchObject({ message: 'user_cancel', ttfb: 180 })
  })
})

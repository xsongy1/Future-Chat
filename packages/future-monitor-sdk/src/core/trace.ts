/**
 * Trace - SSE 流式响应链路追踪（AI 场景核心能力）
 *
 * 覆盖传统监控无法追踪的 AI 对话场景：
 * - 完整生命周期：sse_start → sse_first_byte → sse_first_chunk → sse_first_token
 *   → (phase_*) → (tool_*) → sse_complete
 * - 延迟指标：TTFB / First Chunk Latency / TTFT / TTFA / TTLB
 * - 阶段拆分（thinking / answer）
 * - 工具调用链路（tool_start / tool_end）
 * - 卡顿检测（chunk 间隔超过阈值触发 sse_stall / sse_resume）
 * - 重试链路（previousTraceId 串联）
 * - 结构化错误分类（errorCode / statusCode / retryable）
 * - Token 用量与成本（setUsage → sse_usage 事件 + estimatedCost）
 * - 吞吐指标（chunksPerSec / tokensPerSec）
 *
 * ============================ 指标口径 ============================
 *
 * 所有指标共用一个基准：
 *   **T0 = 请求真正发出的时刻**（宿主在 fetch 前调用 markRequestStart()；
 *   不调用则退回 Trace 构造时刻，见下方"基准"说明）
 *   指标值 = 事件时刻 - T0，单位 ms，四舍五入为整数。
 *
 * | 指标 | 物理含义 | 公式 | 由谁触发 |
 * | --- | --- | --- | --- |
 * | TTFB | 首字节：HTTP 响应头到达客户端 | firstByte - T0 | fetch() resolve 后调 firstByte() |
 * | First Chunk Latency | 首个响应体数据块（read() 首次拿到字节） | firstChunk - T0 | 流首次 read() → rawChunk() |
 * | TTFT | 首个模型生成的 token（首个带内容的 thinking/answer 增量） | firstToken - T0 | 首个内容增量帧 |
 * | TTFA | 首个 answer token（思考型模型另算） | firstAnswerToken - T0 | 首个 answer 内容帧 |
 * | TTLB | 末字节：流关闭 | end - T0 | complete() / error() / abort() |
 *
 * 恒等关系（网络物理决定的，不是约定）：
 *   0 ≤ TTFB ≤ First Chunk Latency ≤ TTFT ≤ TTLB
 *
 * 三者的区别（这是最容易被混淆的地方）：
 * - TTFB 里 **没有** 模型生成时间，它只到"响应头到达"为止，反映网络 + 排队 + 服务端首包。
 * - First Chunk Latency 到"第一个数据块到达"为止，比 TTFB 多出服务端把首块 flush 出来的时间。
 * - TTFT 到"第一个 token"为止，比 First Chunk Latency 多出模型首 token 生成时间；
 *   首个数据块可能只含 role 帧、usage 帧、心跳或半条 SSE 帧，所以 TTFT 必然 ≥ First Chunk Latency。
 * - 因此 **不能用首块时延冒充 TTFB**：那会把模型生成时间算进网络指标里。
 *
 * 基准（T0）说明：
 * - 宿主必须用 markRequestStart() 把 T0 对齐到 fetch 真正发出的时刻；
 *   若在 fetch 之前还有序列化、动态 import 等耗时，不标记会让所有指标一起偏大。
 * - 未标记时退回 Trace 构造时刻（createdAt），指标仍然可用，但口径是"从建 Trace 起算"。
 * - T0 只认第一次标记：重试应该新建 Trace（用 previousTraceId 串联），
 *   重复标记会让已经算出的 TTFB 变小。
 *
 * TTFB 的校准：
 * fetch() resolve 发生在主线程，可能比网络层真正的首字节晚若干毫秒（调度抖动，
 * 主线程正在渲染时会更大）。complete() / error() / abort() 时会尝试用 Resource Timing 的
 * responseStart 做一次同步校准，把 ttfbSource 标成 'resource-timing'。
 *
 * 同步这次常常取不到：浏览器一般在响应体收完后才把条目写进缓冲区。因此还会补一次
 * 0ms 延迟读取（见 scheduleDeferredRefine），命中就再发一条 sse_first_byte，
 * 载荷带 `refined: true`。同一 traceId 内：
 *   **带 refined 的那条（或 ttfbSource = 'resource-timing' 的 sse_complete）才是最终值**。
 * 取不到条目就保留 'fetch-headers' 的原值——不编造数字，也不会把 TTFB 改大。
 *
 * 阶段收尾：
 * 任何结束方式（complete / error / abort）都会先关闭仍未闭合的阶段，
 * 自动关闭的 phase_end 带 `auto: true`。这样即使宿主漏调 phaseEnd（例如用户点停止，
 * 结束 Trace 的调用发生在流读取回调之前），也不会出现"永远进行中"的阶段。
 */

import type { TokenUsage, ToolResult, TraceError, TraceOptions } from './types'
import { generateTraceId } from './ids'
import { estimateCost } from './cost'
import {
  defaultClock,
  hasHighResClock,
  readResourceTtfb,
  type Clock,
  type ResourceEntrySource,
} from './timing'

export type TraceState = 'active' | 'completed' | 'error' | 'aborted'

/** 指标所属阶段 */
export type MetricPhase = 'thinking' | 'answer'

/** TTFB 的取值来源：主线程观测到的响应头 / 浏览器网络层 Resource Timing */
export type TtfbSource = 'fetch-headers' | 'resource-timing'

/** 指标快照（进行中与结束时都可用） */
export interface TraceMetrics {
  /** 请求发出 → 首字节（毫秒）；未观测到为 null */
  ttfb: number | null
  /** TTFB 的来源 */
  ttfbSource: TtfbSource | null
  /** 请求发出 → 首个响应体数据块（毫秒） */
  firstChunkLatency: number | null
  /** 请求发出 → 首个模型 token（毫秒） */
  ttft: number | null
  /** 首个 token 属于哪个阶段 */
  ttftPhase: MetricPhase | null
  /** 请求发出 → 首个 answer token（毫秒） */
  ttfa: number | null
  /** 请求发出 → 流结束（毫秒）；进行中为 null */
  ttlb: number | null
  /** SSE 事件数（含 thinking/answer/tool/usage/complete） */
  chunkCount: number
  /** 网络层数据块数（每次 read() 拿到数据的次数） */
  rawChunkCount: number
  /** 累计收到的字节数 */
  bytesReceived: number
}

/** 事件发射器：由 Monitor 注入，统一走 track() 管道 */
export type TraceEmitFn = (type: string, data: Record<string, unknown>) => void

const DEFAULT_STALL_THRESHOLD = 3000

/**
 * Resource Timing 校准的容忍上限（ms）。
 * 网络层首字节不可能晚于主线程观测到的响应头时刻，超出这个余量说明
 * 匹配到了别的请求的条目，宁可保留 fetch-headers 的原值。
 */
const RESOURCE_TTBF_TOLERANCE = 50

export class Trace {
  readonly traceId: string
  readonly aiMessageId: string
  readonly previousTraceId?: string
  readonly stallThreshold: number
  /** 使用的模型（用于模型对比与成本核算） */
  readonly model?: string
  /** 模型供应商 */
  readonly provider?: string

  private state: TraceState = 'active'
  private readonly clock: Clock
  private readonly resourceEntries?: ResourceEntrySource
  /** Trace 构造时刻：仅作为 T0 缺省值与面板时间轴使用 */
  private readonly createdAt: number
  /** T0：请求真正发出的时刻（所有指标的基准） */
  private requestStartTime: number
  private requestMarked = false
  private requestUrl?: string

  private firstByteTime: number | null = null
  private ttfbSource: TtfbSource | null = null
  private firstChunkTime: number | null = null
  private firstTokenTime: number | null = null
  private firstTokenPhase: MetricPhase | null = null
  private firstAnswerTokenTime: number | null = null
  private endTime: number | null = null

  private lastChunkTime: number | null = null
  private rawChunkCount = 0
  private bytesReceived = 0
  private chunkCount = 0
  private isStalled = false
  /** 未闭合的阶段：结束事件前会自动关闭（避免阶段永远停在"进行中"） */
  private readonly openPhases = new Set<string>()
  /** 是否已经安排过延迟补校（只安排一次） */
  private refineScheduled = false
  private usage: TokenUsage | null = null
  private readonly emit: TraceEmitFn

  constructor(options: TraceOptions, emit: TraceEmitFn) {
    this.traceId = generateTraceId()
    this.aiMessageId = options.aiMessageId
    this.previousTraceId = options.previousTraceId
    this.stallThreshold = options.stallThreshold ?? DEFAULT_STALL_THRESHOLD
    this.model = options.model
    this.provider = options.provider
    this.clock = options.now ?? defaultClock
    this.resourceEntries = options.resourceEntries
    this.createdAt = this.clock()
    // T0 缺省 = 构造时刻；宿主应在 fetch 前调用 markRequestStart() 覆盖它
    this.requestStartTime = this.createdAt
    this.emit = emit
  }

  /** SSE 开始 */
  start(): void {
    this.emit('sse_start', {
      traceId: this.traceId,
      aiMessageId: this.aiMessageId,
      previousTraceId: this.previousTraceId,
      model: this.model,
      provider: this.provider,
    })
  }

  /**
   * 标记 T0：请求真正发出的时刻（fetch 调用前）
   *
   * 这是所有延迟指标的基准，也是唯一能让 TTFB / First Chunk Latency / TTFT
   * 相互可比的地方。只认第一次标记，重复调用（含重试）不生效。
   *
   * 时间取当前时钟（默认 performance.now）；需要自控时钟（测试 / 回放）时
   * 用 TraceOptions.now 注入，不要在方法上散落时间戳，避免与时钟域混用。
   *
   * @param options.url - 请求 URL（结束时用 Resource Timing 校准 TTFB）
   */
  markRequestStart(options: { url?: string } = {}): void {
    if (this.requestMarked) return
    this.requestMarked = true
    this.requestStartTime = this.clock()
    if (options.url) this.requestUrl = options.url
  }

  /**
   * 首字节（TTFB）：fetch() resolve、HTTP 响应头已到达客户端
   *
   * 注意这里 **不是** 第一个 SSE 帧到达的时刻——那是 First Chunk Latency。
   * 幂等：重复调用不会改变已记录的 TTFB 或重复发事件。
   */
  firstByte(): void {
    if (this.firstByteTime !== null || this.state !== 'active') return
    this.firstByteTime = this.clock()
    this.ttfbSource = 'fetch-headers'
    this.emit('sse_first_byte', {
      traceId: this.traceId,
      ttfb: this.latency(this.firstByteTime),
      source: this.ttfbSource,
    })
  }

  /**
   * 首个响应体数据块（First Chunk Latency）
   *
   * 常规路径由 rawChunk() 自动记录；宿主也可以显式调用（幂等）。
   */
  firstChunk(): void {
    if (this.firstChunkTime !== null || this.state !== 'active') return
    this.recordFirstChunk(this.clock())
  }

  /**
   * 网络层数据块到达（每次 reader.read() 拿到数据调用一次）
   *
   * 首个数据块即 First Chunk Latency，因此 FCL 由这里自动记录，
   * 不需要宿主自己判断"是不是第一个 chunk"。
   *
   * @param bytes - 本块字节数（累计进 bytesReceived）
   */
  rawChunk(bytes = 0): void {
    if (this.state !== 'active') return
    this.rawChunkCount += 1
    if (bytes > 0) this.bytesReceived += bytes
    if (this.firstChunkTime === null) this.recordFirstChunk(this.clock())
  }

  /**
   * 首个模型 token（TTFT）
   *
   * 只在**带内容的**增量帧上调用：role 帧、心跳、usage 帧、半条 SSE 帧都不算 token。
   * 首个 answer 内容帧同时记录 TTFA（思考型模型下 TTFA 才是"用户看到正文"的时刻）。
   *
   * @param phase - 该增量属于 thinking 还是 answer
   */
  firstToken(phase: MetricPhase): void {
    if (this.state !== 'active') return
    const at = this.clock()

    if (phase === 'answer' && this.firstAnswerTokenTime === null) {
      this.firstAnswerTokenTime = at
    }

    if (this.firstTokenTime !== null) return
    this.firstTokenTime = at
    this.firstTokenPhase = phase
    this.emit('sse_first_token', {
      traceId: this.traceId,
      ttft: this.latency(at),
      phase,
    })
  }

  /**
   * 记录 SSE 事件并做卡顿检测：
   * - 距上一个事件超过阈值 → 触发 sse_stall
   * - 卡顿后恢复 → 触发 sse_resume
   */
  recordChunk(): void {
    if (this.state !== 'active') return
    const now = this.clock()
    this.chunkCount += 1

    if (this.lastChunkTime !== null) {
      const gap = now - this.lastChunkTime
      if (!this.isStalled && gap >= this.stallThreshold) {
        this.isStalled = true
        this.emit('sse_stall', { traceId: this.traceId, stallDuration: gap })
      } else if (this.isStalled && gap < this.stallThreshold) {
        // 必须同时在"已卡顿"且"这一跳的间隔已回到阈值内"时才算恢复：
        // 只判 isStalled 会把"连续两个超阈值间隔"（仍卡着）误报成 sse_resume
        this.isStalled = false
        this.emit('sse_resume', { traceId: this.traceId, stallDuration: gap })
      }
    }
    this.lastChunkTime = now
  }

  /** 阶段开始（thinking / answer / 自定义） */
  phaseStart(phase: string): void {
    this.openPhases.add(phase)
    this.emit('phase_start', { traceId: this.traceId, phase })
  }

  /** 阶段结束 */
  phaseEnd(phase: string): void {
    this.openPhases.delete(phase)
    this.emit('phase_end', { traceId: this.traceId, phase })
  }

  /** 工具调用开始 */
  toolStart(name: string, args?: Record<string, unknown>, toolCallId?: string): void {
    this.emit('tool_start', {
      traceId: this.traceId,
      name,
      toolCallId,
      args,
    })
  }

  /** 工具调用结束 */
  toolEnd(name: string, result: ToolResult): void {
    this.emit('tool_end', {
      traceId: this.traceId,
      name,
      toolCallId: result.toolCallId,
      ...result,
    })
  }

  /**
   * 记录 Token 用量（后端透传 usage 后调用）
   * 发出 sse_usage 事件：token 明细 + 估算成本 + 输出速率
   */
  setUsage(usage: TokenUsage): void {
    this.usage = usage
    const totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    const model = usage.model ?? this.model ?? ''

    // 成本估算（未知模型返回 null，不硬造数字）
    const cost = estimateCost(model, usage.inputTokens, usage.outputTokens)

    // 吞吐：totalTokens / 从请求发出到当前的耗时（秒），与延迟指标同基准
    const elapsedSec = (this.clock() - this.requestStartTime) / 1000
    const tokensPerSec = elapsedSec > 0 ? Math.round(totalTokens / elapsedSec) : 0

    this.emit('sse_usage', {
      traceId: this.traceId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens,
      model,
      estimatedCost: cost?.estimatedCost ?? null,
      currency: cost?.currency ?? 'USD',
      tokensPerSec,
    })
  }

  /**
   * SSE 正常完成：计算 TTLB，并把全部延迟指标打包进 sse_complete
   *
   * TTLB 是"末字节"——宿主应该在流真正关闭（read() 返回 done）时调用本方法，
   * 而不是在收到 complete 帧的那一刻，否则末字节会被算小。
   */
  complete(): void {
    if (this.state !== 'active') return
    this.state = 'completed'
    this.endTime = this.clock()
    this.closeOpenPhases()
    const refined = this.refineTtfb()

    const ttlb = this.latency(this.endTime)
    const elapsedSec = ttlb / 1000
    const chunksPerSec = elapsedSec > 0 ? Math.round((this.chunkCount / elapsedSec) * 10) / 10 : 0

    this.emit('sse_complete', {
      traceId: this.traceId,
      ttlb,
      duration: ttlb,
      ...this.metricPayload(),
      chunkCount: this.chunkCount,
      rawChunkCount: this.rawChunkCount,
      bytesReceived: this.bytesReceived,
      chunksPerSec,
      model: this.model,
    })

    this.scheduleDeferredRefine(refined)
  }

  /**
   * 出错结束
   * 支持两种形态：
   * - trace.error('模型超时')：简单字符串（兼容旧调用）
   * - trace.error({ code: 'RATE_LIMIT', message: '...', statusCode: 429, retryable: true })：结构化错误
   */
  error(error: string | TraceError = 'Unknown error'): void {
    if (this.state !== 'active') return
    this.state = 'error'

    const normalized: TraceError = typeof error === 'string' ? { message: error } : error
    this.endTime = this.clock()
    this.closeOpenPhases()
    const refined = this.refineTtfb()

    this.emit('sse_error', {
      traceId: this.traceId,
      message: normalized.message ?? 'Unknown error',
      errorCode: normalized.code ?? classifyError(normalized),
      statusCode: normalized.statusCode,
      retryable: normalized.retryable,
      duration: this.latency(this.endTime),
      // 出错位置很关键：TTFB 已出说明错在流中途，TTFT 为空说明模型还没吐字
      ...this.metricPayload(),
      chunkCount: this.chunkCount,
      model: this.model,
    })

    this.scheduleDeferredRefine(refined)
  }

  /**
   * 中止（用户取消）
   *
   * 与 complete/error 一样会尝试校准 TTFB：取消时通常已经收到过响应头，
   * 取消点之前的指标依然有诊断价值。
   */
  abort(message = 'user_cancel'): void {
    if (this.state !== 'active') return
    this.state = 'aborted'
    this.endTime = this.clock()
    this.closeOpenPhases()
    const refined = this.refineTtfb()

    this.emit('sse_abort', {
      traceId: this.traceId,
      message,
      duration: this.latency(this.endTime),
      ...this.metricPayload(),
      chunkCount: this.chunkCount,
    })

    this.scheduleDeferredRefine(refined)
  }

  getState(): TraceState {
    return this.state
  }

  /** 当前已记录的 Token 用量 */
  getUsage(): TokenUsage | null {
    return this.usage
  }

  /** T0：请求发出的时刻（所有指标的基准） */
  getRequestStartTime(): number {
    return this.requestStartTime
  }

  /** 指标快照（进行中也可读，用于面板与断言） */
  getMetrics(): TraceMetrics {
    return {
      ttfb: this.firstByteTime === null ? null : this.latency(this.firstByteTime),
      ttfbSource: this.ttfbSource,
      firstChunkLatency:
        this.firstChunkTime === null ? null : this.latency(this.firstChunkTime),
      ttft: this.firstTokenTime === null ? null : this.latency(this.firstTokenTime),
      ttftPhase: this.firstTokenPhase,
      ttfa:
        this.firstAnswerTokenTime === null ? null : this.latency(this.firstAnswerTokenTime),
      ttlb: this.endTime === null ? null : this.latency(this.endTime),
      chunkCount: this.chunkCount,
      rawChunkCount: this.rawChunkCount,
      bytesReceived: this.bytesReceived,
    }
  }

  // ==================== 内部 ====================

  /** 相对 T0 的毫秒时延（四舍五入为整数毫秒） */
  private latency(at: number): number {
    return Math.round(at - this.requestStartTime)
  }

  private recordFirstChunk(at: number): void {
    this.firstChunkTime = at
    this.emit('sse_first_chunk', {
      traceId: this.traceId,
      firstChunkLatency: this.latency(at),
    })
  }

  /** 结束事件里携带的延迟指标（口径统一，字段一一对应） */
  private metricPayload(): Record<string, unknown> {
    const metrics = this.getMetrics()
    return {
      ttfb: metrics.ttfb,
      ttfbSource: metrics.ttfbSource,
      firstChunkLatency: metrics.firstChunkLatency,
      ttft: metrics.ttft,
      ttftPhase: metrics.ttftPhase,
      ttfa: metrics.ttfa,
    }
  }

  /**
   * 结束前关闭所有仍未闭合的阶段，发出 phase_end（带 auto: true）
   *
   * 保证任何结束方式之后都不会留下"永远进行中"的阶段：
   * 用户点停止时，宿主往往是先结束 Trace、再由流读取回调抛 AbortError，
   * 那种顺序下宿主已经没有机会调 phaseEnd 了。
   */
  private closeOpenPhases(): void {
    if (this.openPhases.size === 0) return
    for (const phase of [...this.openPhases]) {
      this.openPhases.delete(phase)
      this.emit('phase_end', { traceId: this.traceId, phase, auto: true })
    }
  }

  /**
   * 用 Resource Timing 校准 TTFB（响应头到达的主线程观测 → 网络层首字节）
   *
   * 只在已经观测到首字节、且有请求 URL、且环境具备高精度时钟时尝试；
   * 取不到条目或读数不合理时保留原值。
   *
   * @returns 是否成功校准
   */
  private refineTtfb(): boolean {
    if (this.ttfbSource !== 'fetch-headers' || this.firstByteTime === null) return false
    if (!this.requestUrl || !hasHighResClock()) return false

    const measured = this.firstByteTime - this.requestStartTime
    const netTtfb = readResourceTtfb(this.requestUrl, {
      requestStart: this.requestStartTime,
      source: this.resourceEntries,
    })
    if (netTtfb === null) return false
    if (netTtfb < 0 || netTtfb > measured + RESOURCE_TTBF_TOLERANCE) return false

    this.firstByteTime = this.requestStartTime + netTtfb
    this.ttfbSource = 'resource-timing'
    return true
  }

  /**
   * 安排一次延迟补校（只安排一次，且只在同步那一次没成功时）
   *
   * 浏览器一般在响应体收完后才把 Resource Timing 条目写进缓冲区，
   * 所以同步读经常会空手而归；补读一次能把 TTFB 从"主线程观测值"换成网络层真值。
   */
  private scheduleDeferredRefine(alreadyRefined: boolean): void {
    if (alreadyRefined || this.refineScheduled) return
    if (this.firstByteTime === null || !this.requestUrl || !hasHighResClock()) return
    if (typeof setTimeout !== 'function') return

    this.refineScheduled = true
    setTimeout(() => this.applyDeferredRefine(), 0)
  }

  /**
   * 延迟补校：命中就补发一条 sse_first_byte（refined: true）
   *
   * 此时 sse_complete 已经发出，所以最终值以这条事件为准（见文件头的口径说明）。
   */
  private applyDeferredRefine(): void {
    if (this.state === 'active') return
    if (!this.refineTtfb()) return

    this.emit('sse_first_byte', {
      traceId: this.traceId,
      ttfb: this.latency(this.firstByteTime as number),
      source: 'resource-timing',
      refined: true,
    })
  }
}

/**
 * 未显式提供 errorCode 时，根据 HTTP 状态码自动分类：
 * 429 → RATE_LIMIT；401/403 → AUTH_ERROR；4xx → INVALID_REQUEST；5xx → PROVIDER_ERROR
 */
function classifyError(error: TraceError): string {
  const status = error.statusCode
  if (!status) return 'STREAM_ERROR'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 401 || status === 403) return 'AUTH_ERROR'
  if (status >= 500) return 'PROVIDER_ERROR'
  if (status >= 400) return 'INVALID_REQUEST'
  return 'STREAM_ERROR'
}

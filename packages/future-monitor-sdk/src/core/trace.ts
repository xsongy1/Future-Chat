/**
 * Trace - SSE 流式响应链路追踪（AI 场景核心能力）
 *
 * 覆盖传统监控无法追踪的 AI 对话场景：
 * - 完整生命周期：sse_start → (sse_first_chunk) → (phase_*) → (tool_*) → sse_complete
 * - TTFB（首字节）/ TTLB（末字节）
 * - 阶段拆分（thinking / answer）
 * - 工具调用链路（tool_start / tool_end）
 * - 卡顿检测（chunk 间隔超过阈值触发 sse_stall / sse_resume）
 * - 重试链路（previousTraceId 串联）
 * - 结构化错误分类（errorCode / statusCode / retryable）
 * - Token 用量与成本（setUsage → sse_usage 事件 + estimatedCost）
 * - 吞吐指标（chunksPerSec / tokensPerSec）
 */

import type { TokenUsage, ToolResult, TraceError, TraceOptions } from './types.js'
import { generateTraceId } from './ids.js'
import { estimateCost } from './cost.js'

export type TraceState = 'active' | 'completed' | 'error' | 'aborted'

/** 事件发射器：由 Monitor 注入，统一走 track() 管道 */
export type TraceEmitFn = (type: string, data: Record<string, unknown>) => void

const DEFAULT_STALL_THRESHOLD = 3000

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
  private readonly startTime: number
  private firstChunkTime: number | null = null
  private lastChunkTime: number | null = null
  private chunkCount = 0
  private isStalled = false
  private usage: TokenUsage | null = null
  private readonly emit: TraceEmitFn

  constructor(options: TraceOptions, emit: TraceEmitFn) {
    this.traceId = generateTraceId()
    this.aiMessageId = options.aiMessageId
    this.previousTraceId = options.previousTraceId
    this.stallThreshold = options.stallThreshold ?? DEFAULT_STALL_THRESHOLD
    this.model = options.model
    this.provider = options.provider
    this.startTime = Date.now()
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

  /** 首个 chunk：计算 TTFB */
  firstChunk(): void {
    if (this.firstChunkTime !== null) return
    this.firstChunkTime = Date.now()
    this.recordChunk()
    this.emit('sse_first_chunk', {
      traceId: this.traceId,
      ttfb: this.firstChunkTime - this.startTime,
    })
  }

  /**
   * 记录 chunk 并做卡顿检测：
   * - 距上一个 chunk 超过阈值 → 触发 sse_stall
   * - 卡顿后恢复 → 触发 sse_resume
   */
  recordChunk(): void {
    if (this.state !== 'active') return
    const now = Date.now()
    this.chunkCount += 1

    if (this.lastChunkTime !== null) {
      const gap = now - this.lastChunkTime
      if (!this.isStalled && gap >= this.stallThreshold) {
        this.isStalled = true
        this.emit('sse_stall', { traceId: this.traceId, stallDuration: gap })
      } else if (this.isStalled) {
        this.isStalled = false
        this.emit('sse_resume', { traceId: this.traceId, stallDuration: gap })
      }
    }
    this.lastChunkTime = now
  }

  /** 阶段开始（thinking / answer / 自定义） */
  phaseStart(phase: string): void {
    this.emit('phase_start', { traceId: this.traceId, phase })
  }

  /** 阶段结束 */
  phaseEnd(phase: string): void {
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

    // 吞吐：totalTokens / 已耗时（秒）
    const elapsedSec = (Date.now() - this.startTime) / 1000
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

  /** SSE 正常完成：计算 TTLB */
  complete(): void {
    if (this.state !== 'active') return
    this.state = 'completed'
    const ttlb = Date.now() - this.startTime
    const elapsedSec = ttlb / 1000
    const chunksPerSec = elapsedSec > 0 ? Math.round((this.chunkCount / elapsedSec) * 10) / 10 : 0

    this.emit('sse_complete', {
      traceId: this.traceId,
      ttlb,
      duration: ttlb,
      chunkCount: this.chunkCount,
      chunksPerSec,
      model: this.model,
    })
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
    const duration = Date.now() - this.startTime

    this.emit('sse_error', {
      traceId: this.traceId,
      message: normalized.message ?? 'Unknown error',
      errorCode: normalized.code ?? classifyError(normalized),
      statusCode: normalized.statusCode,
      retryable: normalized.retryable,
      duration,
      chunkCount: this.chunkCount,
      model: this.model,
    })
  }

  /** 中止（用户取消） */
  abort(message = 'user_cancel'): void {
    if (this.state !== 'active') return
    this.state = 'aborted'
    this.emit('sse_abort', {
      traceId: this.traceId,
      message,
      duration: Date.now() - this.startTime,
      chunkCount: this.chunkCount,
    })
  }

  getState(): TraceState {
    return this.state
  }

  /** 当前已记录的 Token 用量 */
  getUsage(): TokenUsage | null {
    return this.usage
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

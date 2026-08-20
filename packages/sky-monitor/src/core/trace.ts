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
 */

import type { ToolResult, TraceOptions } from './types'
import { generateTraceId } from './ids'

export type TraceState = 'active' | 'completed' | 'error' | 'aborted'

/** 事件发射器：由 Monitor 注入，统一走 track() 管道 */
export type TraceEmitFn = (type: string, data: Record<string, unknown>) => void

const DEFAULT_STALL_THRESHOLD = 3000

export class Trace {
  readonly traceId: string
  readonly aiMessageId: string
  readonly previousTraceId?: string
  readonly stallThreshold: number

  private state: TraceState = 'active'
  private readonly startTime: number
  private firstChunkTime: number | null = null
  private lastChunkTime: number | null = null
  private chunkCount = 0
  private isStalled = false
  private readonly emit: TraceEmitFn

  constructor(options: TraceOptions, emit: TraceEmitFn) {
    this.traceId = generateTraceId()
    this.aiMessageId = options.aiMessageId
    this.previousTraceId = options.previousTraceId
    this.stallThreshold = options.stallThreshold ?? DEFAULT_STALL_THRESHOLD
    this.startTime = Date.now()
    this.emit = emit
  }

  /** SSE 开始 */
  start(): void {
    this.emit('sse_start', {
      traceId: this.traceId,
      aiMessageId: this.aiMessageId,
      previousTraceId: this.previousTraceId,
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

  /** SSE 正常完成：计算 TTLB */
  complete(): void {
    if (this.state !== 'active') return
    this.state = 'completed'
    const ttlb = Date.now() - this.startTime
    this.emit('sse_complete', {
      traceId: this.traceId,
      ttlb,
      duration: ttlb,
      chunkCount: this.chunkCount,
    })
  }

  /** 出错结束 */
  error(message = 'Unknown error'): void {
    if (this.state !== 'active') return
    this.state = 'error'
    this.emit('sse_error', {
      traceId: this.traceId,
      message,
      duration: Date.now() - this.startTime,
      chunkCount: this.chunkCount,
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
}

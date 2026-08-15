/**
 * Trace 兼容插件
 *
 * 本地开发版 SDK 的 TracePlugin 注入 createTrace/setCurrentTrace/getCurrentTrace，
 * npm 0.2.0 的 TracePlugin API 不同，这里按项目使用方式（trace-helper）自实现。
 * 事件通过 monitor.track() 产出，流经插件管道后可被 DebugPlugin 收集。
 */

import type { IMonitor, MonitorEvent, Plugin, ToolResult } from '@jerry_aurora/sky-monitor-sdk'
import { generateTraceId } from '@jerry_aurora/sky-monitor-sdk'

export interface CompatTraceOptions {
  aiMessageId: string
  previousTraceId?: string
}

type TraceState = 'active' | 'completed' | 'error' | 'aborted'

type EmitFn = (type: string, data: Record<string, unknown>) => void

/** SSE 链路追踪类（对齐项目使用的 API 面） */
export class CompatTrace {
  readonly traceId: string
  readonly aiMessageId: string
  readonly previousTraceId?: string

  private state: TraceState = 'active'
  private readonly startTime: number
  private firstChunkTime: number | null = null
  private readonly emit: EmitFn

  constructor(options: CompatTraceOptions, emit: EmitFn) {
    this.traceId = generateTraceId()
    this.aiMessageId = options.aiMessageId
    this.previousTraceId = options.previousTraceId
    this.startTime = Date.now()
    this.emit = emit
  }

  /** 开始追踪 */
  start(): void {
    this.emit('sse_start', {
      traceId: this.traceId,
      aiMessageId: this.aiMessageId,
      previousTraceId: this.previousTraceId,
    })
  }

  /** 正常完成 */
  complete(): void {
    if (this.state !== 'active') return
    this.state = 'completed'
    const ttlb = Date.now() - this.startTime
    this.emit('sse_complete', { traceId: this.traceId, ttlb, duration: ttlb })
  }

  /** 出错结束 */
  error(message: string): void {
    if (this.state !== 'active') return
    this.state = 'error'
    this.emit('sse_error', {
      traceId: this.traceId,
      message,
      duration: Date.now() - this.startTime,
    })
  }

  /** 中止 */
  abort(message = 'user_cancel'): void {
    if (this.state !== 'active') return
    this.state = 'aborted'
    this.emit('sse_abort', {
      traceId: this.traceId,
      message,
      duration: Date.now() - this.startTime,
    })
  }

  /** 首个 chunk（TTFB） */
  firstChunk(): void {
    if (this.firstChunkTime !== null) return
    this.firstChunkTime = Date.now()
    this.emit('sse_first_chunk', {
      traceId: this.traceId,
      ttfb: this.firstChunkTime - this.startTime,
    })
  }

  /** 记录 chunk（stall 检测用，面板不展示） */
  recordChunk(): void {
    // npm 0.2.0 管道不消费该事件，仅保持 API 兼容
  }

  /** 阶段开始 */
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
}

/** TracePlugin 兼容层：在 Monitor 上注入 createTrace/setCurrentTrace/getCurrentTrace */
export class CompatTracePlugin implements Plugin {
  name = 'trace'
  priority = 100

  private monitor: IMonitor | null = null
  private currentTrace: CompatTrace | null = null

  setupOnce(monitor: IMonitor): void {
    this.monitor = monitor

    const injected = monitor as unknown as Record<string, unknown>

    injected.createTrace = (options: CompatTraceOptions) => {
      if (!this.monitor) throw new Error('TracePlugin not initialized')
      const trace = new CompatTrace(options, (type, data) => {
        this.monitor?.track(type, data)
      })
      return trace
    }

    injected.setCurrentTrace = (trace: CompatTrace | null) => {
      this.currentTrace = trace
    }

    injected.getCurrentTrace = () => this.currentTrace
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    return event
  }
}

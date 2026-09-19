/**
 * DebugPlugin - 调试插件（开发环境）
 *
 * 收集流经管道的事件（环形缓冲），向调试面板提供订阅/查询 API，
 * 并桥接 transport 插件的队列状态（待发送/离线/强制发送/清空）。
 *
 * 实例挂载在 window.__SKY_MONITOR_DEBUG__，供面板轮询发现。
 */

import type { MonitorEvent, Plugin, TraceError } from '../core/types'
import type { Monitor } from '../core/monitor'

export interface DebugPluginOptions {
  /** 内存中保留的最大事件数，默认 500 */
  maxEvents?: number
}

const WINDOW_KEY = '__SKY_MONITOR_DEBUG__'

type EventListener = (event: MonitorEvent) => void

export class DebugPlugin implements Plugin {
  name = 'debug'
  /** 管道最前：记录所有事件（包括被去重丢弃前的原始流） */
  priority = 1000

  private monitor: Monitor | null = null
  private events: MonitorEvent[] = []
  private listeners = new Set<EventListener>()
  private readonly maxEvents: number

  constructor(options: DebugPluginOptions = {}) {
    this.maxEvents = options.maxEvents ?? 500
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>)[WINDOW_KEY] = this
    }
  }

  reset(): void {
    this.events = []
    this.listeners.clear()
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>)[WINDOW_KEY]
    }
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 订阅者异常不影响管道
      }
    }
    return event
  }

  // ==================== 订阅 ====================

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ==================== 查询 ====================

  getEvents(): MonitorEvent[] {
    return [...this.events]
  }

  getEventsByType(type: string): MonitorEvent[] {
    return this.events.filter((e) => e.type === type)
  }

  getStats(): Record<string, number> {
    const stats: Record<string, number> = {}
    for (const event of this.events) {
      stats[event.type] = (stats[event.type] ?? 0) + 1
    }
    return stats
  }

  // ==================== 操作 ====================

  clearEvents(): void {
    this.events = []
  }

  /** 手动上报事件（测试触发用） */
  track(type: string, data?: Record<string, unknown>): void {
    this.monitor?.track(type, data)
  }

  // ==================== 链路模拟（调试面板测试按钮用） ====================

  /**
   * 模拟一次完整的 AI 请求链路（走真实 Trace API，产出真实事件流）
   *
   * 时间线用**注入时钟**推进（模拟是同步的，用真实时钟会得到一堆 0ms 指标，
   * 甚至让 First Chunk Latency 小于 TTFB），并显式声明没有 Resource Timing 条目，
   * 避免把面板里真实请求的读数串到模拟 Trace 上。
   *
   * 模拟时间线（相对 T0）：首字节 180 → 首个数据块 220 → 首个 token 460
   * → answer 首个 token 1520 → 末字节 3200（error / abort 在中途结束）
   *
   * kind:
   * - success:  完整成功链路（start → 首字节 → 数据块 → token → 阶段 → complete）
   * - error:    结构化错误结束（默认 RATE_LIMIT，可用 error 参数自定义）
   * - abort:    用户中止
   * - usage:    成功 + token 用量与成本
   * - retry:    重试链路（本次 trace 带 previousTraceId 指向刚模拟的 trace）
   */
  simulateTrace(
    kind: 'success' | 'error' | 'abort' | 'usage' | 'retry',
    options: { model?: string; error?: TraceError } = {}
  ): string | null {
    const monitor = this.monitor
    if (!monitor) return null

    const model = options.model ?? 'deepseek-ai/DeepSeek-V3.2'
    let now = 1_000
    const trace = monitor.createTrace({
      aiMessageId: `demo_msg_${Date.now()}`,
      previousTraceId: kind === 'retry' ? (this.lastDemoTraceId ?? undefined) : undefined,
      model,
      provider: 'siliconflow',
      // 自控时钟：让同步的模拟也能给出真实形状的时间线
      now: () => now,
      // 模拟 Trace 不参与 Resource Timing 校准
      resourceEntries: () => [],
    })
    this.lastDemoTraceId = trace.traceId
    monitor.setCurrentTrace(trace)
    trace.start()

    trace.markRequestStart({ url: '/api/chat' })

    now += 180
    trace.firstByte() // TTFB = 180（首字节 / 响应头）

    now += 40
    trace.rawChunk(64) // FCL = 220（首个数据块）

    now += 240
    trace.firstToken('thinking') // TTFT = 460（首个 token）
    trace.phaseStart('thinking')
    trace.recordChunk()
    trace.phaseEnd('thinking')

    now += 60
    trace.phaseStart('answer')
    now += 1000
    trace.firstToken('answer') // TTFA = 1520（首个 answer token）
    for (let i = 0; i < 8; i += 1) {
      now += 100
      trace.recordChunk()
    }

    if (kind === 'error') {
      const err = options.error ?? {
        code: 'RATE_LIMIT' as const,
        message: '模拟：请求频率超限',
        statusCode: 429,
        retryable: true,
      }
      trace.phaseEnd('answer')
      now += 240
      trace.error(err)
      monitor.setCurrentTrace(null)
      return trace.traceId
    }

    if (kind === 'abort') {
      trace.phaseEnd('answer')
      now += 240
      trace.abort('user_cancel')
      monitor.setCurrentTrace(null)
      return trace.traceId
    }

    // success / usage：工具调用 + 用量 + 完成（时间线不随 kind 变化）
    trace.toolStart('web_search', { query: 'AI 监控' }, 'tool_demo_1')
    trace.toolEnd('web_search', { toolCallId: 'tool_demo_1', success: true, resultCount: 5 })
    trace.phaseEnd('answer')

    now += 180
    if (kind === 'usage') {
      trace.setUsage({ inputTokens: 1240, outputTokens: 860 })
    }

    now += 700
    trace.complete() // TTLB = 3200（末字节 / 流关闭）
    monitor.setCurrentTrace(null)
    return trace.traceId
  }

  /** 模拟用户行为事件（user_action） */
  simulateUserAction(action: string, detail?: Record<string, unknown>): void {
    this.monitor?.track('user_action', { action, ...detail })
  }

  private lastDemoTraceId: string | null = null

  // ==================== 队列桥接（透传 TransportPlugin） ====================

  async getQueueStatus(): Promise<{ pending: number; offline: number }> {
    return this.transport?.getQueueStatus() ?? { pending: 0, offline: 0 }
  }

  async flushQueue(): Promise<boolean> {
    if (!this.transport) return false
    return this.transport.flushQueue()
  }

  clearQueue(): void {
    this.transport?.clearQueue()
  }

  private get transport(): import('./transport').TransportPlugin | undefined {
    return this.monitor?.getPlugin<import('./transport').TransportPlugin>('transport')
  }
}

/**
 * Monitor - SDK 核心
 *
 * 职责：
 * - 插件管道：采集 → 处理 → 上报，按 priority 降序执行，插件与注册顺序解耦
 * - 事件入口：track() 统一构造事件信封并流经管道
 * - Trace / Session 一等 API：直接挂在 Monitor 上（不再动态注入，类型安全）
 * - 上下文注入：sessionId / traceId 自动写入事件 context
 */

import type { MonitorContext, MonitorEvent, MonitorOptions, Plugin, TraceOptions } from './types'
import { Trace } from './trace'
import { Session } from './session'
import { generateEventId } from './ids'

export class Monitor {
  readonly appId: string
  readonly debug: boolean

  private readonly plugins: Plugin[] = []
  private readonly context: MonitorContext
  private currentTrace: Trace | null = null
  private session: Session | null = null

  constructor(options: MonitorOptions) {
    this.appId = options.appId
    this.debug = options.debug ?? false
    this.context = { appId: options.appId, ...options.context }
  }

  // ==================== 插件管理 ====================

  /** 注册插件：调用 setup 并按 priority 降序排序（稳定排序，同优先级保持注册顺序） */
  use(plugin: Plugin): this {
    plugin.setup?.(this)
    this.plugins.push(plugin)
    this.plugins.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    return this
  }

  /** 按名称获取插件（调试面板等场景） */
  getPlugin<T extends Plugin>(name: string): T | undefined {
    return this.plugins.find((p) => p.name === name) as T | undefined
  }

  // ==================== 上下文 ====================

  setContext(partial: Record<string, unknown>): void {
    Object.assign(this.context, partial)
  }

  getContext(): MonitorContext {
    return { ...this.context }
  }

  // ==================== 事件入口 ====================

  /**
   * 事件入口：构造事件信封 → 注入上下文 → 流经插件管道。
   * 返回最终事件；被管道丢弃时返回 null。
   */
  track(type: string, data: Record<string, unknown> = {}): MonitorEvent | null {
    const event: MonitorEvent = {
      id: generateEventId(),
      type,
      timestamp: Date.now(),
      data,
      context: this.buildContext(),
    }

    if (this.debug) {
      console.debug(`[future-monitor-sdk] ${type}`, event)
    }

    let current: MonitorEvent | null = event
    for (const plugin of this.plugins) {
      if (!plugin.processEvent) continue
      try {
        const result = plugin.processEvent(current)
        if (result === null) return null
        current = result
      } catch (error) {
        // 插件异常不能影响主流程
        console.warn(`[future-monitor-sdk] plugin "${plugin.name}" error:`, error)
      }
    }
    return current
  }

  private buildContext(): MonitorContext {
    const context: MonitorContext = { ...this.context }
    if (this.session) context.sessionId = this.session.sessionId
    if (this.currentTrace) context.traceId = this.currentTrace.traceId
    return context
  }

  // ==================== Trace 一等 API ====================

  /** 创建 Trace（事件自动带 traceId 上下文） */
  createTrace(options: TraceOptions): Trace {
    return new Trace(options, (type, data) => {
      this.track(type, data)
    })
  }

  setCurrentTrace(trace: Trace | null): void {
    this.currentTrace = trace
  }

  getCurrentTrace(): Trace | null {
    return this.currentTrace
  }

  // ==================== Session 一等 API ====================

  /** 启动会话：发出 session_start 事件 */
  startSession(): Session {
    this.session = new Session()
    this.track('session_start', {
      sessionId: this.session.sessionId,
    })
    return this.session
  }

  /** 结束会话：发出 session_end 事件（携带聚合统计） */
  endSession(): void {
    if (!this.session) return
    const stats = this.session.getStats()
    this.track('session_end', {
      sessionId: stats.sessionId,
      traceCount: stats.traceCount,
      toolUsage: stats.toolUsage,
      isVisible: stats.isVisible,
    })
    this.session = null
  }

  getSession(): Session | null {
    return this.session
  }

  // ==================== 运维 ====================

  /** 刷新所有插件（强制上报缓冲数据） */
  async flush(): Promise<void> {
    for (const plugin of this.plugins) {
      try {
        await plugin.flush?.()
      } catch {
        // 忽略单个插件的刷新异常
      }
    }
  }

  /** 重置所有插件（卸载监听、清理状态） */
  reset(): void {
    for (const plugin of this.plugins) {
      try {
        plugin.reset?.()
      } catch {
        // 忽略
      }
    }
  }
}

/**
 * DebugPlugin - 调试插件（开发环境）
 *
 * 收集流经管道的事件（环形缓冲），向调试面板提供订阅/查询 API，
 * 并桥接 transport 插件的队列状态（待发送/离线/强制发送/清空）。
 *
 * 实例挂载在 window.__SKY_MONITOR_DEBUG__，供面板轮询发现。
 */

import type { MonitorEvent, Plugin } from '../core/types'
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

/**
 * DebugPlugin 兼容层
 *
 * 本地开发版 SDK 的 DebugPlugin 会把自己挂到 window.__SKY_MONITOR_DEBUG__，
 * 供调试面板订阅事件。npm 0.2.0 没有该插件，这里基于 Plugin 的 processEvent
 * 管道自实现：收集流过管道的所有事件，并提供面板需要的订阅/查询 API。
 *
 * 错误回溯（subscribeErrorReplay）和队列操作（flushQueue 等）在 0.2.0 中
 * 没有对应实现，提供空实现保证 UI 不报错。
 */

'use client'

import type { IMonitor, MonitorEvent, Plugin } from '@jerry_aurora/sky-monitor-sdk'
import type { ErrorReplayEvent, DebugPluginOptions } from './types'

const WINDOW_KEY = '__SKY_MONITOR_DEBUG__'

type EventListener = (event: MonitorEvent) => void

/** 兼容层 DebugPlugin（挂在 window.__SKY_MONITOR_DEBUG__ 上的实例） */
export class CompatDebugPlugin implements Plugin {
  name = 'debug'
  priority = 1

  private monitor: IMonitor | null = null
  private events: MonitorEvent[] = []
  private listeners = new Set<EventListener>()
  private readonly maxEvents: number

  constructor(options: DebugPluginOptions = {}) {
    this.maxEvents = options.maxEvents ?? 500
  }

  setupOnce(monitor: IMonitor): void {
    this.monitor = monitor

    // 挂载到 window 全局，供调试面板轮询发现
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>)[WINDOW_KEY] = this
    }
  }

  /** 事件管道：收集所有事件并通知订阅者 */
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

  // ========== 订阅 API ==========

  /** 订阅全部事件，返回取消订阅函数 */
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 订阅错误回溯事件（0.2.0 无错误回溯能力，空实现） */
  subscribeErrorReplay(_fn: (event: ErrorReplayEvent) => void): () => void {
    // 保留引用以便将来支持；当前无事件来源
    return () => {}
  }

  // ========== 查询 API ==========

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

  getErrorReplayEvents(): ErrorReplayEvent[] {
    return []
  }

  // ========== 操作 API ==========

  clearEvents(): void {
    this.events = []
  }

  /** 手动上报事件（测试触发用） */
  track(type: string, data?: Record<string, unknown>): void {
    this.monitor?.track(type, data)
  }

  // ========== 队列 API（0.2.0 无对应实现，空实现） ==========

  async getQueueStatus(): Promise<{ pending: number; offline: number }> {
    return { pending: 0, offline: 0 }
  }

  subscribeQueue(_fn: (status: { pending: number; offline: number }) => void): () => void {
    return () => {}
  }

  async flushQueue(): Promise<boolean> {
    return false
  }

  clearQueue(): void {
    // 无队列可清
  }
}

/** 卸载辅助：清理 window 全局（测试/热重载场景） */
export function resetDebugPlugin(): void {
  if (typeof window !== 'undefined') {
    delete (window as unknown as Record<string, unknown>)[WINDOW_KEY]
  }
}

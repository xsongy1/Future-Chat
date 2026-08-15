/**
 * Session 兼容插件
 *
 * 本地开发版 SDK 的 SessionPlugin 注入 startSession/endSession/getSession，
 * npm 0.2.0 的 SessionPlugin API 不同，这里按项目使用方式（MonitorProvider / trace-helper）自实现。
 */

import type { IMonitor, MonitorEvent, Plugin } from '@jerry_aurora/sky-monitor-sdk'
import { generateSessionId } from '@jerry_aurora/sky-monitor-sdk'

/** 会话对象（对齐项目使用的 API 面） */
export class CompatSession {
  readonly sessionId: string
  private startedAt: number
  private traceCount = 0
  private toolUsage: Record<string, number> = {}
  private visible = true

  constructor() {
    this.sessionId = generateSessionId()
    this.startedAt = Date.now()
  }

  incrementTraceCount(): void {
    this.traceCount += 1
  }

  incrementToolUsage(toolName: string): void {
    this.toolUsage[toolName] = (this.toolUsage[toolName] ?? 0) + 1
  }

  getStats(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      startTime: this.startedAt,
      traceCount: this.traceCount,
      toolUsage: this.toolUsage,
      isVisible: this.visible,
    }
  }
}

/** SessionPlugin 兼容层：在 Monitor 上注入 startSession/endSession/getSession */
export class CompatSessionPlugin implements Plugin {
  name = 'session'
  priority = 100

  private monitor: IMonitor | null = null
  private session: CompatSession | null = null

  setupOnce(monitor: IMonitor): void {
    this.monitor = monitor

    const injected = monitor as unknown as Record<string, unknown>

    injected.startSession = () => {
      if (!this.monitor) return
      this.session = new CompatSession()
      this.monitor.track('session_start', {
        sessionId: this.session.sessionId,
      })
    }

    injected.endSession = () => {
      if (!this.monitor || !this.session) return
      const stats = this.session.getStats()
      this.monitor.track('session_end', {
        sessionId: this.session.sessionId,
        traceCount: stats.traceCount,
        toolUsage: stats.toolUsage,
      })
      this.session = null
    }

    injected.getSession = () => this.session
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    return event
  }
}

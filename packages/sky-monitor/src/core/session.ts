/**
 * Session - 页面会话
 *
 * 聚合一次会话内的对话次数、工具使用分布、可见性等统计，
 * 结束时随 session_end 事件上报。
 */

import { generateSessionId } from './ids'

export interface SessionStats {
  sessionId: string
  startTime: number
  traceCount: number
  toolUsage: Record<string, number>
  isVisible: boolean
}

export class Session {
  readonly sessionId: string
  private readonly startedAt: number
  private traceCount = 0
  private toolUsage: Record<string, number> = {}
  private visible = true

  constructor() {
    this.sessionId = generateSessionId()
    this.startedAt = Date.now()
  }

  /** 对话次数 +1（每次 createTrace 时调用） */
  incrementTraceCount(): void {
    this.traceCount += 1
  }

  /** 工具使用次数 +1 */
  incrementToolUsage(toolName: string): void {
    this.toolUsage[toolName] = (this.toolUsage[toolName] ?? 0) + 1
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }

  getStats(): SessionStats {
    return {
      sessionId: this.sessionId,
      startTime: this.startedAt,
      traceCount: this.traceCount,
      toolUsage: { ...this.toolUsage },
      isVisible: this.visible,
    }
  }
}

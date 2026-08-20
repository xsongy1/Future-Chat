/**
 * DedupePlugin - 事件去重
 *
 * 同一类型 + 相同内容指纹的事件在窗口期内只保留第一条，
 * 防止错误风暴/重复上报打爆上报通道。
 */

import type { MonitorEvent, Plugin } from '../core/types'

export interface DedupePluginOptions {
  /** 去重窗口（ms），默认 5000 */
  windowMs?: number
}

interface DedupeEntry {
  key: string
  time: number
}

export class DedupePlugin implements Plugin {
  name = 'dedupe'
  priority = 100

  private readonly windowMs: number
  private entries: DedupeEntry[] = []

  constructor(options: DedupePluginOptions = {}) {
    this.windowMs = options.windowMs ?? 5000
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    const now = Date.now()

    // 清理过期条目
    this.entries = this.entries.filter((e) => now - e.time < this.windowMs)

    const key = `${event.type}:${fingerprint(event.data)}`
    if (this.entries.some((e) => e.key === key)) {
      return null
    }

    this.entries.push({ key, time: now })
    return event
  }

  reset(): void {
    this.entries = []
  }
}

/** 事件载荷指纹：稳定序列化（key 排序），截断避免超长 */
function fingerprint(data: Record<string, unknown>): string {
  try {
    const keys = Object.keys(data).sort()
    const parts = keys.map((k) => `${k}=${JSON.stringify(data[k])}`)
    return parts.join('&').slice(0, 200)
  } catch {
    return String(data)
  }
}

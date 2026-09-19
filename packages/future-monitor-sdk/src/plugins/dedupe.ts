/**
 * DedupePlugin - 事件去重
 *
 * 默认只对**错误类事件**做指纹去重（防错误风暴）：
 * 同一类型 + 相同内容指纹的事件在窗口期内只保留第一条。
 * 普通事件（http_request / web_vital / tool_end...）id 天然唯一、内容几乎不重复，
 * 直接放行，避免为每个事件做 JSON 序列化指纹的开销（管道热路径优化）。
 *
 * 可通过 types 选项自定义需要去重的事件类型集合。
 */

import type { MonitorEvent, Plugin } from '../core/types'

export interface DedupePluginOptions {
  /** 去重窗口（ms），默认 5000 */
  windowMs?: number
  /** 需要去重的事件类型；默认只对错误类（错误风暴防抖） */
  types?: string[]
}

interface DedupeEntry {
  key: string
  time: number
}

/** 默认去重范围：错误类事件 */
const DEFAULT_TYPES = [
  'js_error',
  'promise_error',
  'resource_error',
  'console_error',
  'sse_error',
]

export class DedupePlugin implements Plugin {
  name = 'dedupe'
  priority = 100

  private readonly windowMs: number
  private readonly types: string[]
  private entries: DedupeEntry[] = []

  constructor(options: DedupePluginOptions = {}) {
    this.windowMs = options.windowMs ?? 5000
    this.types = options.types ?? DEFAULT_TYPES
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    // 非去重目标类型：零开销放行（管道热路径）
    if (!this.types.includes(event.type)) {
      return event
    }

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

/**
 * 指纹里必须剔除的易变字段：Trace/Session 身份 + 时延与吞吐读数
 *
 * 这些字段每次请求都不同（同一错误重试两次，message/errorCode/statusCode 完全一致，
 * 但 traceId、duration、ttfb、chunkCount 必然不同）。留着它们会让"同内容错误"的指纹
 * 各不相同，去重形同虚设——而错误风暴正是 sse_error 最主要的重复来源。
 */
const VOLATILE_KEYS = new Set([
  'traceId',
  'sessionId',
  'duration',
  'ttfb',
  'ttfbSource',
  'firstChunkLatency',
  'ttft',
  'ttftPhase',
  'ttfa',
  'chunkCount',
  'rawChunkCount',
  'bytesReceived',
  'chunksPerSec',
  'tokensPerSec',
  'estimatedCost',
])

/** 事件载荷指纹：稳定序列化（剔除易变字段 + key 排序），截断避免超长 */
function fingerprint(data: Record<string, unknown>): string {
  try {
    const keys = Object.keys(data)
      .filter((k) => !VOLATILE_KEYS.has(k))
      .sort()
    const parts = keys.map((k) => `${k}=${JSON.stringify(data[k])}`)
    return parts.join('&').slice(0, 200)
  } catch {
    return String(data)
  }
}

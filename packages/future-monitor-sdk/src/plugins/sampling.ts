/**
 * SamplingPlugin - 采样
 *
 * - random：每个事件独立随机
 * - session：整个会话共用一个随机决策（同一会话内行为一致，便于聚合分析）
 * - typeRates：按事件类型覆盖默认采样率
 * - alwaysSample：关键事件（如错误）永远 100% 采样
 */

import type { MonitorEvent, Plugin } from '../core/types.js'

export type SamplingMode = 'random' | 'session'

export interface SamplingPluginOptions {
  /** 默认采样率 0-1，默认 1（全量） */
  rate?: number
  /** 采样模式，默认 random */
  mode?: SamplingMode
  /** 按事件类型的采样率覆盖 */
  typeRates?: Record<string, number>
  /** 始终采样的关键事件类型 */
  alwaysSample?: string[]
}

export class SamplingPlugin implements Plugin {
  name = 'sampling'
  priority = 50

  private readonly rate: number
  private readonly mode: SamplingMode
  private readonly typeRates: Record<string, number>
  private readonly alwaysSample: string[]
  private sessionDecision: boolean | null = null

  constructor(options: SamplingPluginOptions = {}) {
    this.rate = options.rate ?? 1
    this.mode = options.mode ?? 'random'
    this.typeRates = options.typeRates ?? {}
    this.alwaysSample = options.alwaysSample ?? []
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    if (this.alwaysSample.includes(event.type)) return event

    const rate = this.typeRates[event.type] ?? this.rate
    if (rate >= 1) return event
    if (rate <= 0) return null

    if (this.mode === 'session') {
      if (this.sessionDecision === null) {
        this.sessionDecision = Math.random() < rate
      }
      return this.sessionDecision ? event : null
    }

    return Math.random() < rate ? event : null
  }

  reset(): void {
    this.sessionDecision = null
  }
}

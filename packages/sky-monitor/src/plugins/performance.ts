/**
 * PerformancePlugin - 性能采集
 *
 * 通过 PerformanceObserver 采集 Web Vitals（FCP/LCP/CLS/INP），
 * 并上报页面导航时序（TTFB/DCL/LOAD）。
 */

import type { MonitorEvent, Plugin } from '../core/types'
import type { Monitor } from '../core/monitor'

// Chrome 专有 API 类型补充（lib.dom 未收录）
declare global {
  interface LayoutShift extends PerformanceEntry {
    value: number
    hadRecentInput: boolean
  }
}

export interface PerformancePluginOptions {
  /** 是否采集页面导航时序，默认 true */
  captureNavigation?: boolean
}

type VitalName = 'FCP' | 'LCP' | 'CLS' | 'INP'

export class PerformancePlugin implements Plugin {
  name = 'performance'
  priority = 200

  private readonly options: Required<PerformancePluginOptions>
  private monitor: Monitor | null = null
  private observers: PerformanceObserver[] = []
  private clsValue = 0

  constructor(options: PerformancePluginOptions = {}) {
    this.options = { captureNavigation: options.captureNavigation ?? true }
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return

    this.observeVital('paint', 'FCP', (entry) => entry.startTime)
    this.observeVital('largest-contentful-paint', 'LCP', (entry) => entry.startTime)
    this.observeVital('layout-shift', 'CLS', (entry) => {
      this.clsValue += (entry as LayoutShift).value
      return this.clsValue
    })
    this.observeVital('event', 'INP', (entry) => (entry as PerformanceEventTiming).duration)

    if (this.options.captureNavigation) {
      this.captureNavigation()
    }
  }

  reset(): void {
    for (const observer of this.observers) {
      observer.disconnect()
    }
    this.observers = []
    this.clsValue = 0
  }

  processEvent(_event: MonitorEvent): MonitorEvent | null {
    return _event
  }

  // ==================== 内部 ====================

  private observeVital(
    type: string,
    name: VitalName,
    getValue: (entry: PerformanceEntry) => number
  ): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value = getValue(entry)
          if (Number.isFinite(value)) {
            this.monitor?.track('web_vital', { name, value })
          }
        }
      })
      observer.observe({ type, buffered: true })
      this.observers.push(observer)
    } catch {
      // 当前浏览器不支持该指标类型时静默跳过
    }
  }

  private captureNavigation(): void {
    try {
      const entries = performance.getEntriesByType('navigation')
      const nav = entries[0] as PerformanceNavigationTiming | undefined
      if (!nav) return

      this.monitor?.track('page_loaded', {
        ttfb: nav.responseStart - nav.requestStart,
        domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
        load: nav.loadEventEnd - nav.startTime,
      })
    } catch {
      // 静默跳过
    }
  }
}

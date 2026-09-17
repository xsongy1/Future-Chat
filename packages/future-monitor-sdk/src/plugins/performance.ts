/**
 * PerformancePlugin - 性能采集
 *
 * 通过 PerformanceObserver 采集 Web Vitals（FCP/LCP/CLS/INP），
 * 并上报页面导航时序（TTFB/DCL/LOAD）。
 *
 * 累计型指标语义（CLS / INP）：
 * - CLS 是页面级累计值，偏移事件按 clsReportInterval 节流上报，页面隐藏时上报 final
 * - INP 是"最差交互"指标，交互事件按 inpReportInterval 节流上报最差值，
 *   页面隐藏时上报 final（符合 web-vitals 规范，避免事件风暴）
 */

import type { MonitorEvent, Plugin } from '../core/types.js'
import type { Monitor } from '../core/monitor.js'

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
  /** CLS 偏移事件节流间隔（ms），默认 5000；0 表示每次偏移都上报 */
  clsReportInterval?: number
  /** INP 交互事件节流间隔（ms），默认 5000；0 表示每次交互都上报 */
  inpReportInterval?: number
}

type VitalName = 'FCP' | 'LCP' | 'CLS' | 'INP'

export class PerformancePlugin implements Plugin {
  name = 'performance'
  priority = 200

  private readonly options: Required<PerformancePluginOptions>
  private monitor: Monitor | null = null
  private observers: PerformanceObserver[] = []
  private clsValue = 0
  private lastClsReportTime = 0
  private inpWorst = 0
  private lastInpReportTime = 0
  private visibilityHandler: (() => void) | null = null

  constructor(options: PerformancePluginOptions = {}) {
    this.options = {
      captureNavigation: options.captureNavigation ?? true,
      clsReportInterval: options.clsReportInterval ?? 5000,
      inpReportInterval: options.inpReportInterval ?? 5000,
    }
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return

    this.observeVital('paint', 'FCP', (entry) => entry.startTime)
    this.observeVital('largest-contentful-paint', 'LCP', (entry) => entry.startTime)
    this.observeCls()
    this.observeInp()

    if (this.options.captureNavigation) {
      this.captureNavigation()
    }

    // 页面隐藏时上报 CLS / INP 最终值（web-vitals 规范行为）
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this.reportCls(true)
          this.reportInp(true)
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
  }

  reset(): void {
    for (const observer of this.observers) {
      observer.disconnect()
    }
    this.observers = []
    this.clsValue = 0
    this.lastClsReportTime = 0
    this.inpWorst = 0
    this.lastInpReportTime = 0

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
  }

  processEvent(_event: MonitorEvent): MonitorEvent | null {
    return _event
  }

  // ==================== 查询（调试面板/测试用） ====================

  /** 当前 CLS 累计值与 INP 最差值（未发生时返回空对象） */
  getVitals(): { CLS?: number; INP?: number } {
    const vitals: { CLS?: number; INP?: number } = {}
    if (this.clsValue > 0) vitals.CLS = this.clsValue
    if (this.inpWorst > 0) vitals.INP = this.inpWorst
    return vitals
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

  /** CLS 专用采集：累计 + 节流上报（不走通用路径） */
  private observeCls(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.clsValue += (entry as LayoutShift).value
          this.reportCls(false)
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
      this.observers.push(observer)
    } catch {
      // 静默跳过
    }
  }

  /** INP 专用采集：记录最差交互 + 节流上报 */
  private observeInp(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const duration = (entry as PerformanceEventTiming).duration
          if (Number.isFinite(duration) && duration > this.inpWorst) {
            this.inpWorst = duration
            this.reportInp(false)
          }
        }
      })
      observer.observe({ type: 'event', buffered: true })
      this.observers.push(observer)
    } catch {
      // 静默跳过
    }
  }

  /**
   * 上报 CLS：
   * - final=true：页面隐藏时的最终值，不受节流限制
   * - final=false：偏移时的中间值，按 clsReportInterval 节流
   */
  private reportCls(final: boolean): void {
    if (this.clsValue === 0) return
    const now = Date.now()
    if (!final && now - this.lastClsReportTime < this.options.clsReportInterval) return
    this.lastClsReportTime = now
    this.monitor?.track('web_vital', {
      name: 'CLS',
      value: this.clsValue,
      final,
    })
  }

  /**
   * 上报 INP：与 CLS 同模式（最差值 + 节流 + hidden final）
   */
  private reportInp(final: boolean): void {
    if (this.inpWorst === 0) return
    const now = Date.now()
    if (!final && now - this.lastInpReportTime < this.options.inpReportInterval) return
    this.lastInpReportTime = now
    this.monitor?.track('web_vital', {
      name: 'INP',
      value: this.inpWorst,
      final,
    })
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

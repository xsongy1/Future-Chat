/**
 * PerformancePlugin 单测：CLS 累计语义 / 节流 / 页面隐藏最终上报
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import { PerformancePlugin } from '../src/plugins/performance'
import type { Plugin, MonitorEvent } from '../src/core/types'

/** 收集事件的测试插件 */
class CollectorPlugin implements Plugin {
  name = 'collector'
  priority = -1
  events: MonitorEvent[] = []

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.events.push(event)
    return event
  }
}

/** 测试访问私有成员 */
type ClsHarness = {
  clsValue: number
  reportCls: (final: boolean) => void
  inpWorst: number
  reportInp: (final: boolean) => void
}

function setup(options: ConstructorParameters<typeof PerformancePlugin>[0] = {}) {
  const monitor = new Monitor({ appId: 'test-app' })
  const collector = new CollectorPlugin()
  const plugin = new PerformancePlugin(options)
  monitor.use(plugin)
  monitor.use(collector)
  return { monitor, collector, plugin: plugin as unknown as PerformancePlugin & ClsHarness }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PerformancePlugin CLS 上报', () => {
  it('页面隐藏时上报最终 CLS（final: true）', () => {
    const { collector, plugin } = setup()
    plugin.clsValue = 0.42

    plugin.reportCls(true)

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(1)
    expect(vitals[0].data).toMatchObject({ name: 'CLS', value: 0.42, final: true })
  })

  it('偏移中间值默认节流：5s 内只报一条，且携带最新累计值', () => {
    const { collector, plugin } = setup()

    plugin.clsValue = 0.1
    plugin.reportCls(false) // t=0 上报
    plugin.clsValue = 0.2
    plugin.reportCls(false) // 5s 内 → 被节流
    expect(collector.events.filter((e) => e.type === 'web_vital')).toHaveLength(1)

    vi.advanceTimersByTime(6000)
    plugin.clsValue = 0.3
    plugin.reportCls(false) // 节流窗口已过 → 上报最新累计值

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(2)
    expect(vitals[1].data.value).toBe(0.3)
  })

  it('final 上报不受节流限制', () => {
    const { collector, plugin } = setup()

    plugin.clsValue = 0.1
    plugin.reportCls(false) // t=0
    plugin.reportCls(true) // 立即上报最终值，不受节流影响

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(2)
    expect(vitals[1].data.final).toBe(true)
  })

  it('未发生偏移不产生 CLS 事件', () => {
    const { collector, plugin } = setup()

    plugin.reportCls(true)

    expect(collector.events).toHaveLength(0)
  })

  it('clsReportInterval=0 时每次偏移都上报', () => {
    const { collector, plugin } = setup({ clsReportInterval: 0 })

    plugin.clsValue = 0.1
    plugin.reportCls(false)
    plugin.clsValue = 0.2
    plugin.reportCls(false)

    expect(collector.events.filter((e) => e.type === 'web_vital')).toHaveLength(2)
  })
})

describe('PerformancePlugin INP 上报', () => {
  it('上报当前最差值', () => {
    const { collector, plugin } = setup()

    plugin.inpWorst = 320
    plugin.reportInp(false)

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(1)
    expect(vitals[0].data).toMatchObject({ name: 'INP', value: 320 })
  })

  it('INP 默认节流：5s 内只报一条，且携带最新最差值', () => {
    const { collector, plugin } = setup()

    plugin.inpWorst = 150
    plugin.reportInp(false) // t=0 上报
    plugin.inpWorst = 320
    plugin.reportInp(false) // 5s 内 → 节流
    expect(collector.events.filter((e) => e.type === 'web_vital')).toHaveLength(1)

    vi.advanceTimersByTime(6000)
    plugin.reportInp(false) // 节流窗口已过 → 上报最新最差值

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(2)
    expect(vitals[1].data.value).toBe(320)
  })

  it('页面隐藏时上报 INP 最终值（final: true，不受节流限制）', () => {
    const { collector, plugin } = setup()

    plugin.inpWorst = 180
    plugin.reportInp(false) // t=0
    plugin.reportInp(true) // 立即上报最终值

    const vitals = collector.events.filter((e) => e.type === 'web_vital')
    expect(vitals).toHaveLength(2)
    expect(vitals[1].data).toMatchObject({ name: 'INP', value: 180, final: true })
  })

  it('无交互不产生 INP 事件', () => {
    const { collector, plugin } = setup()

    plugin.reportInp(true)

    expect(collector.events).toHaveLength(0)
  })
})

describe('PerformancePlugin 查询', () => {
  it('getVitals 返回 CLS 与 INP，未发生时为空', () => {
    const { plugin } = setup()

    expect(plugin.getVitals()).toEqual({})

    plugin.clsValue = 0.808
    plugin.inpWorst = 240
    expect(plugin.getVitals()).toEqual({ CLS: 0.808, INP: 240 })
  })
})

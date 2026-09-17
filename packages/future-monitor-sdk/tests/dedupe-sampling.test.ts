/**
 * DedupePlugin / SamplingPlugin 单测
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import { DedupePlugin } from '../src/plugins/dedupe'
import { SamplingPlugin } from '../src/plugins/sampling'
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DedupePlugin', () => {
  it('窗口内相同事件只保留第一条', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 5000 }))
    monitor.use(collector)

    monitor.track('js_error', { message: 'boom' })
    monitor.track('js_error', { message: 'boom' })
    monitor.track('js_error', { message: 'boom' })

    expect(collector.events).toHaveLength(1)
  })

  it('不同内容的事件不受影响', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 5000 }))
    monitor.use(collector)

    monitor.track('js_error', { message: 'boom' })
    monitor.track('js_error', { message: 'different' })
    monitor.track('http_request', { message: 'boom' })

    expect(collector.events).toHaveLength(3)
  })

  it('窗口过期后相同事件可再次通过', () => {
    vi.useFakeTimers()
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 1000 }))
    monitor.use(collector)

    monitor.track('js_error', { message: 'boom' })
    vi.advanceTimersByTime(1500)
    monitor.track('js_error', { message: 'boom' })

    expect(collector.events).toHaveLength(2)
    vi.useRealTimers()
  })

  it('非错误类事件不做指纹去重（管道热路径零开销）', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 5000 }))
    monitor.use(collector)

    // http_request / web_vital 等普通事件内容相同也不去重（id 天然唯一）
    monitor.track('http_request', { url: '/api/chat', duration: 100 })
    monitor.track('http_request', { url: '/api/chat', duration: 100 })
    monitor.track('web_vital', { name: 'LCP', value: 2000 })

    expect(collector.events).toHaveLength(3)
  })

  it('types 选项可自定义去重范围', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 5000, types: ['http_request'] }))
    monitor.use(collector)

    monitor.track('http_request', { url: '/api/chat', duration: 100 })
    monitor.track('http_request', { url: '/api/chat', duration: 100 })
    monitor.track('js_error', { message: 'boom' })
    monitor.track('js_error', { message: 'boom' })

    // http_request 被去重为 1 条，js_error 不在自定义范围内 → 2 条
    expect(collector.events).toHaveLength(3)
  })
})

describe('SamplingPlugin', () => {
  it('rate=1 全量采样，rate=0 全部丢弃', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new SamplingPlugin({ rate: 1 }))
    monitor.use(collector)

    monitor.track('a', {})
    monitor.track('b', {})
    expect(collector.events).toHaveLength(2)

    collector.events = []
    monitor.use(new SamplingPlugin({ rate: 0 }))
    monitor.track('a', {})
    expect(collector.events).toHaveLength(0)
  })

  it('alwaysSample 事件在低采样率下仍然 100% 上报', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(
      new SamplingPlugin({
        rate: 0,
        alwaysSample: ['js_error'],
      })
    )
    monitor.use(collector)

    monitor.track('js_error', { message: 'critical' })
    monitor.track('custom_event', {})

    expect(collector.events.map((e) => e.type)).toEqual(['js_error'])
  })

  it('typeRates 按类型覆盖默认采样率', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(
      new SamplingPlugin({
        rate: 0,
        typeRates: { web_vital: 1 },
      })
    )
    monitor.use(collector)

    monitor.track('web_vital', { name: 'LCP' })
    monitor.track('custom_event', {})

    expect(collector.events.map((e) => e.type)).toEqual(['web_vital'])
  })

  it('session 模式：同一会话内采样决策一致', () => {
    // Math.random 固定返回 0.05 → 采样率 0.1 判定为「采样」
    vi.spyOn(Math, 'random').mockReturnValue(0.05)

    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new SamplingPlugin({ rate: 0.1, mode: 'session' }))
    monitor.use(collector)

    monitor.track('a', {})
    monitor.track('b', {})
    monitor.track('c', {})

    // 整个会话要么全采要么全不采；这里决策为采样 → 全部通过
    expect(collector.events).toHaveLength(3)
  })

  it('session 模式：判定为不采样时整会话丢弃', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.95)

    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(new SamplingPlugin({ rate: 0.1, mode: 'session' }))
    monitor.use(collector)

    monitor.track('a', {})
    monitor.track('b', {})

    expect(collector.events).toHaveLength(0)
  })
})

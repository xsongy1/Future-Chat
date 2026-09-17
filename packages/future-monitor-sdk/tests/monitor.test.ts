/**
 * Monitor 核心单测：插件管道 / 事件信封 / 上下文注入 / Trace/Session API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import type { MonitorEvent, Plugin } from '../src/core/types'

/** 测试用采集插件：记录流经管道的事件 */
class CollectorPlugin implements Plugin {
  name = 'collector'
  priority = 0
  events: MonitorEvent[] = []
  setupCalls = 0

  setup(): void {
    this.setupCalls += 1
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.events.push(event)
    return event
  }
}

/** 测试用顺序记录插件 */
class OrderPlugin implements Plugin {
  constructor(
    public name: string,
    public priority: number,
    private order: string[]
  ) {}

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.order.push(this.name)
    return event
  }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Monitor 插件管道', () => {
  it('track() 产出完整事件信封（id/type/timestamp/data/context）', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(collector)

    const event = monitor.track('custom_event', { foo: 'bar' })

    expect(event).not.toBeNull()
    expect(event!.type).toBe('custom_event')
    expect(event!.data).toEqual({ foo: 'bar' })
    expect(event!.context.appId).toBe('test-app')
    expect(event!.id).toMatch(/^evt_/)
    expect(typeof event!.timestamp).toBe('number')
    expect(collector.events).toHaveLength(1)
  })

  it('插件按 priority 降序执行，与注册顺序无关', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const order: string[] = []

    monitor.use(new OrderPlugin('low', 10, order))
    monitor.use(new OrderPlugin('high', 100, order))
    monitor.use(new OrderPlugin('mid', 50, order))

    monitor.track('test', {})

    expect(order).toEqual(['high', 'mid', 'low'])
  })

  it('插件返回 null 时事件被丢弃，后续插件不再执行', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const order: string[] = []

    const dropper: Plugin = {
      name: 'dropper',
      priority: 100,
      processEvent: () => null,
    }
    monitor.use(dropper)
    monitor.use(new OrderPlugin('after', 0, order))

    const result = monitor.track('test', {})

    expect(result).toBeNull()
    expect(order).toEqual([])
  })

  it('插件抛异常不影响管道主流程', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()

    const badPlugin: Plugin = {
      name: 'bad',
      priority: 100,
      processEvent: () => {
        throw new Error('boom')
      },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    monitor.use(badPlugin)
    monitor.use(collector)

    const result = monitor.track('test', {})

    expect(result).not.toBeNull()
    expect(collector.events).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('use() 时调用 setup 并可通过 getPlugin() 取回', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(collector)

    expect(collector.setupCalls).toBe(1)
    expect(monitor.getPlugin<CollectorPlugin>('collector')).toBe(collector)
    expect(monitor.getPlugin('not-exist')).toBeUndefined()
  })
})

describe('Monitor 上下文', () => {
  it('setContext 后新事件携带扩展上下文', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.setContext({ userId: 'user_1', version: '1.0.0' })

    const event = monitor.track('test', {})

    expect(event!.context.userId).toBe('user_1')
    expect(event!.context.version).toBe('1.0.0')
  })

  it('会话与 Trace 激活时自动注入 sessionId / traceId', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const session = monitor.startSession()
    const trace = monitor.createTrace({ aiMessageId: 'msg_1' })
    monitor.setCurrentTrace(trace)

    const event = monitor.track('test', {})

    expect(event!.context.sessionId).toBe(session.sessionId)
    expect(event!.context.traceId).toBe(trace.traceId)
  })
})

describe('Monitor Trace/Session 一等 API', () => {
  it('createTrace/setCurrentTrace/getCurrentTrace 类型安全往返', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    expect(monitor.getCurrentTrace()).toBeNull()

    const trace = monitor.createTrace({ aiMessageId: 'msg_1', previousTraceId: 'trc_prev' })
    monitor.setCurrentTrace(trace)

    expect(monitor.getCurrentTrace()).toBe(trace)
    expect(trace.aiMessageId).toBe('msg_1')
    expect(trace.previousTraceId).toBe('trc_prev')

    monitor.setCurrentTrace(null)
    expect(monitor.getCurrentTrace()).toBeNull()
  })

  it('startSession/endSession 生命周期与统计', () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()
    monitor.use(collector)

    const session = monitor.startSession()
    expect(monitor.getSession()).toBe(session)

    session.incrementTraceCount()
    session.incrementToolUsage('web_search')

    monitor.endSession()

    expect(monitor.getSession()).toBeNull()
    const types = collector.events.map((e) => e.type)
    expect(types).toEqual(['session_start', 'session_end'])

    const endEvent = collector.events[1]
    expect(endEvent.data.traceCount).toBe(1)
    expect(endEvent.data.toolUsage).toEqual({ web_search: 1 })
  })
})

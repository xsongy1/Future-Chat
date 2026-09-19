/**
 * 回归测试：每条用例对应审计中发现并修复的一个缺陷（修复前均为失败状态）
 *
 * 覆盖：
 * - Monitor: use() 先入管道再 setup / 重复 use 幂等 / setup 抛错回滚 / reset 清空管道
 * - Session: setSessionVisible → session_visibility
 * - Trace: 连续超阈值间隔不再误报 sse_resume
 * - Dedupe: 易变字段不参与指纹，同内容错误可去重
 * - Cost: matchedKey 为命中的价目表 key
 * - ErrorPlugin: g flag 忽略规则稳定 + 重复 setup 幂等
 * - NetworkPlugin: XHR 复用不重复上报 + 重复 setup 不二次包装 fetch
 * - PerformancePlugin: CLS 过滤 hadRecentInput / INP 过滤非交互 / load 前不报 0 / 导航时序延后采集
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import { Trace } from '../src/core/trace'
import { estimateCost, getModelPrice, MODEL_PRICES } from '../src/core/cost'
import { DedupePlugin } from '../src/plugins/dedupe'
import { ErrorPlugin } from '../src/plugins/error'
import { NetworkPlugin } from '../src/plugins/network'
import { PerformancePlugin } from '../src/plugins/performance'
import { TransportPlugin } from '../src/plugins/transport'
import type { MonitorEvent, Plugin } from '../src/core/types'

/** 采集插件：记录流经管道的事件与生命周期调用次数 */
class CollectorPlugin implements Plugin {
  name = 'collector'
  priority = -100
  events: MonitorEvent[] = []
  setupCalls = 0
  resetCalls = 0

  setup(): void {
    this.setupCalls += 1
  }

  reset(): void {
    this.resetCalls += 1
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.events.push(event)
    return event
  }

  types(): string[] {
    return this.events.map((e) => e.type)
  }
}

// ==================== 环境桩 ====================

type Listener = (event?: unknown) => void

/** 最小 window / document 桩：记录监听器注册与移除，便于断言幂等与清理 */
class FakeTarget {
  /** ErrorPlugin 会读 window.location.href */
  location = { href: 'http://localhost/' }
  private added: Array<{ type: string; fn: Listener; capture: boolean }> = []
  private removed: Array<{ type: string; fn: Listener }> = []

  addEventListener = (type: string, fn: Listener, options?: unknown): void => {
    const capture =
      options === true ||
      (typeof options === 'object' &&
        options !== null &&
        (options as { capture?: boolean }).capture === true)
    this.added.push({ type, fn, capture })
  }

  removeEventListener = (type: string, fn: Listener): void => {
    this.removed.push({ type, fn })
  }

  /** 当前仍然挂着的监听器数量 */
  count(type: string, capture?: boolean): number {
    const live = this.added.filter(
      (a) => a.type === type && (capture === undefined || a.capture === capture)
    )
    for (const r of this.removed) {
      const i = live.findIndex((a) => a.type === r.type && a.fn === r.fn)
      if (i >= 0) live.splice(i, 1)
    }
    return live.length
  }

  private liveListeners(type: string, captureOnly: boolean): Listener[] {
    return this.added
      .filter(
        (a) =>
          a.type === type &&
          a.capture === captureOnly &&
          !this.removed.some((r) => r.type === type && r.fn === a.fn)
      )
      .map((a) => a.fn)
  }

  /** 触发冒泡阶段监听器（把 this 绑回 target，与浏览器一致） */
  fire(type: string, payload?: unknown): void {
    for (const fn of this.liveListeners(type, false)) fn.call(this, payload ?? { type })
  }

  /** 触发捕获阶段监听器（资源加载错误不会冒泡，只走捕获） */
  fireCapture(type: string, payload?: unknown): void {
    for (const fn of this.liveListeners(type, true)) fn.call(this, payload ?? { type })
  }
}

/** PerformanceObserver 桩：可取出某类型对应的回调并手动喂条目 */
class FakeObserver {
  static instances: FakeObserver[] = []
  types: string[] = []

  constructor(public cb: (list: { getEntries: () => unknown[] }) => void) {
    FakeObserver.instances.push(this)
  }

  observe(options: { type: string }): void {
    this.types.push(options.type)
  }

  disconnect(): void {}

  takeRecords(): unknown[] {
    return []
  }

  static of(type: string): FakeObserver {
    const found = FakeObserver.instances.find((o) => o.types.includes(type))
    if (!found) throw new Error(`no observer for ${type}`)
    return found
  }

  static reset(): void {
    FakeObserver.instances = []
  }
}

/** XHR 桩：listeners 用 Map 保存，便于验证复用同一实例时的监听器清理 */
class FakeXHR {
  status = 200
  private listeners = new Map<string, Listener[]>()

  open(_method: string, _url: string | URL, _async?: boolean): void {}

  send(): void {}

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((f) => f !== fn)
    )
  }

  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn.call(this, { type })
    }
  }
}

const realPerformance = globalThis.performance

/** window 桩 + fetch：NetworkPlugin.setup 一定会 bind window.fetch */
type WindowWithFetch = FakeTarget & { fetch: typeof fetch }

function makeWindowWithFetch(): WindowWithFetch {
  const target = new FakeTarget() as WindowWithFetch
  target.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch
  return target
}

function stubGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const key of ['window', 'document', 'XMLHttpRequest', 'PerformanceObserver']) {
    Reflect.deleteProperty(globalThis, key)
  }
  stubGlobal('performance', realPerformance)
  FakeObserver.reset()
})

// ==================== Monitor ====================

describe('Monitor.use / reset 回归', () => {
  it('use() 先入管道再 setup：setup 内同步发出的事件连插件自己也能收到', () => {
    const self: Plugin & { seen: string[] } = {
      name: 'self',
      priority: 0,
      seen: [],
      setup(monitor: Monitor) {
        monitor.track('from_setup', {})
      },
      processEvent(event: MonitorEvent) {
        self.seen.push(event.type)
        return event
      },
    }

    const monitor = new Monitor({ appId: 'a' })
    monitor.use(self)

    expect(self.seen).toEqual(['from_setup'])
  })

  it('同一实例重复 use 不会重复入管道（processEvent 只调一次）', () => {
    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()

    monitor.use(collector)
    monitor.use(collector)
    monitor.track('custom_test', {})

    expect(collector.events).toHaveLength(1)
  })

  it('setup 抛错时不注册该插件，异常照旧抛出', () => {
    const monitor = new Monitor({ appId: 'a' })
    const bad: Plugin = {
      name: 'bad',
      setup() {
        throw new Error('boom')
      },
      processEvent: (event) => event,
    }

    expect(() => monitor.use(bad)).toThrow('boom')
    expect(monitor.getPlugin('bad')).toBeUndefined()
  })

  it('reset() 清空管道与 Trace/Session 上下文，重新 use() 即恢复', () => {
    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    monitor.use(collector)
    monitor.startSession()
    monitor.setCurrentTrace(monitor.createTrace({ aiMessageId: 'msg_1' }))

    const beforeReset = collector.events.length
    monitor.reset()

    expect(collector.resetCalls).toBe(1)
    expect(monitor.getPlugin('collector')).toBeUndefined()
    expect(monitor.getSession()).toBeNull()
    expect(monitor.getCurrentTrace()).toBeNull()

    const event = monitor.track('custom_test', {})
    expect(collector.events).toHaveLength(beforeReset) // 事件不再流经已卸载的插件
    expect(event?.context.sessionId).toBeUndefined()
    expect(event?.context.traceId).toBeUndefined()

    monitor.use(collector)
    expect(collector.setupCalls).toBe(2)
    monitor.track('custom_test', {})
    expect(collector.events).toHaveLength(beforeReset + 1)
  })

  it('reset() 之后批处理通道不再静默积压（需重新 use 才上报）', async () => {
    vi.useFakeTimers()
    const sent: MonitorEvent[][] = []
    const plugin = new TransportPlugin({
      endpoint: '/api/monitor',
      transport: {
        send: async (events) => {
          sent.push(events)
          return true
        },
      },
      batchSize: 10,
      flushInterval: 1000,
    })
    const monitor = new Monitor({ appId: 'a' })
    monitor.use(plugin)

    monitor.reset()
    monitor.track('custom_test', { n: 1 })
    await vi.advanceTimersByTimeAsync(5000)

    expect(sent).toHaveLength(0)
    expect(plugin.getQueueStatus().pending).toBe(0)

    monitor.use(plugin)
    monitor.track('custom_test', { n: 2 })
    await vi.advanceTimersByTimeAsync(1500)

    expect(sent).toHaveLength(1)
  })

  it('setSessionVisible 发出 session_visibility，并写入 session_end.isVisible', () => {
    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    monitor.use(collector)

    monitor.startSession()
    monitor.setSessionVisible(false)

    const visibility = collector.events.find((e) => e.type === 'session_visibility')
    expect(visibility?.data.visible).toBe(false)

    monitor.endSession()
    expect(collector.events.find((e) => e.type === 'session_end')?.data.isVisible).toBe(false)
  })

  it('无会话时 setSessionVisible 静默忽略', () => {
    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    monitor.use(collector)

    monitor.setSessionVisible(false)
    expect(collector.events).toHaveLength(0)
  })
})

// ==================== Trace 卡顿 ====================

describe('Trace 卡顿检测回归', () => {
  it('连续两个超阈值间隔仍算卡顿，不会误报 sse_resume', () => {
    let now = 0
    const types: string[] = []
    const trace = new Trace(
      { aiMessageId: 'msg_1', stallThreshold: 3000, now: () => now },
      (type) => types.push(type)
    )

    trace.start()
    trace.recordChunk() // t=0
    now = 4000
    trace.recordChunk() // gap=4000 → stall
    now = 9000
    trace.recordChunk() // gap=5000，仍在卡顿
    expect(types.filter((t) => t === 'sse_stall')).toHaveLength(1)
    expect(types.filter((t) => t === 'sse_resume')).toHaveLength(0)

    now = 9500
    trace.recordChunk() // gap=500 → 真正恢复
    expect(types.filter((t) => t === 'sse_resume')).toHaveLength(1)
  })
})

// ==================== 去重 ====================

describe('DedupePlugin 指纹回归', () => {
  function trackTwice(second: Record<string, unknown>): MonitorEvent[] {
    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    monitor.use(new DedupePlugin({ windowMs: 60_000 }))
    monitor.use(collector)

    const base = {
      message: 'Upstream timeout',
      errorCode: 'TIMEOUT',
      statusCode: 504,
      retryable: true,
    }
    monitor.track('sse_error', {
      ...base,
      traceId: 'trc_1',
      ttfb: 180,
      firstChunkLatency: 220,
      duration: 3200,
      chunkCount: 12,
    })
    monitor.track('sse_error', { ...base, ...second })
    return collector.events.filter((e) => e.type === 'sse_error')
  }

  it('窗口内同内容错误被去重（traceId / 时延等易变字段不参与指纹）', () => {
    const events = trackTwice({
      traceId: 'trc_2',
      ttfb: 191,
      firstChunkLatency: 233,
      duration: 3310,
      chunkCount: 13,
    })
    expect(events).toHaveLength(1)
  })

  it('内容不同的错误仍各自上报（不误伤）', () => {
    const events = trackTwice({
      message: 'Model overloaded',
      traceId: 'trc_2',
      ttfb: 191,
      firstChunkLatency: 233,
      duration: 3310,
      chunkCount: 13,
    })
    expect(events).toHaveLength(2)
  })
})

// ==================== 成本 ====================

describe('成本 matchedKey 回归', () => {
  it('前缀命中时 matchedKey 是命中的价目表 key，而不是入参 model', () => {
    const cost = estimateCost('gpt-4o-2024-08-06', 1_000_000, 0)

    expect(cost).not.toBeNull()
    expect(cost!.matchedKey).toBe('gpt-4o')
    expect(cost!.price).toEqual(MODEL_PRICES['gpt-4o'])
    expect(cost!.estimatedCost).toBeCloseTo(2.5, 6)
    expect(getModelPrice('gpt-4o-2024-08-06')).toEqual(MODEL_PRICES['gpt-4o'])
  })

  it('精确命中时 matchedKey 就是入参 model', () => {
    const cost = estimateCost('gpt-4o', 1_000_000, 1_000_000)
    expect(cost!.matchedKey).toBe('gpt-4o')
  })
})

// ==================== ErrorPlugin ====================

describe('ErrorPlugin 回归', () => {
  function setupErrorPlugin(options: ConstructorParameters<typeof ErrorPlugin>[0]) {
    const windowStub = new FakeTarget()
    stubGlobal('window', windowStub)

    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    const plugin = new ErrorPlugin(options)
    monitor.use(plugin)
    monitor.use(collector)
    return { windowStub, monitor, collector, plugin }
  }

  const jsError = {
    defaultPrevented: false,
    message: 'Failed to fetch chunk',
    filename: 'http://localhost/app.js',
    lineno: 1,
    colno: 1,
    error: undefined,
  }

  it('带 g flag 的 ignoreErrors 稳定生效（不再隔次漏过）', () => {
    const { windowStub, collector } = setupErrorPlugin({
      ignoreErrors: [/Failed to fetch/g],
      dedupeWindow: 0,
    })

    for (let i = 0; i < 4; i += 1) windowStub.fire('error', jsError)

    expect(collector.events.filter((e) => e.type === 'js_error')).toHaveLength(0)
  })

  it('带 g flag 的 ignoreUrls 对资源错误稳定生效，未命中的照旧上报', () => {
    const { windowStub, collector } = setupErrorPlugin({
      ignoreUrls: [/\.js$/g],
      dedupeWindow: 0,
    })

    for (let i = 0; i < 3; i += 1) {
      windowStub.fireCapture('error', {
        target: { tagName: 'SCRIPT', src: 'http://localhost/a.js' },
      })
    }
    expect(collector.events.filter((e) => e.type === 'resource_error')).toHaveLength(0)

    windowStub.fireCapture('error', {
      target: { tagName: 'IMG', src: 'http://localhost/a.png' },
    })
    expect(collector.events.filter((e) => e.type === 'resource_error')).toHaveLength(1)
  })

  it('重复 setup 不会重复挂监听、也不会二次包装 console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { windowStub, monitor, collector, plugin } = setupErrorPlugin({
      captureConsoleError: true,
    })

    plugin.setup(monitor) // 模拟同一实例被重复 use

    expect(windowStub.count('error')).toBe(2) // handleError + handleResourceError
    expect(windowStub.count('unhandledrejection')).toBe(1)

    console.error('boom')
    expect(collector.events.filter((e) => e.type === 'console_error')).toHaveLength(1)

    plugin.reset()
    expect(windowStub.count('error')).toBe(0)
    expect(windowStub.count('unhandledrejection')).toBe(0)
    errorSpy.mockRestore()
  })
})

// ==================== NetworkPlugin ====================

describe('NetworkPlugin 回归', () => {
  it('XHR 复用同一实例时不重复上报、URL 不串味', () => {
    stubGlobal('XMLHttpRequest', FakeXHR)
    stubGlobal('window', makeWindowWithFetch())

    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    monitor.use(new NetworkPlugin())
    monitor.use(collector)

    const xhr = new FakeXHR()
    xhr.open('GET', '/api/one')
    xhr.send()
    xhr.fire('loadend')

    xhr.open('GET', '/api/two') // 复用同一对象
    xhr.send()
    xhr.fire('loadend')

    const urls = collector.events
      .filter((e) => e.type === 'http_request')
      .map((e) => e.data.url)
    expect(urls).toEqual(['/api/one', '/api/two'])
  })

  it('重复 setup 不会二次包装 fetch（请求不被双计数）', async () => {
    const windowStub = makeWindowWithFetch()
    stubGlobal('window', windowStub)

    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    const plugin = new NetworkPlugin()
    monitor.use(plugin)
    plugin.setup(monitor) // 模拟同一实例被重复 use
    monitor.use(collector)

    await windowStub.fetch('/api/one')

    expect(collector.events.filter((e) => e.type === 'http_request')).toHaveLength(1)
  })
})

// ==================== PerformancePlugin ====================

describe('PerformancePlugin 回归', () => {
  function navigationEntry(loadEventEnd: number) {
    return {
      startTime: 0,
      requestStart: 20,
      responseStart: 120,
      domContentLoadedEventEnd: 900,
      loadEventEnd,
    }
  }

  function setupPerf(
    options: ConstructorParameters<typeof PerformancePlugin>[0] = {},
    nav = navigationEntry(1500)
  ) {
    FakeObserver.reset()
    const windowStub = new FakeTarget()
    const documentStub = new FakeTarget()
    stubGlobal('window', windowStub)
    stubGlobal('document', documentStub)
    stubGlobal('PerformanceObserver', FakeObserver)
    stubGlobal('performance', {
      now: () => 0,
      getEntriesByType: (type: string) => (type === 'navigation' ? [nav] : []),
    })

    const monitor = new Monitor({ appId: 'a' })
    const collector = new CollectorPlugin()
    const plugin = new PerformancePlugin(options)
    monitor.use(plugin)
    monitor.use(collector)
    return { monitor, collector, plugin, windowStub, documentStub, nav }
  }

  it('hadRecentInput 的布局偏移不计入 CLS', () => {
    const { plugin } = setupPerf({ captureNavigation: false })

    FakeObserver.of('layout-shift').cb({
      getEntries: () => [
        { value: 0.25, hadRecentInput: true, startTime: 100 },
        { value: 0.1, hadRecentInput: false, startTime: 200 },
      ],
    })

    expect(plugin.getVitals().CLS).toBeCloseTo(0.1, 6)
  })

  it('非交互事件（interactionId 为 0）不计入 INP', () => {
    const { plugin } = setupPerf({ captureNavigation: false })

    FakeObserver.of('event').cb({
      getEntries: () => [
        { duration: 640, interactionId: 0, name: 'mousemove' },
        { duration: 320, interactionId: 7, name: 'click' },
      ],
    })

    expect(plugin.getVitals().INP).toBe(320)
  })

  it('load 未触发时不上报 page_loaded，load 触发后报真实读数', async () => {
    vi.useFakeTimers()
    // 初始 loadEventEnd = 0：模拟 SDK 在 load 之前初始化
    const { collector, windowStub, nav } = setupPerf({}, navigationEntry(0))

    await vi.advanceTimersByTimeAsync(10)
    expect(collector.events.filter((e) => e.type === 'page_loaded')).toHaveLength(0)

    nav.loadEventEnd = 1500
    windowStub.fire('load')

    const loaded = collector.events.filter((e) => e.type === 'page_loaded')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].data).toMatchObject({ ttfb: 100, domContentLoaded: 900, load: 1500 })
    expect(windowStub.count('load')).toBe(0) // 用后即摘，不留监听
  })

  it('导航时序延后一拍采集，管道装完（含后注册的上报插件）才发出', async () => {
    vi.useFakeTimers()
    FakeObserver.reset()
    stubGlobal('window', new FakeTarget())
    stubGlobal('document', new FakeTarget())
    stubGlobal('PerformanceObserver', FakeObserver)
    stubGlobal('performance', {
      now: () => 0,
      getEntriesByType: (type: string) => (type === 'navigation' ? [navigationEntry(1500)] : []),
    })

    // 复刻 lib/monitor/index.ts 的真实注册顺序：调试插件 → 采集插件 → 上报插件
    const debugLike = new CollectorPlugin()
    const transportLike = new CollectorPlugin()
    const monitor = new Monitor({ appId: 'a' })
    monitor.use(debugLike)
    monitor.use(new PerformancePlugin()) // setup 期间不直接发事件
    monitor.use(transportLike)

    expect(debugLike.types()).not.toContain('page_loaded')

    await vi.advanceTimersByTimeAsync(10)

    expect(debugLike.types()).toContain('page_loaded')
    expect(transportLike.types()).toContain('page_loaded')
  })

  it('重复 setup 不会重复挂观察器/监听器', () => {
    const { monitor, plugin, windowStub, documentStub } = setupPerf()
    plugin.setup(monitor) // 模拟同一实例被重复 use

    expect(FakeObserver.instances).toHaveLength(4) // paint / lcp / layout-shift / event
    expect(documentStub.count('visibilitychange')).toBe(1)

    plugin.reset()
    expect(documentStub.count('visibilitychange')).toBe(0)
    expect(windowStub.count('load')).toBe(0)
  })
})

/**
 * TransportPlugin 单测：批处理 / 关键事件直发 / 指数退避重试 / 离线持久化 / 队列操作
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import { TransportPlugin } from '../src/plugins/transport'
import type { IStorage, ITransport } from '../src/core/storage'
import type { MonitorEvent } from '../src/core/types'

/** 内存存储（模拟 localStorage/IndexedDB） */
class MemoryStorage implements IStorage {
  private map = new Map<string, string>()

  get(key: string): string | null {
    return this.map.get(key) ?? null
  }

  set(key: string, value: string): void {
    this.map.set(key, value)
  }

  remove(key: string): void {
    this.map.delete(key)
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.map)
  }
}

/** 可编程 mock 传输：手动控制成功/失败 */
class MockTransport implements ITransport {
  sendCalls: MonitorEvent[][] = []
  private shouldSucceed = true

  constructor(private failTimes = 0) {}

  setShouldSucceed(v: boolean): void {
    this.shouldSucceed = v
  }

  async send(events: MonitorEvent[]): Promise<boolean> {
    this.sendCalls.push(events)
    if (this.failTimes > 0) {
      this.failTimes -= 1
      return false
    }
    return this.shouldSucceed
  }
}

/** 排空微任务队列（不推进 fake timers，避免误触 0ms 定时器） */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/** 可挂起/放行的传输：用于制造「请求仍在飞行中」的并发窗口 */
class DeferredTransport implements ITransport {
  sendCalls: MonitorEvent[][] = []
  private resolvers: Array<(ok: boolean) => void> = []

  send(events: MonitorEvent[]): Promise<boolean> {
    this.sendCalls.push(events)
    return new Promise<boolean>((resolve) => this.resolvers.push(resolve))
  }

  /** 放行最早一个飞行中的请求 */
  async resolveNext(ok: boolean): Promise<void> {
    await this.resolveAt(0, ok)
  }

  /** 放行指定下标的飞行中请求（0 = 最早） */
  async resolveAt(index: number, ok: boolean): Promise<void> {
    const resolve = this.resolvers[index]
    if (resolve) {
      this.resolvers.splice(index, 1)
      resolve(ok)
    }
    await flushMicrotasks()
  }
}

/** 最小 window 替身：只用于验证 online / pagehide 事件的监听与派发 */
class FakeWindow {
  private handlers = new Map<string, Set<() => void>>()

  addEventListener(type: string, handler: () => void): void {
    if (type !== 'online' && type !== 'pagehide') return
    const set = this.handlers.get(type) ?? new Set<() => void>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  removeEventListener(type: string, handler: () => void): void {
    this.handlers.get(type)?.delete(handler)
  }

  /** 派发 online 事件（模拟断网恢复） */
  goOnline(): void {
    this.dispatch('online')
  }

  /** 派发 pagehide 事件（模拟页面卸载） */
  goPageHide(): void {
    this.dispatch('pagehide')
  }

  private dispatch(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler()
  }

  get onlineListenerCount(): number {
    return this.handlers.get('online')?.size ?? 0
  }
}

interface SetupOptions {
  failTimes?: number
  withStorage?: boolean
  batchSize?: number
  flushInterval?: number
  maxRetries?: number
  criticalTypes?: string[]
}

function setup(options: SetupOptions = {}) {
  const transport = new MockTransport(options.failTimes ?? 0)
  const storage = options.withStorage ? new MemoryStorage() : null
  const monitor = new Monitor({ appId: 'test-app' })

  monitor.use(
    new TransportPlugin({
      endpoint: '/api/monitor',
      transport,
      batchSize: options.batchSize ?? 10,
      flushInterval: options.flushInterval ?? 5000,
      maxRetries: options.maxRetries ?? 3,
      criticalTypes: options.criticalTypes ?? ['js_error'],
      offlineStorage: storage ?? undefined,
    })
  )

  const plugin = monitor.getPlugin<TransportPlugin>('transport')!
  return { transport, storage, monitor, plugin }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TransportPlugin 批处理', () => {
  it('攒够 batchSize 自动发送一批', async () => {
    const { monitor, transport } = setup({ batchSize: 3, flushInterval: 0 })

    monitor.track('a', {})
    monitor.track('b', {})
    expect(transport.sendCalls).toHaveLength(0)

    monitor.track('c', {})
    // 只冲刷微任务（flush 由事件触发，与定时器无关）
    await vi.advanceTimersByTimeAsync(1)

    expect(transport.sendCalls).toHaveLength(1)
    expect(transport.sendCalls[0]).toHaveLength(3)
  })

  it('flushInterval 到期强制刷新缓冲', async () => {
    const { monitor, transport, plugin } = setup({ flushInterval: 5000 })

    monitor.track('a', {})
    monitor.track('b', {})
    expect(transport.sendCalls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(5000)

    expect(transport.sendCalls).toHaveLength(1)
    expect(transport.sendCalls[0]).toHaveLength(2)
    expect(plugin.getQueueStatus().pending).toBe(0)
  })

  it('关键事件无视批处理立即直发', async () => {
    const { monitor, transport } = setup({ criticalTypes: ['js_error'], flushInterval: 0 })

    monitor.track('js_error', { message: 'boom' })
    await vi.advanceTimersByTimeAsync(1)

    expect(transport.sendCalls).toHaveLength(1)
    expect(transport.sendCalls[0]).toHaveLength(1)
    expect(transport.sendCalls[0][0].type).toBe('js_error')
  })

  it('flush() 手动强制发送', async () => {
    const { monitor, transport, plugin } = setup()

    monitor.track('a', {})
    expect(transport.sendCalls).toHaveLength(0)

    await plugin.flush()

    expect(transport.sendCalls).toHaveLength(1)
  })
})

describe('TransportPlugin 重试与离线', () => {
  it('发送失败后按指数退避重试，成功后清空失败队列', async () => {
    const { monitor, transport, plugin } = setup({ failTimes: 1, withStorage: true, flushInterval: 0 })

    monitor.track('a', {})
    await plugin.flush()

    // 第一次发送失败 → 进入失败队列
    expect(transport.sendCalls).toHaveLength(1)
    expect(plugin.getQueueStatus().offline).toBe(1)

    // 退避 1s 后重试成功
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls).toHaveLength(2)
    expect(plugin.getQueueStatus().offline).toBe(0)
  })

  it('超过 maxRetries 放弃该批次', async () => {
    const { monitor, transport, plugin } = setup({
      failTimes: 99,
      maxRetries: 2,
      flushInterval: 0,
    })

    monitor.track('a', {})
    await plugin.flush()

    // 初始失败 + 2 次重试后放弃
    await vi.advanceTimersByTimeAsync(1000) // retry 1
    await vi.advanceTimersByTimeAsync(2000) // retry 2 (backoff 2x)
    await vi.advanceTimersByTimeAsync(4000) // 不再重试

    expect(transport.sendCalls).toHaveLength(3)
    expect(plugin.getQueueStatus().offline).toBe(0)
  })

  it('失败批次持久化到 storage，新实例可恢复', async () => {
    const { monitor, storage, plugin } = setup({ failTimes: 99, withStorage: true, flushInterval: 0 })

    monitor.track('a', {})
    await plugin.flush()

    expect(storage!.dump()['future-monitor-sdk:transport:offline']).toBeTruthy()

    // 模拟页面刷新：用同一 storage 创建新实例
    const transport2 = new MockTransport(0)
    const monitor2 = new Monitor({ appId: 'test-app' })
    monitor2.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport: transport2,
        flushInterval: 0,
        offlineStorage: storage ?? undefined,
      })
    )
    const plugin2 = monitor2.getPlugin<TransportPlugin>('transport')!

    // 恢复的离线批次在退避到期后重发成功
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport2.sendCalls).toHaveLength(1)
    expect(plugin2.getQueueStatus().offline).toBe(0)
  })

  it('离线状态下不发起请求，直接进入失败队列', async () => {
    const monitor = new Monitor({ appId: 'test-app' })
    const transport = new MockTransport(0)
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        onlineCheck: () => false,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    await plugin.flush()

    expect(transport.sendCalls).toHaveLength(0)
    expect(plugin.getQueueStatus().offline).toBe(1)
  })

  it('离线期间退避调度不中断，恢复在线后自动补发（不依赖手动 flush）', async () => {
    let online = true
    const monitor = new Monitor({ appId: 'test-app' })
    const transport = new MockTransport(0)
    const storage = new MemoryStorage()
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        offlineStorage: storage,
        onlineCheck: () => online,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    // 在线发送失败 → 进入失败队列并调度退避（sendCalls=1 是那次失败的尝试）
    transport.setShouldSucceed(false)
    monitor.track('a', {})
    await plugin.flush()
    expect(plugin.getQueueStatus().offline).toBe(1)
    expect(transport.sendCalls).toHaveLength(1)

    // 进入离线：退避到期不应发送、不应丢批次、不应空转
    online = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.sendCalls).toHaveLength(1)
    expect(plugin.getQueueStatus().offline).toBe(1)

    // 恢复在线：自动补发成功，失败队列清空
    online = true
    transport.setShouldSucceed(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls).toHaveLength(2)
    expect(plugin.getQueueStatus().offline).toBe(0)
  })
})

describe('TransportPlugin 队列操作', () => {
  it('flushQueue 强制发送并返回是否清空，clearQueue 丢弃内存队列', async () => {
    const { monitor, transport, plugin } = setup({ flushInterval: 0 })

    monitor.track('a', {})
    const ok = await plugin.flushQueue()
    expect(ok).toBe(true)
    expect(transport.sendCalls).toHaveLength(1)

    monitor.track('b', {})
    plugin.clearQueue()
    expect(plugin.getQueueStatus().pending).toBe(0)
    await plugin.flush()
    expect(transport.sendCalls).toHaveLength(1) // b 被丢弃，未发送
  })
})

describe('TransportPlugin 并发互斥与 online 补发', () => {
  let fakeWindow: FakeWindow

  beforeEach(() => {
    fakeWindow = new FakeWindow()
    ;(globalThis as { window?: unknown }).window = fakeWindow
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (globalThis as { window?: unknown }).window
  })

  it('同一批次在飞行中不会被并发 flush 重复提交', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({ endpoint: '/api/monitor', transport, flushInterval: 0 })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    monitor.track('b', {})

    const first = plugin.flush()
    expect(transport.sendCalls).toHaveLength(1)
    expect(transport.sendCalls[0].map((e) => e.type)).toEqual(['a', 'b'])

    // 请求仍在飞行中：并发 flush + online 事件都不得把同一批次再取一次
    const second = plugin.flush()
    fakeWindow.goOnline()
    expect(transport.sendCalls).toHaveLength(1)

    await transport.resolveNext(true)
    await first
    await second
    await vi.advanceTimersByTimeAsync(0)

    expect(transport.sendCalls).toHaveLength(1)
    expect(plugin.getQueueStatus()).toEqual({ pending: 0, offline: 0 })
  })

  it('发送飞行中重入 flush() 会直接返回，不会二次驱动离线补发（互斥标志生效）', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({ endpoint: '/api/monitor', transport, flushInterval: 0 })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!
    const offlineSpy = vi.spyOn(
      plugin as unknown as { flushOffline: () => Promise<void> },
      'flushOffline'
    )

    monitor.track('a', {})
    const first = plugin.flush()
    // 此刻卡在缓冲区的发送上，还没走到离线补发
    expect(offlineSpy).not.toHaveBeenCalled()

    const second = plugin.flush()
    const third = plugin.flush()
    expect(offlineSpy).not.toHaveBeenCalled()

    await transport.resolveNext(true)
    await first
    await second
    await third

    // 只有最初那次 flush 走到了 flushOffline：重入的两次都在互斥标志处早退
    expect(offlineSpy).toHaveBeenCalledTimes(1)
  })

  it('失败批次退避未到期前，重复 flush 与 online 事件都不会提前补发', async () => {
    const transport = new MockTransport(99) // 始终失败
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        offlineStorage: new MemoryStorage(),
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    await plugin.flush()
    expect(transport.sendCalls).toHaveLength(1) // 首次尝试失败
    expect(plugin.getQueueStatus().offline).toBe(1)

    // 退避 1s 未到期：显式 flush、online 事件、定时器都不得提前发送
    await plugin.flush()
    fakeWindow.goOnline()
    await vi.advanceTimersByTimeAsync(999)
    expect(transport.sendCalls).toHaveLength(1)

    // 到期后由独立退避调度器补发（第二次尝试）
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.sendCalls).toHaveLength(2)
  })

  it('退避定时器已取出批次进入飞行后，显式 flush 不会把同一批次再发一次', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({ endpoint: '/api/monitor', transport, flushInterval: 0 })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    const first = plugin.flush()
    await transport.resolveNext(false) // 第 1 次尝试失败 → 进入失败队列
    await first
    expect(plugin.getQueueStatus().offline).toBe(1)
    expect(transport.sendCalls).toHaveLength(1)

    // 退避到期：独立调度器取出批次，请求进入飞行中
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls).toHaveLength(2)

    // 同一批次的请求仍在飞行中，此时显式 flush 不得再次提交
    await plugin.flush()
    expect(transport.sendCalls).toHaveLength(2)

    await transport.resolveNext(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(plugin.getQueueStatus().offline).toBe(0)
    expect(transport.sendCalls).toHaveLength(2)
  })

  it('补发互斥：已有补发批次在飞行中时，新到期批次不会被并发取出', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        baseRetryDelay: 0, // 失败后立即到期，便于构造「已到期但还没发」的失败批次
        criticalTypes: ['js_error'], // 关键事件直发，绕过 flush 的互斥标志
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    // ① 调用 1：a 首次发送失败 → 入队且立即到期
    monitor.track('a', {})
    void plugin.flush()
    await transport.resolveAt(0, false)
    // flush 内部紧接着补发 a（调用 2），且该请求一直挂在飞行中（未放行）
    expect(transport.sendCalls.map((c) => c[0].type)).toEqual(['a', 'a'])
    expect(plugin.getQueueStatus().offline).toBe(0) // a 已被取出（在飞行中）

    // ② 补发飞行期间，关键事件直发失败 → 又一个立即到期的批次（调用 3）
    monitor.track('js_error', {})
    await transport.resolveAt(1, false)
    expect(transport.sendCalls.map((c) => c[0].type)).toEqual(['a', 'a', 'js_error'])
    expect(plugin.getQueueStatus().offline).toBe(1)

    // ③ 退避定时器触发第二次补发：a 仍在飞行中，互斥标志必须让本次补发直接返回，
    //    否则会并发把 js_error 批次也取出来（调用数变成 4）
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sendCalls).toHaveLength(3)

    // ④ 放行 a：互斥解除后，js_error 批次才由调度器正常补发 —— 是串行化，不是丢弃
    await transport.resolveAt(0, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sendCalls.map((c) => c[0].type)).toEqual(['a', 'a', 'js_error', 'js_error'])

    await transport.resolveAt(0, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(plugin.getQueueStatus()).toEqual({ pending: 0, offline: 0 })
  })

  it('断网恢复后由 online 事件立即补发（不依赖手动 flush，也不依赖 flushInterval）', async () => {
    let online = false
    const transport = new MockTransport(0)
    const storage = new MemoryStorage()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0, // 没有定时 flush，补发只能靠 online 事件与退避调度器
        baseRetryDelay: 0, // 让恢复后立即可发，隔离出 online 事件本身的作用
        offlineStorage: storage,
        onlineCheck: () => online,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    await plugin.flush()
    expect(transport.sendCalls).toHaveLength(0) // 离线：不发请求
    expect(plugin.getQueueStatus().offline).toBe(1)
    expect(storage.get('future-monitor-sdk:transport:offline')).toBeTruthy()

    // 断网期间退避定时器反复触发：不发请求、不丢批次
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.sendCalls).toHaveLength(0)
    expect(plugin.getQueueStatus().offline).toBe(1)

    // 恢复在线：online 事件同步驱动补发（无需 await 定时器或手动 flush）
    online = true
    fakeWindow.goOnline()
    expect(transport.sendCalls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(0)
    expect(plugin.getQueueStatus().offline).toBe(0)
  })

  it('reset() 移除 online 监听、清空队列与持久化数据', async () => {
    const transport = new MockTransport(99)
    const storage = new MemoryStorage()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        offlineStorage: storage,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    expect(fakeWindow.onlineListenerCount).toBe(1)

    monitor.track('a', {})
    await plugin.flush()
    expect(plugin.getQueueStatus().offline).toBe(1)
    expect(storage.get('future-monitor-sdk:transport:offline')).toBeTruthy()

    plugin.reset()

    expect(fakeWindow.onlineListenerCount).toBe(0)
    expect(plugin.getQueueStatus()).toEqual({ pending: 0, offline: 0 })
    expect(storage.get('future-monitor-sdk:transport:offline')).toBeNull()

    // 重置后 online 事件不再驱动任何补发
    fakeWindow.goOnline()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sendCalls).toHaveLength(1)
  })
})

describe('TransportPlugin 可靠性补强', () => {
  let fakeWindow: FakeWindow

  beforeEach(() => {
    fakeWindow = new FakeWindow()
    ;(globalThis as { window?: unknown }).window = fakeWindow
  })

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('在飞 flush 期间攒满的批次会在本轮结束后补做，不会滞留到下一次触发', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        batchSize: 2,
        flushInterval: 0, // 没有任何定时器兜底：不补做就永远发不出去
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    monitor.track('b', {})
    await flushMicrotasks()
    expect(transport.sendCalls.map((c) => c.map((e) => e.type))).toEqual([['a', 'b']])

    // 第一批仍在飞行中，此时又攒满第二批
    monitor.track('c', {})
    monitor.track('d', {})
    expect(transport.sendCalls).toHaveLength(1)

    // 放行第一批：被吞掉的 flush 请求应当补做，第二批紧接着发出
    await transport.resolveNext(true)
    await flushMicrotasks()
    expect(transport.sendCalls.map((c) => c.map((e) => e.type))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])

    await transport.resolveNext(true)
    await flushMicrotasks()
    expect(plugin.getQueueStatus()).toEqual({ pending: 0, offline: 0 })
  })

  it('ITransport 抛错时按发送失败处理：批次进失败队列而不是凭空消失', async () => {
    class ThrowingTransport implements ITransport {
      sendCalls = 0
      async send(): Promise<boolean> {
        this.sendCalls += 1
        throw new Error('transport exploded')
      }
    }
    const transport = new ThrowingTransport()
    const storage = new MemoryStorage()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        baseRetryDelay: 0,
        offlineStorage: storage,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    // 不该抛出：异常必须被折叠成"发送失败"
    await expect(plugin.flush()).resolves.toBeUndefined()

    expect(transport.sendCalls).toBeGreaterThan(0)
    // 批次留在失败队列里 + 已落盘，而不是丢失
    expect(plugin.getQueueStatus().offline).toBe(1)
    expect(storage.get('future-monitor-sdk:transport:offline')).toContain('"a"')
  })

  it('pagehide 时把缓冲里的事件立刻发出去（keepalive 保证请求能完成）', async () => {
    const transport = new DeferredTransport()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        batchSize: 10, // 还没攒满：没有 pagehide 钩子这批就丢了
        flushInterval: 0,
      })
    )

    monitor.track('a', {})
    monitor.track('b', {})
    expect(transport.sendCalls).toHaveLength(0)

    fakeWindow.goPageHide()
    await flushMicrotasks()

    expect(transport.sendCalls.map((c) => c.map((e) => e.type))).toEqual([['a', 'b']])
  })

  it('新失败批次的退避不会被旧的长时间退避拖住（定时器重排）', async () => {
    const transport = new MockTransport(99) // 始终失败
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        criticalTypes: ['js_error'], // 直发，用来制造"第二个失败批次"
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    // 第一批失败 → 退避 1s；第二次重试失败 → 退避 2s（此时定时器指向 2s 后）
    monitor.track('a', {})
    await plugin.flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls).toHaveLength(2)

    // 紧接着一个关键事件直发失败：它的退避只有 1s，不该等到第二批的 2s 才被处理
    monitor.track('js_error', {})
    await flushMicrotasks()
    expect(transport.sendCalls).toHaveLength(3)

    // 1s 后这个新批次就应被重试（没有重排的话要等到 2s）
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls.length).toBeGreaterThanOrEqual(4)
  })

  it('持久化数据里混入非法条目时被丢弃，不会让队列永远清不掉', async () => {
    const storage = new MemoryStorage()
    storage.set(
      'future-monitor-sdk:transport:offline',
      JSON.stringify([
        { events: [], retries: 0, nextRetryAt: Date.now() + 1000 }, // 空批次
        { retries: 0, nextRetryAt: Date.now() }, // 缺 events
        { events: [{ id: 'evt_1', type: 'a', timestamp: 1, data: {}, context: {} }] }, // 缺 nextRetryAt
      ])
    )
    const transport = new MockTransport(0)
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        baseRetryDelay: 0,
        offlineStorage: storage,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    // 三条都是垃圾：不再有任何"永远清不掉"的条目，队列为空
    expect(plugin.getQueueStatus().offline).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.sendCalls).toHaveLength(0)
  })

  it('完整的离线快照仍能恢复并补发（校验不误伤合法数据）', async () => {
    const storage = new MemoryStorage()
    const pendingEvent = { id: 'evt_9', type: 'a', timestamp: 1, data: {}, context: {} }
    storage.set(
      'future-monitor-sdk:transport:offline',
      JSON.stringify([{ events: [pendingEvent], retries: 0, nextRetryAt: Date.now() }])
    )
    const transport = new MockTransport(0)
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        offlineStorage: storage,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    expect(plugin.getQueueStatus().offline).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.sendCalls).toHaveLength(1)
    expect(transport.sendCalls[0][0].id).toBe('evt_9')
    expect(plugin.getQueueStatus().offline).toBe(0)
  })

  it('reset() 之后在飞请求失败不会把批次塞回队列、也不会重写已删除的存储', async () => {
    const transport = new DeferredTransport()
    const storage = new MemoryStorage()
    const monitor = new Monitor({ appId: 'test-app' })
    monitor.use(
      new TransportPlugin({
        endpoint: '/api/monitor',
        transport,
        flushInterval: 0,
        offlineStorage: storage,
      })
    )
    const plugin = monitor.getPlugin<TransportPlugin>('transport')!

    monitor.track('a', {})
    const inFlight = plugin.flush()
    expect(transport.sendCalls).toHaveLength(1)

    plugin.reset()
    expect(storage.get('future-monitor-sdk:transport:offline')).toBeNull()

    // 旧请求这时才失败：不得复活队列
    await transport.resolveNext(false)
    await inFlight
    await vi.advanceTimersByTimeAsync(5000)

    expect(plugin.getQueueStatus()).toEqual({ pending: 0, offline: 0 })
    expect(storage.get('future-monitor-sdk:transport:offline')).toBeNull()
    expect(transport.sendCalls).toHaveLength(1)
  })
})

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

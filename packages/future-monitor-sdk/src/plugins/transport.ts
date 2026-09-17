/**
 * TransportPlugin - 智能上报
 *
 * 内聚了上报侧的完整策略：
 * - 批处理：攒够 batchSize 或到达 flushInterval 统一上报，减少请求数
 * - 关键事件直发：criticalTypes（错误类）无视批处理模式立即上报，保证低延迟
 * - 指数退避重试：失败后按 baseRetryDelay * 2^retries 递增退避，封顶 maxRetryDelay
 * - 离线持久化：失败批次写入 IStorage，网络恢复（online 事件）后自动补发
 * - 状态可观测：getQueueStatus / flushQueue / clearQueue 供调试面板使用
 */

import type { IStorage, ITransport } from '../core/storage'
import type { MonitorEvent, Plugin } from '../core/types'
import type { Monitor } from '../core/monitor'
import { BrowserTransport } from '../core/storage'

export type TransportMode = 'immediate' | 'batch'

export interface TransportPluginOptions {
  /** 上报地址 */
  endpoint: string
  /** 传输实现，默认 BrowserTransport */
  transport?: ITransport
  /** 上报模式，默认 batch */
  mode?: TransportMode
  /** 批大小，默认 10 */
  batchSize?: number
  /** 批刷新间隔（ms），默认 5000 */
  flushInterval?: number
  /** 内存缓冲上限，超出丢最旧，默认 200 */
  maxBufferSize?: number
  /** 关键事件类型：立即直发，默认 sse_error/js_error/promise_error */
  criticalTypes?: string[]
  /** 最大重试次数，默认 3 */
  maxRetries?: number
  /** 退避基准（ms），默认 1000 */
  baseRetryDelay?: number
  /** 退避封顶（ms），默认 30000 */
  maxRetryDelay?: number
  /** 离线队列持久化存储（可选） */
  offlineStorage?: IStorage
  /** 在线状态检测，默认 navigator.onLine */
  onlineCheck?: () => boolean
}

interface FailedBatch {
  events: MonitorEvent[]
  retries: number
  nextRetryAt: number
}

/** 解析后的内部配置：offlineStorage 允许显式 null */
type ResolvedOptions = Omit<Required<TransportPluginOptions>, 'offlineStorage'> & {
  offlineStorage: IStorage | null
}

const OFFLINE_STORAGE_KEY = 'future-monitor-sdk:transport:offline'
const DEFAULT_CRITICAL_TYPES = ['sse_error', 'js_error', 'promise_error']

export class TransportPlugin implements Plugin {
  name = 'transport'
  /** 管道末端：永远最后执行 */
  priority = -1000

  private readonly options: ResolvedOptions
  private readonly transport: ITransport
  private monitor: Monitor | null = null

  private buffer: MonitorEvent[] = []
  private failed: FailedBatch[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private offlineFlushing = false
  private onlineHandler: (() => void) | null = null

  constructor(options: TransportPluginOptions) {
    this.options = {
      endpoint: options.endpoint,
      transport: options.transport ?? new BrowserTransport({ endpoint: options.endpoint }),
      mode: options.mode ?? 'batch',
      batchSize: options.batchSize ?? 10,
      flushInterval: options.flushInterval ?? 5000,
      maxBufferSize: options.maxBufferSize ?? 200,
      criticalTypes: options.criticalTypes ?? DEFAULT_CRITICAL_TYPES,
      maxRetries: options.maxRetries ?? 3,
      baseRetryDelay: options.baseRetryDelay ?? 1000,
      maxRetryDelay: options.maxRetryDelay ?? 30000,
      offlineStorage: options.offlineStorage ?? null,
      // 注意：Node 22+ 全局存在 navigator 但无 onLine 属性（undefined），
      // 用 `!== false` 判定，浏览器离线时 onLine === false 才视为离线
      onlineCheck: options.onlineCheck ?? (() =>
        typeof navigator !== 'undefined' ? navigator.onLine !== false : true
      ),
    }
    this.transport = this.options.transport
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    this.loadOffline()

    if (typeof window !== 'undefined') {
      this.onlineHandler = () => {
        void this.flush()
      }
      window.addEventListener('online', this.onlineHandler)
    }

    if (this.options.flushInterval > 0) {
      this.timer = setInterval(() => {
        void this.flush()
      }, this.options.flushInterval)
    }

    // 恢复的离线批次立即进入退避调度
    this.scheduleRetry()
  }

  reset(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }
    this.buffer = []
    this.failed = []
    this.options.offlineStorage?.remove(OFFLINE_STORAGE_KEY)
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    if (this.options.mode === 'immediate' || this.options.criticalTypes.includes(event.type)) {
      // 关键事件：直接异步发送（不阻塞管道）
      void this.sendWithRetry([event])
      return event
    }

    this.buffer.push(event)

    // 缓冲上限保护：超出丢最旧
    if (this.buffer.length > this.options.maxBufferSize) {
      this.buffer.shift()
    }

    // 攒满一批立即发送
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush()
    }
    return event
  }

  async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      if (this.buffer.length > 0) {
        const batch = this.buffer.splice(0)
        await this.sendWithRetry(batch)
      }
      await this.flushOffline()
    } finally {
      this.flushing = false
    }
  }

  // ==================== 队列状态（调试面板） ====================

  getQueueStatus(): { pending: number; offline: number } {
    return {
      pending: this.buffer.length,
      offline: this.failed.length,
    }
  }

  /** 强制发送全部（内存 + 离线） */
  async flushQueue(): Promise<boolean> {
    await this.flush()
    return this.failed.length === 0 && this.buffer.length === 0
  }

  /** 丢弃内存队列（不发送） */
  clearQueue(): void {
    this.buffer = []
  }

  // ==================== 内部 ====================

  private async sendWithRetry(batch: MonitorEvent[]): Promise<void> {
    if (batch.length === 0) return

    // 离线状态：直接入失败队列，避免无效请求
    if (!this.options.onlineCheck()) {
      this.enqueueFailed(batch, 0)
      return
    }

    const ok = await this.transport.send(batch)
    if (!ok) {
      this.enqueueFailed(batch, 0)
    }
  }

  private enqueueFailed(events: MonitorEvent[], retries: number): void {
    const now = Date.now()
    this.failed.push({
      events,
      retries,
      nextRetryAt: now + this.getBackoffDelay(retries),
    })
    this.persistOffline()
    this.scheduleRetry()
  }

  /**
   * 退避调度：为最早的失败批次安排定时重试，
   * 不依赖 flushInterval（flushInterval=0 时离线重试依然生效）
   */
  private scheduleRetry(): void {
    if (this.retryTimer) return
    if (this.failed.length === 0) return

    const now = Date.now()
    const nextRetryAt = Math.min(...this.failed.map((f) => f.nextRetryAt))
    const delay = Math.max(0, nextRetryAt - now)

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flushOffline()
    }, delay)
  }

  private async flushOffline(): Promise<void> {
    if (this.failed.length === 0) return

    // 离线：不取出批次，改为至少 1s 后重试（避免 setTimeout(0) 空转循环）。
    // 这样不依赖 online 事件也能在恢复后自动补发；在线时正常退避调度。
    if (!this.options.onlineCheck()) {
      if (!this.retryTimer) {
        const earliest = Math.min(...this.failed.map((f) => f.nextRetryAt))
        const delay = Math.max(1000, earliest - Date.now())
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.flushOffline()
        }, delay)
      }
      return
    }

    // 并发保护：retryTimer 与 flush() 都可能触发本方法，
    // 防止同一失败批次被两个执行流同时取出并重复上报
    if (this.offlineFlushing) return
    this.offlineFlushing = true
    try {
      const now = Date.now()
      const due = this.failed.filter((f) => f.nextRetryAt <= now)
      if (due.length === 0) return

      this.failed = this.failed.filter((f) => f.nextRetryAt > now)

      for (const batch of due) {
        // 超过最大重试次数：在发送前直接放弃该批次
        if (batch.retries >= this.options.maxRetries) {
          continue
        }
        const ok = await this.transport.send(batch.events)
        if (ok) continue

        batch.retries += 1
        batch.nextRetryAt = Date.now() + this.getBackoffDelay(batch.retries)
        this.failed.push(batch)
      }
    } finally {
      this.offlineFlushing = false
    }
    this.persistOffline()
    this.scheduleRetry()
  }

  /** 指数退避：baseRetryDelay * 2^retries，封顶 maxRetryDelay */
  private getBackoffDelay(retries: number): number {
    return Math.min(
      this.options.baseRetryDelay * 2 ** retries,
      this.options.maxRetryDelay
    )
  }

  private persistOffline(): void {
    const storage = this.options.offlineStorage
    if (!storage) return
    try {
      storage.set(OFFLINE_STORAGE_KEY, JSON.stringify(this.failed))
    } catch {
      // 序列化失败时静默（数据留在内存中）
    }
  }

  private loadOffline(): void {
    const storage = this.options.offlineStorage
    if (!storage) return
    try {
      const raw = storage.get(OFFLINE_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as FailedBatch[]
      if (Array.isArray(parsed)) {
        this.failed = parsed
      }
    } catch {
      storage.remove(OFFLINE_STORAGE_KEY)
    }
  }
}

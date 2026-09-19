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

/** 反序列化校验：旧 schema / 写了一半 / 被外部改写的条目会让 nextRetryAt 变 NaN，队列就永远清不掉 */
function isFailedBatch(value: unknown): value is FailedBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Record<string, unknown>
  return (
    Array.isArray(batch.events) &&
    batch.events.length > 0 &&
    Number.isFinite(batch.retries) &&
    Number.isFinite(batch.nextRetryAt)
  )
}

/** 解析后的内部配置：offlineStorage 允许显式 null */
type ResolvedOptions = Omit<Required<TransportPluginOptions>, 'offlineStorage'> & {
  offlineStorage: IStorage | null
}

const OFFLINE_STORAGE_KEY = 'future-monitor-sdk:transport:offline'
const DEFAULT_CRITICAL_TYPES = ['sse_error', 'js_error', 'promise_error']
/** 离线重试的最小间隔：避免 setTimeout(0) 空转 */
const MIN_OFFLINE_RETRY_DELAY = 1000

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
  /** 当前退避定时器的到期时刻（用于判断是否需要重排） */
  private retryDueAt: number | null = null
  private flushing = false
  /** 在飞期间被触发的 flush：本轮结束后补做，避免批次一直躺在缓冲里 */
  private flushPending = false
  private offlineFlushing = false
  private onlineHandler: (() => void) | null = null
  private pageHideHandler: (() => void) | null = null
  private initialized = false
  /** reset 之后的终态：在飞的旧请求不允许把批次重新塞回队列、重写已删除的存储 */
  private disposed = false
  /** 上次落盘内容：内容未变就不重复序列化 + 写入 */
  private lastPersisted: string | null = null

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
    // 幂等：同一实例被重复 use 时不再重复挂监听/定时器（旧句柄会取不回来，泄漏）
    if (this.initialized) return
    this.initialized = true
    this.disposed = false

    this.loadOffline()

    if (typeof window !== 'undefined') {
      this.onlineHandler = () => {
        void this.flush()
      }
      window.addEventListener('online', this.onlineHandler)

      // 页面卸载：把缓冲里的事件立刻发出去。
      // BrowserTransport 带 keepalive，请求可以在页面消失后继续完成；
      // 没有这个钩子，卸载时缓冲里的事件（默认最多 batchSize-1 条）必然丢失。
      this.pageHideHandler = () => {
        void this.flush()
      }
      window.addEventListener('pagehide', this.pageHideHandler)
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
    // 终态：在飞的请求即使失败也不允许把批次塞回来、不允许重写存储
    this.disposed = true

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.retryDueAt = null
    }
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler)
      this.onlineHandler = null
    }
    if (this.pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.pageHideHandler)
      this.pageHideHandler = null
    }
    this.buffer = []
    this.failed = []
    this.flushPending = false
    this.lastPersisted = null
    this.initialized = false
    this.options.offlineStorage?.remove(OFFLINE_STORAGE_KEY)
  }

  processEvent(event: MonitorEvent): MonitorEvent | null {
    // 管道在 reset 之后仍会把事件送进来：说明插件还在用，解除终态
    this.disposed = false

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
    if (this.disposed) return

    if (this.flushing) {
      // 在飞期间再次触发：记一笔待办，等本轮结束后补做。
      // 直接 return 会让这批事件一直躺在缓冲里（flushInterval=0 时可能永远发不出去），
      // 但绝不能在这里再取一次缓冲——那会让同一批事件被提交两次。
      this.flushPending = true
      return
    }

    this.flushing = true
    try {
      do {
        this.flushPending = false

        if (this.buffer.length > 0) {
          const batch = this.buffer.splice(0)
          await this.sendWithRetry(batch)
        }
        await this.flushOffline()
        // 只有确实还有活干时才续做：没有待办就不重复驱动离线补发
      } while (this.flushPending && (this.buffer.length > 0 || this.failed.length > 0))
    } finally {
      this.flushing = false
      this.flushPending = false
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
    if (this.disposed) return

    // 离线状态：直接入失败队列，避免无效请求
    if (!this.options.onlineCheck()) {
      this.enqueueFailed(batch, 0)
      return
    }

    // ITransport 的契约是"返回是否成功"，但自定义实现可能抛错。
    // 抛错必须按失败处理：这批事件已经离开缓冲，丢了就再也找不回来。
    let ok = false
    try {
      ok = await this.transport.send(batch)
    } catch {
      ok = false
    }
    if (!ok) {
      this.enqueueFailed(batch, 0)
    }
  }

  private enqueueFailed(events: MonitorEvent[], retries: number): void {
    if (this.disposed) return

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
    if (this.disposed) return
    if (this.failed.length === 0) return

    this.armRetryTimer(this.earliestRetryAt())
  }

  /**
   * 挂退避定时器；已有更早的定时器就保留（新失败批次的 1s 不该被旧的 4s 退避拖住），
   * 更早则重排。
   */
  private armRetryTimer(dueAt: number): void {
    if (this.disposed || !Number.isFinite(dueAt)) return
    if (this.retryTimer && this.retryDueAt !== null && this.retryDueAt <= dueAt) return

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    this.retryDueAt = dueAt
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryDueAt = null
      void this.flushOffline()
    }, Math.max(0, dueAt - Date.now()))
  }

  /** 最早的到期时刻（循环求最小，避免 Math.min(...arr) 在长队列上展开） */
  private earliestRetryAt(): number {
    let earliest = Number.POSITIVE_INFINITY
    for (const batch of this.failed) {
      if (batch.nextRetryAt < earliest) earliest = batch.nextRetryAt
    }
    return earliest
  }

  private async flushOffline(): Promise<void> {
    if (this.disposed) return
    if (this.failed.length === 0) return

    // 离线：不取出批次，改为至少 1s 后重试（避免 setTimeout(0) 空转循环）。
    // 这样不依赖 online 事件也能在恢复后自动补发；在线时正常退避调度。
    if (!this.options.onlineCheck()) {
      this.armRetryTimer(Math.max(Date.now() + MIN_OFFLINE_RETRY_DELAY, this.earliestRetryAt()))
      return
    }

    // 并发保护：retryTimer 与 flush() 都可能触发本方法，
    // 防止同一失败批次被两个执行流同时取出并重复上报
    if (this.offlineFlushing) return
    this.offlineFlushing = true
    try {
      const now = Date.now()
      const due = this.failed.filter((f) => f.nextRetryAt <= now)

      this.failed = this.failed.filter((f) => f.nextRetryAt > now)

      for (const batch of due) {
        // 超过最大重试次数：在发送前直接放弃该批次
        if (batch.retries >= this.options.maxRetries) {
          continue
        }

        // 同 sendWithRetry：发送实现抛错按失败处理，批次必须回到队列
        let ok = false
        try {
          ok = await this.transport.send(batch.events)
        } catch {
          ok = false
        }
        if (ok) continue

        batch.retries += 1
        batch.nextRetryAt = Date.now() + this.getBackoffDelay(batch.retries)
        this.failed.push(batch)
      }
    } finally {
      this.offlineFlushing = false
      // 无论成功、失败还是抛错都要落盘并续期：
      // 少了这一步，退避调度链会断在异常路径上，批次只剩内存里的一份
      this.persistOffline()
      this.scheduleRetry()
    }
  }

  /** 指数退避：baseRetryDelay * 2^retries，封顶 maxRetryDelay */
  private getBackoffDelay(retries: number): number {
    return Math.min(
      this.options.baseRetryDelay * 2 ** retries,
      this.options.maxRetryDelay
    )
  }

  private persistOffline(): void {
    if (this.disposed) return

    const storage = this.options.offlineStorage
    if (!storage) return

    let payload: string
    try {
      payload = JSON.stringify(this.failed)
    } catch {
      // 序列化失败时静默（数据留在内存中）
      return
    }

    // 内容没变就不写：避免每次试探性落盘都做一次同步序列化 + 存储写入
    if (payload === this.lastPersisted) return

    try {
      storage.set(OFFLINE_STORAGE_KEY, payload)
      this.lastPersisted = payload
    } catch {
      // 存储本身抛错（隐私模式等）时保持内存副本，下次再试
    }
  }

  private loadOffline(): void {
    const storage = this.options.offlineStorage
    if (!storage) return

    try {
      const raw = storage.get(OFFLINE_STORAGE_KEY)
      if (!raw) return

      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) {
        storage.remove(OFFLINE_STORAGE_KEY)
        return
      }

      // 逐条校验：非法条目的 nextRetryAt 是 NaN，会让调度器算不出到期时间，
      // 队列从此永远清不掉（表现为 offline 计数一直不为 0）
      const valid = parsed.filter(isFailedBatch)
      this.failed = valid
      this.lastPersisted = raw

      if (valid.length !== parsed.length) {
        // 丢掉非法条目后立刻重写一份干净的快照
        this.lastPersisted = null
        this.persistOffline()
      }
    } catch {
      this.failed = []
      this.lastPersisted = null
      storage.remove(OFFLINE_STORAGE_KEY)
    }
  }
}

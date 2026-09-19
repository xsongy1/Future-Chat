/**
 * NetworkPlugin - 网络请求监控（fetch + XHR）
 *
 * 通过包裹原生 fetch / XMLHttpRequest 采集请求耗时与状态，
 * 产出 http_request 事件。支持 includeUrls / excludeUrls 过滤。
 */

import type { MonitorEvent, Plugin } from '../core/types'
import type { Monitor } from '../core/monitor'
import { testRegex } from '../core/regex'

export interface NetworkPluginOptions {
  /** 只采集匹配的 URL（默认全部） */
  includeUrls?: RegExp[]
  /** 排除的 URL（如上报接口自身） */
  excludeUrls?: RegExp[]
}

export class NetworkPlugin implements Plugin {
  name = 'network'
  priority = 200

  private readonly options: Required<NetworkPluginOptions>
  private monitor: Monitor | null = null
  private fetchOriginal: typeof fetch | null = null
  private xhrOpenOriginal: XMLHttpRequest['open'] | null = null
  private xhrSendOriginal: XMLHttpRequest['send'] | null = null
  /** 是否已包装过原生 API：同一实例被重复 use 时不再二次包装（否则请求被双计数） */
  private initialized = false

  constructor(options: NetworkPluginOptions = {}) {
    this.options = {
      includeUrls: options.includeUrls ?? [],
      excludeUrls: options.excludeUrls ?? [],
    }
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    // window 判定排在幂等标志之前：SSR 期 setup 不能置位，否则水合后包装不上
    if (typeof window === 'undefined') return
    if (this.initialized) return
    this.initialized = true

    this.patchFetch()
    this.patchXHR()
  }

  reset(): void {
    if (this.fetchOriginal && typeof window !== 'undefined') {
      window.fetch = this.fetchOriginal
      this.fetchOriginal = null
    }
    if (this.xhrOpenOriginal && this.xhrSendOriginal && typeof XMLHttpRequest !== 'undefined') {
      XMLHttpRequest.prototype.open = this.xhrOpenOriginal
      XMLHttpRequest.prototype.send = this.xhrSendOriginal
      this.xhrOpenOriginal = null
      this.xhrSendOriginal = null
    }
    this.initialized = false
  }

  processEvent(_event: MonitorEvent): MonitorEvent | null {
    return _event
  }

  // ==================== fetch 拦截 ====================

  private patchFetch(): void {
    const original = window.fetch.bind(window)
    this.fetchOriginal = window.fetch

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (typeof input !== 'string' && 'method' in input ? input.method : 'GET')).toUpperCase()
      const startTime = performance.now()

      if (!this.shouldCapture(url)) {
        return original(input, init)
      }

      return original(input, init).then(
        (response) => {
          this.trackRequest(url, method, response.status, startTime)
          return response
        },
        (error: unknown) => {
          this.trackRequest(url, method, 0, startTime, error instanceof Error ? error.message : String(error))
          throw error
        }
      )
    }) as typeof fetch
  }

  // ==================== XHR 拦截 ====================

  private patchXHR(): void {
    if (typeof XMLHttpRequest === 'undefined') return

    const monitor = this.monitor
    const shouldCapture = (url: string) => this.shouldCapture(url)
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send
    this.xhrOpenOriginal = originalOpen
    this.xhrSendOriginal = originalSend

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null
    ) {
      // 与 fetch 拦截一致：open 时即应用 include/exclude 过滤
      const urlString = String(url)
      this.__skyMonitor = shouldCapture(urlString)
        ? { method, url: urlString }
        : undefined
      return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
    }

    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest['send']>
    ) {
      // 先摘掉上一轮残留的 loadend 监听：XHR 实例复用（open/send 多轮，甚至上一轮
      // 是不采集的 URL）时旧监听仍挂在实例上，闭包里还是上一轮的 URL，
      // 会造成重复上报与 URL 串味
      if (this.__skyMonitorLoadEnd) {
        this.removeEventListener('loadend', this.__skyMonitorLoadEnd)
        this.__skyMonitorLoadEnd = undefined
      }

      const meta = this.__skyMonitor
      if (meta) {
        const startTime = performance.now()
        const onLoadEnd = function (this: XMLHttpRequest) {
          monitor?.track('http_request', {
            url: meta.url,
            method: meta.method,
            status: this.status,
            duration: Math.round(performance.now() - startTime),
            error: this.status === 0 ? 'network_error' : undefined,
          })
        }
        this.__skyMonitorLoadEnd = onLoadEnd
        this.addEventListener('loadend', onLoadEnd)
      }
      return originalSend.apply(this, args)
    }
  }

  private trackRequest(
    url: string,
    method: string,
    status: number,
    startTime: number,
    error?: string
  ): void {
    this.monitor?.track('http_request', {
      url,
      method,
      status,
      duration: Math.round(performance.now() - startTime),
      error,
    })
  }

  private shouldCapture(url: string): boolean {
    if (this.options.includeUrls.length > 0) {
      if (!this.options.includeUrls.some((r) => testRegex(r, url))) return false
    }
    if (this.options.excludeUrls.some((r) => testRegex(r, url))) return false
    return true
  }
}

// 类型扩展：XHR 上的私有元数据
declare global {
  interface XMLHttpRequest {
    __skyMonitor?: { method: string; url: string }
    /** 本次 send 挂上的 loadend 监听：复用同一实例时先摘掉，避免重复上报 */
    __skyMonitorLoadEnd?: (this: XMLHttpRequest, event: Event) => void
  }
}

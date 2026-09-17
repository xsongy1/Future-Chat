/**
 * ErrorPlugin - 错误监控
 *
 * 采集：
 * - js_error：window error（运行时错误）
 * - promise_error：unhandledrejection
 * - resource_error：资源加载失败（捕获阶段）
 * - console_error：console.error（可选）
 *
 * 支持忽略规则（ignoreErrors / ignoreUrls），并做窗口内快速去重。
 */

import type { Plugin } from '../core/types.js'
import type { Monitor } from '../core/monitor.js'

export interface ErrorPluginOptions {
  /** 忽略的错误消息（正则） */
  ignoreErrors?: RegExp[]
  /** 忽略的错误来源 URL（正则） */
  ignoreUrls?: RegExp[]
  /** 是否采集 console.error，默认 false */
  captureConsoleError?: boolean
  /** 快速去重窗口（ms），默认 2000 */
  dedupeWindow?: number
}

export class ErrorPlugin implements Plugin {
  name = 'error'
  priority = 200

  private readonly options: Required<ErrorPluginOptions>
  private monitor: Monitor | null = null
  private lastErrorKey = ''
  private lastErrorTime = 0
  private consoleErrorOriginal: ((...args: unknown[]) => void) | null = null

  constructor(options: ErrorPluginOptions = {}) {
    this.options = {
      ignoreErrors: options.ignoreErrors ?? [],
      ignoreUrls: options.ignoreUrls ?? [],
      captureConsoleError: options.captureConsoleError ?? false,
      dedupeWindow: options.dedupeWindow ?? 2000,
    }
  }

  setup(monitor: Monitor): void {
    this.monitor = monitor
    if (typeof window === 'undefined') return

    window.addEventListener('error', this.handleError)
    window.addEventListener('unhandledrejection', this.handleRejection)
    // 资源错误不会冒泡，需在捕获阶段监听
    window.addEventListener('error', this.handleResourceError, true)

    if (this.options.captureConsoleError) {
      this.consoleErrorOriginal = console.error
      console.error = (...args: unknown[]) => {
        this.consoleErrorOriginal?.(...args)
        this.track('console_error', {
          message: args.map(String).join(' '),
          stack: new Error().stack,
        })
      }
    }
  }

  reset(): void {
    if (typeof window === 'undefined') return
    window.removeEventListener('error', this.handleError)
    window.removeEventListener('unhandledrejection', this.handleRejection)
    window.removeEventListener('error', this.handleResourceError, true)

    if (this.options.captureConsoleError && this.consoleErrorOriginal) {
      console.error = this.consoleErrorOriginal
      this.consoleErrorOriginal = null
    }
  }

  // ==================== 处理器 ====================

  private readonly handleError = (event: ErrorEvent): void => {
    if (event.defaultPrevented) return
    if (this.isIgnored(event.message, event.filename)) return
    this.track('js_error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
    })
  }

  private readonly handleRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    if (this.isIgnored(message)) return
    this.track('promise_error', {
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
      url: typeof window !== 'undefined' ? window.location.href : undefined,
    })
  }

  private readonly handleResourceError = (event: Event): void => {
    // 只处理资源加载错误（ErrorEvent 无 target 或 target 不是 window）
    const target = event.target as HTMLElement | null
    if (!target || event.target === window) return

    const tag = target.tagName?.toLowerCase()
    const url = (target as HTMLImageElement).src ?? (target as HTMLLinkElement).href ?? ''
    if (this.isIgnored('', url)) return

    this.track('resource_error', {
      tag,
      url,
      message: `资源加载失败: ${tag} ${url}`,
    })
  }

  // ==================== 工具 ====================

  private track(type: string, data: Record<string, unknown>): void {
    // 窗口内同 key 去重（防错误风暴）
    const key = `${type}:${String(data.message ?? data.url ?? '')}`
    const now = Date.now()
    if (key === this.lastErrorKey && now - this.lastErrorTime < this.options.dedupeWindow) {
      return
    }
    this.lastErrorKey = key
    this.lastErrorTime = now
    this.monitor?.track(type, data)
  }

  private isIgnored(message: string, url?: string): boolean {
    for (const rule of this.options.ignoreErrors) {
      if (rule.test(message)) return true
    }
    if (url) {
      for (const rule of this.options.ignoreUrls) {
        if (rule.test(url)) return true
      }
    }
    return false
  }
}

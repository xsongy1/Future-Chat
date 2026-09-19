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

import type { Plugin } from '../core/types'
import type { Monitor } from '../core/monitor'
import { testRegex } from '../core/regex'

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
  /** 是否已挂过监听：同一实例被重复 use 时不再二次包装 console.error */
  private initialized = false

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
    // window 判定必须排在幂等标志之前：SSR 期调用 setup 不能把 initialized 置位，
    // 否则水合后真正的浏览器 setup 会被幂等判断挡掉，监听永远挂不上
    if (typeof window === 'undefined') return
    if (this.initialized) return
    this.initialized = true

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
    // 幂等标志复位：与 window 是否存在无关，否则 Node 侧（测试）reset 后无法再 setup
    this.initialized = false

    if (typeof window !== 'undefined') {
      window.removeEventListener('error', this.handleError)
      window.removeEventListener('unhandledrejection', this.handleRejection)
      window.removeEventListener('error', this.handleResourceError, true)
    }

    if (this.options.captureConsoleError && this.consoleErrorOriginal) {
      console.error = this.consoleErrorOriginal
      this.consoleErrorOriginal = null
    }

    // 清空窗口去重状态：否则 reset 之后第一条同 key 错误会被上一次的窗口吃掉
    this.lastErrorKey = ''
    this.lastErrorTime = 0
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
      if (testRegex(rule, message)) return true
    }
    if (url) {
      for (const rule of this.options.ignoreUrls) {
        if (testRegex(rule, url)) return true
      }
    }
    return false
  }
}

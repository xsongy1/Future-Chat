/**
 * 平台抽象层
 *
 * SDK 核心不直接依赖浏览器 API，通过 IStorage / ITransport 接口解耦，
 * 便于扩展 Node / 小程序等平台，也便于单测注入 mock。
 */

import type { MonitorEvent } from './types'

/** 键值存储抽象（离线队列持久化等） */
export interface IStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

/** 传输抽象：把事件发出去，返回是否成功 */
export interface ITransport {
  send(events: MonitorEvent[]): Promise<boolean>
}

/** 浏览器实现：localStorage */
export class BrowserStorage implements IStorage {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // 隐私模式 / 配额超限时静默失败
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {
      // 静默失败
    }
  }
}

export interface BrowserTransportOptions {
  endpoint: string
  headers?: Record<string, string>
}

/** 浏览器实现：fetch 批量上报（keepalive 保证页面卸载时也能发出） */
export class BrowserTransport implements ITransport {
  private readonly endpoint: string
  private readonly headers: Record<string, string>

  constructor(options: BrowserTransportOptions) {
    this.endpoint = options.endpoint
    this.headers = { 'Content-Type': 'application/json', ...options.headers }
  }

  async send(events: MonitorEvent[]): Promise<boolean> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(events),
        keepalive: true,
      })
      return response.ok
    } catch {
      return false
    }
  }
}

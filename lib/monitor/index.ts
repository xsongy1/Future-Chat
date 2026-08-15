/**
 * Monitor 单例模块
 *
 * 提供全局唯一的 Monitor 实例，配置所有插件。
 *
 * 实例挂载在 globalThis 上：埋点 SDK 本质是页面级单例（trace-helper / debug hooks
 * 都在组件外同步调用 getMonitor()），挂到 globalThis 可避免 HMR 重新求值本模块时
 * 产生第二个实例（旧实例的定时器/离线队列会被孤儿化）。会话生命周期仍由
 * MonitorProvider（React）管理。
 */

'use client'

import {
  Monitor,
  TransportPlugin,
  DedupePlugin,
  ErrorPlugin,
  PerformancePlugin,
  FetchPlugin,
  OfflineQueuePlugin,
  BrowserStorage,
  BrowserTransport,
} from '@jerry_aurora/sky-monitor-sdk'
import { CompatTracePlugin } from './compat/trace'
import { CompatSessionPlugin } from './compat/session'
import { CompatDebugPlugin } from './compat/debug'
import type { MonitorWithPlugins } from './types'

// 单例挂载点：跨模块重求值（HMR）复用同一实例，避免多实例
const GLOBAL_KEY = '__SKY_MONITOR__'
const globalRef = globalThis as { [GLOBAL_KEY]?: MonitorWithPlugins | null }

let monitor: MonitorWithPlugins | null = globalRef[GLOBAL_KEY] ?? null
let isInitializing = false

/**
 * 初始化 Monitor 实例
 */
function initMonitor(): MonitorWithPlugins {
  const isDev = process.env.NODE_ENV === 'development'
  const endpoint = '/api/monitor'

  // 创建 Monitor 实例
  const instance = new Monitor({
    appId: 'sky-chat-app',
    debug: isDev,
    storage: new BrowserStorage(),
  })

  // ========== 调试插件（仅开发环境）==========
  if (isDev) {
    instance.use(new CompatDebugPlugin({ maxEvents: 500 }))
  }

  // ========== 核心插件（兼容层实现，API 与本地开发版 SDK 对齐）==========
  instance.use(new CompatTracePlugin())
  instance.use(new CompatSessionPlugin())

  // ========== 自动采集插件 ==========
  instance.use(new ErrorPlugin())
  instance.use(new PerformancePlugin())
  instance.use(
    new FetchPlugin({
      excludeUrls: [/\/api\/monitor/, /\/api\/chat/],
    })
  )

  // ========== 管道插件 ==========
  instance.use(
    new DedupePlugin({
      windowMs: 1000,
    })
  )

  // ========== 上报插件 ==========
  instance.use(new OfflineQueuePlugin())
  instance.use(
    new TransportPlugin({
      endpoint,
      transport: new BrowserTransport(endpoint),
      mode: 'batch',
      batchSize: 10,
      flushInterval: 5000,
      maxRetries: 3,
      maxBufferSize: 100,
      criticalTypes: ['sse_error', 'js_error', 'promise_error'],
    })
  )

  // 类型断言：插件会动态注入方法
  return instance as unknown as MonitorWithPlugins
}

/**
 * 获取 Monitor 单例（懒加载）
 */
export function getMonitor(): MonitorWithPlugins | null {
  // 服务端渲染时返回 null
  if (typeof window === 'undefined') return null

  // 防止重复初始化
  if (isInitializing) return null

  if (!monitor) {
    isInitializing = true
    try {
      monitor = initMonitor()
      globalRef[GLOBAL_KEY] = monitor
    } finally {
      isInitializing = false
    }
  }

  return monitor
}

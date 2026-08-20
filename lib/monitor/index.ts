/**
 * Monitor 单例模块（纯装配层）
 *
 * 只做一件事：用新 SDK（@sky-monitor/sdk）组装插件，提供全局唯一实例。
 * Trace/Session 已是 SDK 核心一等 API，不再需要任何兼容层。
 *
 * 实例挂载在 globalThis 上：埋点 SDK 本质是页面级单例（trace-helper / debug hooks
 * 都在组件外同步调用 getMonitor()），挂到 globalThis 可避免 HMR 重新求值本模块时
 * 产生第二个实例（旧实例的定时器/离线队列会被孤儿化）。会话生命周期仍由
 * MonitorProvider（React）管理。
 */

'use client'

import {
  Monitor,
  ErrorPlugin,
  PerformancePlugin,
  NetworkPlugin,
  DedupePlugin,
  SamplingPlugin,
  TransportPlugin,
  DebugPlugin,
  BrowserStorage,
  BrowserTransport,
} from '@sky-monitor/sdk'
import type { Monitor as MonitorInstance } from '@sky-monitor/sdk'

// 单例挂载点：跨模块重求值（HMR）复用同一实例，避免多实例
const GLOBAL_KEY = '__SKY_MONITOR__'
const globalRef = globalThis as { [GLOBAL_KEY]?: MonitorInstance | null }

let monitor: MonitorInstance | null = globalRef[GLOBAL_KEY] ?? null
let isInitializing = false

/**
 * 初始化 Monitor 实例
 *
 * 插件管道顺序由 priority 自动排序，与注册顺序无关：
 *   debug(1000) → error/performance/network(200) → dedupe(100) → sampling(50) → transport(-1000)
 */
function initMonitor(): MonitorInstance {
  const isDev = process.env.NODE_ENV === 'development'
  const endpoint = '/api/monitor'

  const instance = new Monitor({
    appId: 'sky-chat-app',
    debug: isDev,
  })

  // ========== 调试插件（仅开发环境）==========
  if (isDev) {
    instance.use(new DebugPlugin({ maxEvents: 500 }))
  }

  // ========== 自动采集插件 ==========
  instance.use(
    new ErrorPlugin({
      ignoreErrors: [/ResizeObserver/i],
    })
  )
  instance.use(new PerformancePlugin())
  instance.use(
    new NetworkPlugin({
      excludeUrls: [/\/api\/monitor/, /\/api\/chat/],
    })
  )

  // ========== 处理插件 ==========
  instance.use(new DedupePlugin({ windowMs: 1000 }))

  // 采样：默认全量；生产可用 NEXT_PUBLIC_MONITOR_SAMPLE_RATE 降采样，
  // session 模式保证同一会话内行为一致，错误事件永远 100% 采样
  const sampleRate = Number(process.env.NEXT_PUBLIC_MONITOR_SAMPLE_RATE ?? 1)
  if (sampleRate < 1) {
    instance.use(
      new SamplingPlugin({
        rate: sampleRate,
        mode: 'session',
        alwaysSample: ['sse_error', 'js_error', 'promise_error'],
      })
    )
  }

  // ========== 上报插件 ==========
  instance.use(
    new TransportPlugin({
      endpoint,
      transport: new BrowserTransport({ endpoint }),
      mode: 'batch',
      batchSize: 10,
      flushInterval: 5000,
      maxRetries: 3,
      maxBufferSize: 100,
      criticalTypes: ['sse_error', 'js_error', 'promise_error'],
      offlineStorage: new BrowserStorage(),
    })
  )

  return instance
}

/**
 * 获取 Monitor 单例（懒加载）
 */
export function getMonitor(): MonitorInstance | null {
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

/**
 * Sky Monitor SDK - 轻量级 AI 应用监控
 *
 * 插件化管道：采集（error/performance/network）→ 处理（dedupe/sampling/debug）→ 上报（transport）
 * Trace / Session 一等 API：SSE 链路追踪（TTFB/TTLB/阶段/工具调用/卡顿/重试）
 *
 * 调试面板（React）从 './debug' 子路径导入。
 */

// 核心
export { Monitor } from './core/monitor'
export { Trace } from './core/trace'
export { Session } from './core/session'
export { BrowserStorage, BrowserTransport } from './core/storage'
export { generateEventId, generateTraceId, generateSessionId, generateToolCallId } from './core/ids'

// 类型
export type {
  MonitorContext,
  MonitorEvent,
  MonitorOptions,
  Plugin,
  ToolResult,
  TraceOptions,
} from './core/types'
export type { TraceState, TraceEmitFn } from './core/trace'
export type { SessionStats } from './core/session'
export type { IStorage, ITransport, BrowserTransportOptions } from './core/storage'

// 插件
export { DedupePlugin } from './plugins/dedupe'
export type { DedupePluginOptions } from './plugins/dedupe'
export { SamplingPlugin } from './plugins/sampling'
export type { SamplingMode, SamplingPluginOptions } from './plugins/sampling'
export { ErrorPlugin } from './plugins/error'
export type { ErrorPluginOptions } from './plugins/error'
export { PerformancePlugin } from './plugins/performance'
export type { PerformancePluginOptions } from './plugins/performance'
export { NetworkPlugin } from './plugins/network'
export type { NetworkPluginOptions } from './plugins/network'
export { TransportPlugin } from './plugins/transport'
export type { TransportMode, TransportPluginOptions } from './plugins/transport'
export { DebugPlugin } from './plugins/debug'
export type { DebugPluginOptions } from './plugins/debug'

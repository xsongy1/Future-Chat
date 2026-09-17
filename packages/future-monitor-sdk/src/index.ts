/**
 * Future-monitor-sdk - 轻量级 AI 应用监控
 *
 * 插件化管道：采集（error/performance/network）→ 处理（dedupe/sampling/debug）→ 上报（transport）
 * Trace / Session 一等 API：SSE 链路追踪（TTFB/TTLB/阶段/工具调用/卡顿/重试）
 *
 * 调试面板（React）从 './debug' 子路径导入。
 */

// 核心
export { Monitor } from './core/monitor.js'
export { Trace } from './core/trace.js'
export { Session } from './core/session.js'
export { BrowserStorage, BrowserTransport } from './core/storage.js'
export { generateEventId, generateTraceId, generateSessionId, generateToolCallId } from './core/ids.js'
export { estimateCost, getModelPrice, MODEL_PRICES } from './core/cost.js'

// 类型
export type {
  ErrorCode,
  MonitorContext,
  MonitorEvent,
  MonitorOptions,
  Plugin,
  TokenUsage,
  ToolResult,
  TraceError,
  TraceOptions,
} from './core/types.js'
export type { CostEstimate, ModelPrice } from './core/cost.js'
export type { TraceState, TraceEmitFn } from './core/trace.js'
export type { SessionStats } from './core/session.js'
export type { IStorage, ITransport, BrowserTransportOptions } from './core/storage.js'

// 插件
export { DedupePlugin } from './plugins/dedupe.js'
export type { DedupePluginOptions } from './plugins/dedupe.js'
export { SamplingPlugin } from './plugins/sampling.js'
export type { SamplingMode, SamplingPluginOptions } from './plugins/sampling.js'
export { ErrorPlugin } from './plugins/error.js'
export type { ErrorPluginOptions } from './plugins/error.js'
export { PerformancePlugin } from './plugins/performance.js'
export type { PerformancePluginOptions } from './plugins/performance.js'
export { NetworkPlugin } from './plugins/network.js'
export type { NetworkPluginOptions } from './plugins/network.js'
export { TransportPlugin } from './plugins/transport.js'
export type { TransportMode, TransportPluginOptions } from './plugins/transport.js'
export { DebugPlugin } from './plugins/debug.js'
export type { DebugPluginOptions } from './plugins/debug.js'

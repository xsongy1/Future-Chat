/**
 * Future-monitor-sdk - 轻量级 AI 应用监控
 *
 * 插件化管道：采集（error/performance/network）→ 处理（dedupe/sampling/debug）→ 上报（transport）
 * Trace / Session 一等 API：SSE 链路追踪（TTFB / First Chunk Latency / TTFT / TTLB / 阶段 /
 * 工具调用 / 卡顿 / 重试）
 *
 * 调试面板（React）从 './debug' 子路径导入：它是源码内子路径（依赖宿主设计系统，
 * 不随 npm 包发布，package.json 的 exports 里没有该条目），仅在配了 paths 映射的宿主里可用。
 */

// 核心
export { Monitor } from './core/monitor'
export { Trace } from './core/trace'
export { Session } from './core/session'
export { BrowserStorage, BrowserTransport } from './core/storage'
export { generateEventId, generateTraceId, generateSessionId, generateToolCallId } from './core/ids'
export { estimateCost, getModelPrice, MODEL_PRICES } from './core/cost'
export { defaultClock, readResourceTtfb, resourcePath, hasHighResClock } from './core/timing'

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
} from './core/types'
export type { CostEstimate, ModelPrice } from './core/cost'
export type {
  MetricPhase,
  TraceEmitFn,
  TraceMetrics,
  TraceState,
  TtfbSource,
} from './core/trace'
export type {
  Clock,
  ResourceEntrySource,
  ResourceTimingSample,
  ResourceTtfbOptions,
} from './core/timing'
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

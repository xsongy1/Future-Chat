/**
 * SDK 兼容层类型定义
 *
 * 本地开发版 SDK 有而 npm 0.2.0 缺失的 API，在此补充类型
 * 拿到新版 SDK 后可删除本目录，恢复直接引用
 */

/**
 * 错误回溯事件（本地开发版 SDK 的 DebugPlugin 提供）
 * npm 0.2.0 中不存在，这里按使用方（debug store / useDebugSubscription）定义的字段声明
 */
export interface ErrorReplayEvent {
  /** 事件类型: error_replay, replay_uploaded 等 */
  type: string
  /** 错误信息 */
  errorMessage?: string
  /** 错误发生的 URL */
  url?: string
  /** 发生时间戳 */
  timestamp?: number
  /** 关联的 traceId */
  traceId?: string
  /** 关联的 sessionId */
  sessionId?: string
  /** 附加载荷（如 replay_uploaded 时的 routes） */
  payload?: unknown
  [key: string]: unknown
}

/** DebugPlugin 兼容层配置 */
export interface DebugPluginOptions {
  /** 内存中保留的最大事件数 */
  maxEvents?: number
}

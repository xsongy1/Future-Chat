/**
 * Sky Monitor SDK 核心类型定义
 */

import type { Monitor } from './monitor'

/** 事件上下文：随事件一起上报的公共维度 */
export interface MonitorContext {
  /** 应用标识 */
  appId: string
  /** 会话 ID（自动注入） */
  sessionId?: string
  /** Trace ID（自动注入） */
  traceId?: string
  /** 其他自定义上下文（userId / version 等） */
  [key: string]: unknown
}

/** 统一事件信封：所有埋点/采集数据都走这个结构 */
export interface MonitorEvent {
  /** 事件唯一 ID（用于去重） */
  id: string
  /** 事件类型：sse_start / js_error / http_request / web_vital ... */
  type: string
  /** 发生时间戳（客户端毫秒） */
  timestamp: number
  /** 事件载荷 */
  data: Record<string, unknown>
  /** 事件上下文 */
  context: MonitorContext
}

export interface MonitorOptions {
  /** 应用标识 */
  appId: string
  /** 调试模式：控制台打印事件流 */
  debug?: boolean
  /** 初始全局上下文 */
  context?: Record<string, unknown>
}

/**
 * 插件接口
 *
 * 插件管道是 SDK 的核心抽象，按 priority 降序排列：
 *   采集插件（error/performance/network）→ 处理插件（dedupe/sampling/debug）→ 上报插件（transport）
 */
export interface Plugin {
  /** 插件名（唯一） */
  readonly name: string
  /** 管道优先级：值越大越先执行，默认 0 */
  readonly priority?: number
  /** 注册时调用一次：挂载全局监听、启动定时器 */
  setup?(monitor: Monitor): void
  /** 事件处理：可修改或丢弃事件（返回 null 表示丢弃） */
  processEvent?(event: MonitorEvent): MonitorEvent | null
  /** 刷新：强制处理缓冲中的数据（如批量上报） */
  flush?(): void | Promise<void>
  /** 重置：卸载监听、清理状态（测试/热更新场景） */
  reset?(): void
}

/** 工具调用结果（tool_end 事件载荷） */
export interface ToolResult {
  toolCallId?: string
  success: boolean
  imageUrl?: string
  width?: number
  height?: number
  resultCount?: number
  sources?: Array<{ title: string; url: string; snippet?: string }>
  error?: string
  [key: string]: unknown
}

/**
 * 结构化错误码：AI Chat 场景的统一错误分类
 */
export type ErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'PROVIDER_ERROR'
  | 'MODEL_ERROR'
  | 'INVALID_REQUEST'
  | 'STREAM_ERROR'

/** 结构化错误（sse_error 事件载荷） */
export interface TraceError {
  /** 错误码分类 */
  code?: ErrorCode
  /** 人类可读错误信息 */
  message?: string
  /** HTTP 状态码（如有） */
  statusCode?: number
  /** 是否可重试（供上层做自动重试/降级决策） */
  retryable?: boolean
  [key: string]: unknown
}

/** Token 用量（由后端透传 usage，前端 SDK 聚合成本） */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  /** 实际使用的模型（缺省用 Trace 的 model） */
  model?: string
}

/** Trace 创建选项 */
export interface TraceOptions {
  /** AI 消息 ID */
  aiMessageId: string
  /** 重试时的前一个 Trace ID（串联重试链路） */
  previousTraceId?: string
  /** 卡顿检测阈值（ms），默认 3000 */
  stallThreshold?: number
  /** 使用的模型（如 deepseek-ai/DeepSeek-V3.2），用于模型对比与成本核算 */
  model?: string
  /** 模型供应商（如 siliconflow/openai），缺省从 model 推导 */
  provider?: string
}

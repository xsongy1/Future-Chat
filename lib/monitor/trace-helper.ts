/**
 * 埋点辅助模块
 *
 * 封装所有埋点逻辑，让 chat.service 保持简洁
 * 所有方法都是安全的，Monitor 未初始化时静默返回
 */

'use client'

import type { TokenUsage, TraceError, ToolResult } from 'future-monitor-sdk'
import { getMonitor } from './index'

/**
 * 最近一条已结束的 Trace ID
 *
 * endTrace 会清空 currentTrace，重试时拿不到上一轮的 ID，
 * 这里留一份用于重试链路（previousTraceId）关联。
 */
let lastTraceId: string | undefined

/**
 * 创建并启动 Trace
 * @param aiMessageId - AI 消息 ID
 * @param previousTraceId - 重试时的原 Trace ID
 * @param model - 使用的模型（用于模型对比与成本核算）
 */
export function startTrace(
  aiMessageId: string,
  previousTraceId?: string,
  model?: string
): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.createTrace({ aiMessageId, previousTraceId, model })
    monitor.setCurrentTrace(trace)
    trace.start()

    // 统计对话次数
    const session = monitor.getSession()
    if (session) {
      session.incrementTraceCount()
    }
  } catch (e) {
    console.warn('[TraceHelper] startTrace failed:', e)
  }
}

/**
 * 结束当前 Trace
 * @param reason - 结束原因
 * @param error - 错误信息；字符串为简单错误，对象为结构化错误（code/statusCode/retryable）
 */
export function endTrace(
  reason: 'complete' | 'error' | 'abort',
  error?: string | TraceError
): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    // 先记下 ID：下面清空 currentTrace 之后就取不到了（重试链路要用）
    lastTraceId = trace.traceId

    switch (reason) {
      case 'complete':
        trace.complete()
        break
      case 'error':
        trace.error(error ?? 'Unknown error')
        break
      case 'abort':
        trace.abort(typeof error === 'string' ? error : 'user_cancel')
        break
    }

    monitor.setCurrentTrace(null)
  } catch (e) {
    console.warn('[TraceHelper] endTrace failed:', e)
  }
}

/**
 * 记录 Token 用量（后端透传 usage 后调用）
 */
export function setTraceUsage(usage: TokenUsage): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.setUsage(usage)
  } catch (e) {
    console.warn('[TraceHelper] setTraceUsage failed:', e)
  }
}

/**
 * 获取当前 Trace ID
 */
export function getCurrentTraceId(): string | undefined {
  try {
    const monitor = getMonitor()
    if (!monitor) return undefined

    const trace = monitor.getCurrentTrace()
    return trace?.traceId
  } catch {
    return undefined
  }
}

/**
 * 获取最近一条**已结束**的 Trace ID（用于重试链路关联）
 */
export function getLastTraceId(): string | undefined {
  return lastTraceId
}

/**
 * 把任意异常归类成结构化错误（TraceError）
 *
 * 一次回答的失败可能发生在三个阶段，这里用**同一套判定**，避免口径分裂：
 * - fetch 失败（chat.service）：TypeError 且无 status → NETWORK_ERROR
 * - 流读取中断（StreamHandler）：同上，属于网络类失败
 * - HTTP 非 2xx：带 statusCode，由 Trace 按码分类（429→RATE_LIMIT、401/403→AUTH_ERROR、5xx→PROVIDER_ERROR）
 *
 * `retryable` 供上层决定要不要自动重试：网络类失败、429、503 视为可重试。
 */
export function classifyStreamError(error: unknown): TraceError {
  const err = (error ?? {}) as Error & { status?: number }
  const message = err.message || 'Unknown error'
  const statusCode = typeof err.status === 'number' ? err.status : undefined
  const isNetworkError = err.name === 'TypeError' && statusCode === undefined

  return {
    code: isNetworkError ? 'NETWORK_ERROR' : undefined,
    message,
    statusCode,
    retryable: isNetworkError || statusCode === 429 || statusCode === 503,
  }
}

/**
 * 记录首个 chunk（First Chunk Latency）
 *
 * 常规路径不需要手写：SSEParser 每收到一个数据块就会调 recordRawChunk()，
 * 由 Trace 自己判断"是不是第一个"。这个显式入口留给没有走流的宿主。
 */
export function recordFirstChunk(): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.firstChunk()
  } catch (e) {
    console.warn('[TraceHelper] recordFirstChunk failed:', e)
  }
}

/**
 * 标记 T0：请求真正发出的时刻（所有延迟指标的基准）
 *
 * 必须在 fetch 之前调用，否则指标会把序列化 / 动态 import 等本地耗时算进去。
 *
 * @param url - 请求 URL（结束时用于 Resource Timing 校准 TTFB）
 */
export function markRequestStart(url?: string): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.markRequestStart({ url })
  } catch (e) {
    console.warn('[TraceHelper] markRequestStart failed:', e)
  }
}

/**
 * 标记首字节（TTFB）：fetch() resolve、HTTP 响应头到达
 *
 * 注意这不是第一个 SSE 帧——那是 First Chunk Latency。
 * 必须在 `await fetch()` 之后立刻调用，中间不要插入其它 await。
 */
export function markFirstByte(): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.firstByte()
  } catch (e) {
    console.warn('[TraceHelper] markFirstByte failed:', e)
  }
}

/**
 * 首个模型 token（TTFT）
 *
 * 只在带内容的 thinking / answer 增量帧上调用；role 帧、usage 帧、心跳都不算 token。
 *
 * @param phase - 该增量属于 thinking 还是 answer
 */
export function recordFirstToken(phase: 'thinking' | 'answer'): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.firstToken(phase)
  } catch (e) {
    console.warn('[TraceHelper] recordFirstToken failed:', e)
  }
}

/**
 * 网络层数据块到达（每次 reader.read() 拿到数据调用一次）
 *
 * 首个数据块即 First Chunk Latency，同时累计块数与字节数。
 */
export function recordRawChunk(bytes: number): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.rawChunk(bytes)
  } catch {
    // 静默失败，chunk 记录非常频繁
  }
}

/**
 * 记录 chunk（用于 stall 检测）
 */
export function recordChunk(): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.recordChunk()
  } catch {
    // 静默失败，chunk 记录非常频繁
  }
}

/**
 * 阶段开始
 * @param phase - 阶段名称
 */
export function startPhase(phase: 'thinking' | 'answer'): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.phaseStart(phase)
  } catch (e) {
    console.warn('[TraceHelper] startPhase failed:', e)
  }
}

/**
 * 阶段结束
 * @param phase - 阶段名称
 */
export function endPhase(phase: 'thinking' | 'answer'): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    trace.phaseEnd(phase)
  } catch (e) {
    console.warn('[TraceHelper] endPhase failed:', e)
  }
}


/**
 * 标准化外部 toolCallId，添加前缀
 */
function normalizeToolCallId(externalId: string): string {
  // 如果已经有 tool_ 前缀，直接返回
  if (externalId.startsWith('tool_')) return externalId
  return `tool_${externalId}`
}

/**
 * 工具调用开始（使用已有的 toolCallId）
 * @param toolCallId - 工具调用 ID（后端传入）
 * @param name - 工具名称
 * @param args - 工具参数
 */
export function startToolWithId(
  toolCallId: string,
  name: string,
  args?: Record<string, unknown>
): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    // 标准化 ID 格式
    const normalizedId = normalizeToolCallId(toolCallId)
    trace.toolStart(name, args, normalizedId)

    // 统计工具使用次数
    const session = monitor.getSession()
    if (session) {
      session.incrementToolUsage(name)
    }
  } catch (e) {
    console.warn('[TraceHelper] startToolWithId failed:', e)
  }
}

/**
 * 工具调用结束
 * @param name - 工具名称
 * @param result - 工具结果
 */
export function endTool(
  name: string,
  result: {
    toolCallId?: string
    success: boolean
    imageUrl?: string
    width?: number
    height?: number
    resultCount?: number
    sources?: Array<{ title: string; url: string; snippet?: string }>
    error?: string
  }
): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return

    const trace = monitor.getCurrentTrace()
    if (!trace) return

    // 标准化 ID 格式
    const normalizedResult = {
      ...result,
      toolCallId: result.toolCallId ? normalizeToolCallId(result.toolCallId) : undefined,
    }

    trace.toolEnd(name, normalizedResult as ToolResult)
  } catch (e) {
    console.warn('[TraceHelper] endTool failed:', e)
  }
}

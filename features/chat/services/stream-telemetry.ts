/**
 * StreamTelemetry - 流式埋点跟踪器
 *
 * 封装单次流式响应生命周期内的全部埋点：
 * - 首字节（TTFB）：由 chat.service 在 fetch resolve 后标记，不经过本类
 * - 首个数据块（First Chunk Latency）与逐块字节数
 * - 首个 token（TTFT / TTFA）
 * - 逐 SSE 事件计数与卡顿检测
 * - thinking / answer 阶段切换
 * - 工具开始 / 结束
 * - 流结束（complete / error / abort）
 *
 * 从 StreamHandler 中剥离，使流处理逻辑只关心数据，不掺杂埋点细节。
 *
 * 延迟口径见 SDK 的 trace.ts：所有指标共用 T0（请求真正发出的时刻），
 * 本类只负责在正确的时刻调用对应的方法，不做任何时长计算。
 */

import {
  recordChunk,
  recordRawChunk,
  recordFirstToken,
  startPhase,
  endPhase,
  endTrace,
  startToolWithId,
  endTool,
  setTraceUsage,
} from '@/lib/monitor/trace-helper'
import type { TraceError } from 'future-monitor-sdk'
import type { SearchSource } from '@/features/chat/types/chat'

export interface ToolEndResult {
  toolCallId?: string
  success: boolean
  imageUrl?: string
  width?: number
  height?: number
  resultCount?: number
  sources?: SearchSource[]
}

/** Token 用量（后端透传） */
export interface StreamUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export class StreamTelemetry {
  private currentPhase: 'thinking' | 'answer' | null = null
  /** Trace 是否已经结束（避免重复结束；Trace 自身也有幂等兜底） */
  private ended = false

  /**
   * 网络层数据块到达：每次 reader.read() 拿到数据调用一次
   *
   * 首个数据块即 First Chunk Latency（由 Trace 内部判定"是否第一个"）。
   */
  onRawChunk(bytes: number): void {
    recordRawChunk(bytes)
  }

  /**
   * 每个 SSE 事件调用一次：事件计数 + 卡顿检测
   *
   * 注意这不是 First Chunk Latency：一个数据块可能包含多个事件，
   * 一个事件也可能被拆在多个数据块里。
   */
  onChunk(): void {
    recordChunk()
  }

  /**
   * 首个带去内容的 token（TTFT）
   *
   * 只在该事件确实是模型生成的增量内容时调用：
   * role 帧、usage 帧、tool 相关帧、心跳都不算 token。
   */
  onToken(phase: 'thinking' | 'answer'): void {
    recordFirstToken(phase)
  }

  /**
   * 阶段切换：结束上一个阶段（如有），开始新阶段
   */
  onPhaseChange(phase: 'thinking' | 'answer'): void {
    if (this.currentPhase && this.currentPhase !== phase) {
      endPhase(this.currentPhase)
    }
    startPhase(phase)
    this.currentPhase = phase
  }

  /**
   * 工具调用开始
   */
  onToolStart(toolCallId: string, name: string, args?: Record<string, unknown>): void {
    startToolWithId(toolCallId, name, args)
  }

  /**
   * 工具调用结束
   */
  onToolEnd(name: string, result: ToolEndResult): void {
    endTool(name, result)
  }

  /**
   * Token 用量（后端透传 usage 事件）
   */
  onUsage(usage: StreamUsage): void {
    setTraceUsage(usage)
  }

  /**
   * 流内容结束（收到 complete 事件 / 解析器兜底回调）：只收尾阶段
   *
   * 这里 **不结束 Trace**：TTLB 是"末字节"，要等流真正关闭（见 onStreamClosed），
   * 否则末字节会被算小，也拿不到 Resource Timing 对 TTFB 的校准。
   */
  onStreamEnd(): void {
    if (this.currentPhase) {
      endPhase(this.currentPhase)
      this.currentPhase = null
    }
  }

  /**
   * 流真正关闭（reader 读到 done / 出错 / 中断后必然执行）
   *
   * 正常结束的 Trace 在这里收口：此时响应体已收完，Resource Timing 可能已可用，
   * TTFB 会被校准一次，然后 TTLB 才按"末字节"计算。
   */
  onStreamClosed(): void {
    if (this.ended) return
    this.finish('complete')
  }

  /**
   * 结束 Trace。
   * 幂等：complete 事件、兜底回调、流关闭、中断都会走到这里，Trace 本身也保证只发一次结束事件。
   *
   * @param error - 字符串或结构化错误（code/statusCode/retryable）。
   *   流中途出错要传结构化错误，否则 statusCode/retryable 会在结束这一跳丢掉。
   */
  finish(reason: 'complete' | 'error' | 'abort', error?: string | TraceError): void {
    // 阶段收尾：任何结束方式都要先关掉当前阶段（重复调用无害）
    this.onStreamEnd()
    if (this.ended) return
    endTrace(reason, error)
    this.ended = true
  }
}

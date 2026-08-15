/**
 * StreamTelemetry - 流式埋点跟踪器
 *
 * 封装单次流式响应生命周期内的全部埋点：
 * - 首个 chunk（TTFB）与逐 chunk 计数（stall 检测）
 * - thinking / answer 阶段切换
 * - 工具开始 / 结束
 * - 流结束（complete / error / abort）
 *
 * 从 StreamHandler 中剥离，使流处理逻辑只关心数据，不掺杂埋点细节。
 */

import {
  recordFirstChunk,
  recordChunk,
  startPhase,
  endPhase,
  endTrace,
  startToolWithId,
  endTool,
} from '@/lib/monitor/trace-helper'
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

export class StreamTelemetry {
  private isFirstChunk = true
  private currentPhase: 'thinking' | 'answer' | null = null
  private traceEnded = false

  /**
   * 每个 SSE data 事件调用一次：
   * 记录首个 chunk（TTFB）与逐 chunk 计数（stall 检测）
   */
  onChunk(): void {
    if (this.isFirstChunk) {
      recordFirstChunk()
      this.isFirstChunk = false
    }
    recordChunk()
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
   * 流结束：结束当前阶段并结束 Trace。
   * 幂等：complete 事件与 onComplete 兜底回调都会调用，不会重复结束。
   */
  finish(reason: 'complete' | 'error' | 'abort', errorMsg?: string): void {
    if (this.currentPhase) {
      endPhase(this.currentPhase)
      this.currentPhase = null
    }
    // 已通过 complete/error 结束过 Trace，onComplete 兜底不再重复结束
    if (reason === 'complete' && this.traceEnded) return
    endTrace(reason, errorMsg)
    this.traceEnded = true
  }
}

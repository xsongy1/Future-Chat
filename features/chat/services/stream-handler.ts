/**
 * StreamHandler - SSE 流处理器
 *
 * 负责消费一次流式响应（一条 AI 消息），按事件类型分发到单一职责的处理方法：
 * - thinking / answer：缓冲（StreamBuffer）→ 写入 store
 * - tool_call / tool_progress / tool_result：工具调用状态（只写 messages[].toolInvocations）
 * - complete / error：收尾（刷新缓冲、结束流式状态、埋点）
 *
 * 埋点（StreamTelemetry）与工具轮内容管理（RoundContentTracker）均为独立模块，
 * 解析由 SSEParser 完成，本类只做编排与 store 写入。
 */

import { nanoid } from 'nanoid'
import { useChatStore } from '@/features/chat/store/chat.store'
import { SSEParser } from '@/features/chat/utils/sse-parser'
import { StreamBuffer } from '@/features/chat/utils/stream-buffer'
import { sanitizeToolCallSyntax } from '@/shared/utils/sanitize-tool-syntax'
import { classifyStreamError } from '@/lib/monitor/trace-helper'
import type { SSEData } from '@/features/chat/types/chat'
import { StreamTelemetry } from './stream-telemetry'
import { RoundContentTracker } from './round-content-tracker'

export class StreamHandler {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private messageId: string

  private thinkingBuffer: StreamBuffer
  private answerBuffer: StreamBuffer
  private telemetry = new StreamTelemetry()
  private rounds: RoundContentTracker

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, messageId: string) {
    this.reader = reader
    this.messageId = messageId

    // 两个独立的 buffer：thinking 和 answer（rAF 批量刷新，优化渲染性能）
    this.thinkingBuffer = new StreamBuffer({
      onFlush: (content) => useChatStore.getState().appendThinking(messageId, content),
    })
    this.answerBuffer = new StreamBuffer({
      onFlush: (content) => useChatStore.getState().appendContent(messageId, content),
    })

    this.rounds = new RoundContentTracker({
      getContent: () =>
        useChatStore.getState().messages.find((m) => m.id === messageId)?.content ?? '',
      setContent: (content) => useChatStore.getState().updateMessage(messageId, { content }),
      clearAnswerBuffer: () => this.answerBuffer.clear(),
      forceFlushAnswer: () => this.answerBuffer.forceFlush(),
    })
  }

  /**
   * 开始消费 SSE 流，直到流结束、出错或中断
   */
  async run(): Promise<void> {
    try {
      await SSEParser.parseStream(this.reader, {
        // 数据块到达 → First Chunk Latency（比事件解析更早、更接近真实到达时间）
        onChunk: (bytes) => this.telemetry.onRawChunk(bytes),
        onData: (data) => this.handleData(data),
        onError: (error) => this.handleError(error),
        onComplete: () => this.finishStream('complete'),
        // 中断单独走一条通道：否则用户点停止会被记成"正常完成"
        onAbort: () => this.finishStream('abort'),
      })
    } finally {
      this.thinkingBuffer.destroy()
      this.answerBuffer.destroy()
      // 注销登记：中断后才能确定"当前没有在飞的 buffer 需要 flush"
      if (useChatStore.getState().activeStreamHandler === this) {
        useChatStore.getState().setActiveStreamHandler(null)
      }
      // 流已真正关闭：校准 TTFB 并按"末字节"结算 TTLB（正常结束的 Trace 在这里收口）
      this.telemetry.onStreamClosed()
    }
  }

  /**
   * 把两条缓冲里尚未 flush 的内容同步写入 store
   *
   * 停止生成时必须先调用它、再读 store 组 save-partial 请求体：
   * 否则 buffer 里"最后一帧"的内容只会在 UI 显示，不进数据库（刷新后消失）。
   * 与 finishStream / handleError 里的 forceFlush 是同一个操作，幂等。
   */
  flushBuffers(): void {
    this.thinkingBuffer.forceFlush()
    this.answerBuffer.forceFlush()
  }

  /** 事件分发 */
  private handleData(data: SSEData): void {
    // ========== 埋点：逐 SSE 事件计数 + 卡顿检测 ==========
    this.telemetry.onChunk()

    switch (data.type) {
      case 'thinking':
        // ========== 埋点：首个 token（TTFT） ==========
        if (data.content) this.telemetry.onToken('thinking')
        this.handleThinking(data)
        break
      case 'answer':
        // ========== 埋点：首个 token（TTFT / TTFA） ==========
        if (data.content) this.telemetry.onToken('answer')
        this.handleAnswer(data)
        break
      case 'tool_call':
        this.handleToolCall(data)
        break
      case 'tool_progress':
        this.handleToolProgress(data)
        break
      case 'tool_result':
        this.handleToolResult(data)
        break
      case 'usage':
        // ========== 埋点：Token 用量（成本/吞吐） ==========
        if (data.usage) {
          this.telemetry.onUsage(data.usage)
        }
        break
      case 'complete':
        this.finishStream()
        break
    }
  }

  /** thinking 内容 */
  private handleThinking(data: SSEData): void {
    if (!data.content) return
    const s = useChatStore.getState()

    if (s.streamingPhase !== 'thinking') {
      s.startStreaming(this.messageId, 'thinking')
      s.updateMessage(this.messageId, { displayState: 'streaming' })
      // ========== 埋点：阶段切换 ==========
      this.telemetry.onPhaseChange('thinking')
    }
    this.thinkingBuffer.append(data.content)
  }

  /** answer 内容（工具轮内的前置文本被丢弃，与后端持久化一致） */
  private handleAnswer(data: SSEData): void {
    if (!data.content || this.rounds.suppressingAnswer) return

    // 清理模型偶发的工具调用语法残片（如 `} </tool_call>`）
    const cleanedContent = sanitizeToolCallSyntax(data.content)
    if (!cleanedContent) return

    const s = useChatStore.getState()
    if (s.streamingPhase !== 'answer') {
      s.startStreaming(this.messageId, 'answer')
      s.updateMessage(this.messageId, { displayState: 'streaming' })
      // ========== 埋点：阶段切换 ==========
      this.telemetry.onPhaseChange('answer')
    }
    this.answerBuffer.append(cleanedContent)
  }

  /** 工具调用开始 */
  private handleToolCall(data: SSEData): void {
    const toolCallId = data.toolCallId || nanoid()

    // 新一轮工具调用：丢弃该轮已流式显示的前置文本（与后端持久化一致）
    this.rounds.onToolRoundStart()

    // ========== 埋点：工具开始 ==========
    this.telemetry.onToolStart(toolCallId, data.name || 'unknown', {
      query: data.query,
      prompt: data.prompt,
    })

    const s = useChatStore.getState()
    const invocations = s.messages.find((m) => m.id === this.messageId)?.toolInvocations || []
    s.updateMessage(this.messageId, {
      toolInvocations: [
        ...invocations,
        {
          toolCallId,
          name: data.name || 'unknown',
          state: 'running' as const,
          args: {
            query: data.query,
            prompt: data.prompt,
          },
        },
      ],
      displayState: 'streaming',
    })
  }

  /** 工具执行进度更新（不埋点，太频繁） */
  private handleToolProgress(data: SSEData): void {
    if (!data.toolCallId || data.progress === undefined) return
    useChatStore
      .getState()
      .updateToolProgress(this.messageId, data.toolCallId, data.progress, data.estimatedTime)
  }

  /** 工具结果返回 */
  private handleToolResult(data: SSEData): void {
    const s = useChatStore.getState()
    const cancelled = !!data.cancelled

    // ========== 埋点：工具结束 ==========
    this.telemetry.onToolEnd(data.name || 'unknown', {
      toolCallId: data.toolCallId,
      success: data.success ?? false,
      imageUrl: data.imageUrl,
      width: data.width,
      height: data.height,
      resultCount: data.resultCount,
      sources: data.sources,
    })

    const invocations = s.messages.find((m) => m.id === this.messageId)?.toolInvocations || []
    const updatedInvocations = invocations.map((inv) => {
      const isMatch = data.toolCallId
        ? inv.toolCallId === data.toolCallId
        : inv.name === data.name && inv.state === 'running'
      if (isMatch) {
        return {
          ...inv,
          state: cancelled
            ? ('cancelled' as const)
            : data.success
              ? ('completed' as const)
              : ('failed' as const),
          result: {
            success: data.success ?? false,
            cancelled,
            imageUrl: data.imageUrl,
            resultCount: data.resultCount,
            sources: data.sources,
            knowledgeSources: data.knowledgeSources,
            status: data.status,
            width: data.width,
            height: data.height,
          },
        }
      }
      return inv
    })

    // 图片生成完成时，直接插入图片到 content 流
    if (data.name === 'generate_image' && data.success && data.imageUrl) {
      const imageData = JSON.stringify({
        url: data.imageUrl,
        alt:
          invocations.find((inv) => inv.toolCallId === data.toolCallId)?.args?.prompt ||
          '生成的图片',
        width: data.width || 512,
        height: data.height || 512,
      })
      this.answerBuffer.append(`\n\`\`\`image\n${imageData}\n\`\`\`\n`)
    }

    s.updateMessage(this.messageId, { toolInvocations: updatedInvocations })

    // 本轮全部工具结束：恢复文本显示，并记录下一轮内容起点（保留已确认的图片等）
    this.rounds.onToolResult()
  }

  /**
   * 流内容结束：刷新缓冲、结束流式状态、按结局收尾埋点
   *
   * - complete：只收尾阶段，不结束 Trace——TTLB 是"末字节"，由 run() 的 finally
   *   在流真正关闭时结算（同时给 Resource Timing 校准 TTFB 的机会）
   * - abort：按中止结束 Trace（用户点停止 / 浏览器取消请求）
   */
  private finishStream(reason: 'complete' | 'abort' = 'complete'): void {
    this.flushBuffers()

    const s = useChatStore.getState()
    s.stopStreaming()
    s.updateMessage(this.messageId, { displayState: 'idle' })

    // ========== 埋点：阶段收尾（幂等，complete 事件与兜底回调只收尾一次） ==========
    if (reason === 'abort') {
      this.telemetry.finish('abort', 'stream_aborted')
    } else {
      this.telemetry.onStreamEnd()
    }
  }

  /** 流错误 */
  private handleError(error: Error): void {
    console.error('[StreamHandler] stream error:', error)
    this.flushBuffers()

    const s = useChatStore.getState()
    s.updateMessage(this.messageId, { hasError: true, displayState: 'error' })
    s.stopStreaming()

    // ========== 埋点：结构化错误 ==========
    // 必须在这里给出完整错误信息：Trace 到此结束，chat.service 的 catch 再补
    // endTrace 已经无效（当前 Trace 已被清空），statusCode/retryable 会丢
    this.telemetry.finish('error', classifyStreamError(error))
  }
}

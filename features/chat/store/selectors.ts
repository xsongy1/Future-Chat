/**
 * Chat Store Selectors
 *
 * 消息阶段与工具状态不再读取独立的 messageStates 运行时状态机，
 * 而是从唯一事实来源——消息数据（displayState / toolInvocations / hasError）
 * 与流式状态（streamingMessageId / streamingPhase）——派生而来。
 * 派生保证 UI 与数据永远一致，不存在"漏改另一份状态"的问题。
 */

import type { MessagePhase, ActiveTool } from '../types/message-state'
import type { Message, StreamingPhase } from '../types/chat'

// 定义 Store 状态类型（避免循环依赖）
interface ChatStoreState {
  messages: Message[]
  streamingMessageId: string | null
  streamingPhase: StreamingPhase
}

/** 阶段显示标签 */
const PHASE_LABELS: Record<MessagePhase, string> = {
  idle: '思考完成',
  thinking: '思考中',
  tool_calling: '工具调用中',
  answering: '回答中',
  error: '出错了',
}

/**
 * 从消息数据派生消息阶段
 * - 有错误标记 → error
 * - 正在流式且存在运行中/待处理的工具 → tool_calling
 * - 正在流式 → 按 streamingPhase 区分 thinking / answering
 * - 其余 → idle
 */
export const selectMessagePhase = (messageId: string) =>
  (state: ChatStoreState): MessagePhase => {
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg) return 'idle'
    if (msg.hasError || msg.displayState === 'error') return 'error'

    const isStreaming = state.streamingMessageId === messageId
    if (!isStreaming) return 'idle'

    const hasActiveTool = msg.toolInvocations?.some(
      (t) => t.state === 'running' || t.state === 'pending'
    )
    if (hasActiveTool) return 'tool_calling'
    return state.streamingPhase === 'thinking' ? 'thinking' : 'answering'
  }

/**
 * 获取消息活跃工具列表（由 messages[].toolInvocations 派生）
 */
export const selectActiveTools = (messageId: string) =>
  (state: ChatStoreState): ActiveTool[] => {
    const msg = state.messages.find((m) => m.id === messageId)
    if (!msg?.toolInvocations?.length) return []
    return msg.toolInvocations.map((inv) => ({
      toolCallId: inv.toolCallId,
      name: inv.name,
      state: inv.state,
      args: inv.args,
      progress: inv.progress,
      estimatedTime: inv.estimatedTime,
      result: inv.result
        ? {
            success: inv.result.success,
            data: inv.result,
            cancelled: Boolean(inv.result.cancelled),
          }
        : undefined,
    }))
  }

/**
 * 获取消息是否正在处理
 */
export const selectIsProcessing = (messageId: string) =>
  (state: ChatStoreState): boolean => {
    const phase = selectMessagePhase(messageId)(state)
    return phase !== 'idle' && phase !== 'error'
  }

/**
 * 获取阶段显示文本
 */
export const selectPhaseLabel = (messageId: string) =>
  (state: ChatStoreState): string => {
    const phase = selectMessagePhase(messageId)(state)
    return PHASE_LABELS[phase]
  }

/**
 * 获取是否有运行中的工具
 */
export const selectHasRunningTools = (messageId: string) =>
  (state: ChatStoreState): boolean => {
    const msg = state.messages.find((m) => m.id === messageId)
    return msg?.toolInvocations?.some((t) => t.state === 'running') ?? false
  }

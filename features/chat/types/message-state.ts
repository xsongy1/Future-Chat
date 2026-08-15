/**
 * 消息阶段类型定义
 *
 * 消息阶段不再由独立的运行时状态机维护（已移除 messageStates 双轨结构），
 * 而是由 store 中的消息数据（displayState / toolInvocations / hasError）
 * 与流式状态（streamingMessageId / streamingPhase）派生而来，见 store/selectors.ts。
 */

/** 消息阶段 */
export type MessagePhase = 
  | 'idle'          // 静止（已完成或未开始）
  | 'thinking'      // 思考中
  | 'tool_calling'  // 工具调用中
  | 'answering'     // 回答中
  | 'error'         // 错误

/** 工具状态 */
export type ToolState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** 工具调用信息（由 toolInvocations 派生，供旧选择器兼容使用） */
export interface ActiveTool {
  toolCallId: string
  name: string
  state: ToolState
  args?: Record<string, unknown>
  progress?: number  // 0-100，用于长时间运行的工具
  estimatedTime?: number  // 预估剩余时间（秒）
  result?: {
    success: boolean
    data?: unknown
    cancelled?: boolean
  }
}

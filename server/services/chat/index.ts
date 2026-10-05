/**
 * Chat Service 模块导出
 */

export { handleChatRequest, NotFoundError } from './chat.service'
export type { ChatRequest, ChatResponse } from './chat.service'
export {
  buildSystemPrompt,
  buildContextMessages,
  assembleMessages,
  appendAttachments,
} from './prompt.builder'
export { createSSEStream } from './stream.handler'
export { buildManagedContext, ContextBudgetExceededError } from './context'
export type { ContextMetrics } from './context'

/**
 * 上下文管理模块的对外入口
 *
 * 只导出调用方真正需要的东西：
 * - chat.service 用 `buildManagedContext` + `ContextBudgetExceededError`
 * - benchmark 用 `buildManagedContext` 与各纯函数做对照
 *
 * 内部实现（budget / window / compactor / truncate）不从这里透出，
 * 避免把模块内部的拆分变成对外契约——那样以后想合并文件都成了破坏性改动。
 */

export {
  buildManagedContext,
  ContextBudgetExceededError,
  type BuildManagedContextInput,
  type CompactionContext,
  type ContextBuildResult,
  type ConversationSummaryState,
} from './manager'

export {
  compareEstimatedToActual,
  estimateCost,
  type ContextFallbackReason,
  type ContextMetrics,
  type CostEstimate,
  type EstimationComparison,
  type TokenUsage,
} from './metrics'

export { getContextConfig, type ContextConfig } from './config'

export { TOKEN_ESTIMATOR_KIND, type TokenEstimatorKind } from './tokens'

export type { ContextAttachment, ContextHistoryMessage } from './types'

/**
 * 是否因为超出上下文长度而被 provider 拒绝
 *
 * 供应商的报错文案并不统一（有的回 `context_length_exceeded`，有的回
 * "maximum context length is N tokens" 之类），所以这里按关键词识别。
 *
 * `max_prompt_tokens` 是 **SiliconFlow 真实返回过的字段名**，务必保留：
 *
 * ```text
 * 400 - {"code":20015,"message":"number of input tokens (249319)
 *        has exceeded max_prompt_tokens (163840) limit."}
 * ```
 *
 * 识别失败也不致命：只是少了一次自动降级重试，用户会看到原始错误。
 * 反过来**误判**更危险（对无关错误做一次多余的 6 万 token 重试），
 * 所以最后一个兜底条件要求 token 与 exceed 同时出现。
 */
export function isContextLengthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  return (
    lower.includes('context_length_exceeded') ||
    lower.includes('context length') ||
    lower.includes('maximum context') ||
    lower.includes('max_prompt_tokens') ||
    lower.includes('max_tokens') ||
    lower.includes('too many tokens') ||
    (lower.includes('token') && lower.includes('exceed'))
  )
}

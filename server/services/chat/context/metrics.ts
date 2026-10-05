/**
 * 上下文指标与成本估算
 *
 * ## 为什么要有这个文件
 *
 * "上下文管理生效了"必须是可验证的断言，而不是感觉。每次构建上下文都产出一份
 * 结构化的 metrics，用于：
 * - 线上排查（为什么这一轮被压缩了 / 附件被截了多少）
 * - benchmark（Before / After 的对比基准）
 * - 估算误差校验（估算值 vs provider 返回的真实 prompt_tokens）
 *
 * ## 关于成本
 *
 * **不写死任何价格**。provider 报价会变、不同模型不同价、还可能走代理折扣价，
 * 在代码里硬编码一个数字，等于把一条会过期的错误信息伪装成事实。
 * 价格只从环境变量读（LLM_INPUT_PRICE_PER_1M_TOKENS / LLM_OUTPUT_PRICE_PER_1M_TOKENS），
 * 未配置时成本字段一律为 null，报告里就写"未配置价格，不做成本估算"。
 */

import type { TokenEstimatorKind } from './tokens'
import { TOKEN_ESTIMATOR_KIND } from './tokens'
import type { ContextConfig } from './config'

/** 降级原因：正常为 none */
export type ContextFallbackReason =
  /** 未降级 */
  | 'none'
  /** 预算不足，已丢弃全部历史（摘要仍保留） */
  | 'dropped-history'
  /** 连当前用户消息都放不下，已确定性截断用户消息 */
  | 'truncated-user-message'

export interface ContextMetrics {
  // ---- 窗口与预算 ----
  modelId: string
  contextWindow: number
  /** 窗口是否来自 CONTEXT_WINDOW_OVERRIDE（false = 用的是仓库里的保守下界） */
  contextWindowOverridden: boolean
  outputReserveTokens: number
  safetyMarginTokens: number
  /** 软预算：规划时按它分配各层 */
  availableContextTokens: number
  /** 硬上限 = 窗口 - 输出预留：发送前最终校验按它判（provider 真正会拒绝的那条线） */
  hardInputLimitTokens: number

  // ---- 各层占用（估算值） ----
  estimatedInputTokens: number
  systemTokens: number
  currentUserTokens: number
  /** 历史区合计 = 摘要 + 最近消息 */
  historyTokens: number
  summaryTokens: number
  recentMessageTokens: number
  attachmentTokens: number
  /** 知识库工具预留（RAG 独立成账，不混进 history） */
  ragReserveTokens: number
  /** 工具轮次总预留 */
  toolReserveTokens: number

  // ---- 预算上限（用于判断"用满了多少"） ----
  historyBudgetTokens: number
  recentBudgetTokens: number

  // ---- 条数 ----
  historyMessageCount: number
  retainedMessageCount: number

  /**
   * 残留缺口：既不在摘要里、也不在最近窗口里的消息的 token 数
   *
   * 这是"会丢信息"的量。正常情况下它应该被压缩控制在阈值以内；
   * 若它持续接近 historyBudget，说明压缩没跟上（阈值太高或摘要一直在失败）。
   */
  uncoveredTokens: number

  // ---- 压缩与截断 ----
  wasCompacted: boolean
  /** 摘要调用是否失败（失败时已退回确定性截断，聊天不受影响） */
  compactionFailed: boolean
  /** 是否复用了已持久化的摘要（命中缓存，未再次调用摘要模型） */
  summaryReused: boolean
  wasTruncated: boolean

  // ---- 附件 ----
  attachmentCount: number
  droppedAttachmentCount: number

  // ---- 降级与计时 ----
  fallback: ContextFallbackReason
  buildDurationMs: number
  estimator: TokenEstimatorKind

  /**
   * 本次输入的估算成本
   *
   * **只在配置了 `LLM_INPUT_PRICE_PER_1M_TOKENS` 时才有值，否则为 null**（不编造价格）。
   * 只算输入侧：输出 token 要等模型答完才知道，不属于"上下文构建"的职责；
   * 真实总成本请用流末尾 `usage` 事件里的真实 token 数配合同一个单价换算。
   */
  estimatedInputCost: number | null
}

/** 上游返回的真实 token 用量 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** 成本估算结果；未配置价格时各字段为 null */
export interface CostEstimate {
  inputCost: number | null
  outputCost: number | null
  totalCost: number | null
}

/**
 * 按单价估算成本
 *
 * @param usage - 真实（或估算的）token 用量
 * @param config - 提供单价；未配置单价时返回全 null
 */
export function estimateCost(
  usage: TokenUsage,
  config: ContextConfig
): CostEstimate {
  const inPrice = config.inputPricePer1MTokens
  const outPrice = config.outputPricePer1MTokens

  const inputCost =
    inPrice === null ? null : (usage.inputTokens / 1_000_000) * inPrice
  const outputCost =
    outPrice === null ? null : (usage.outputTokens / 1_000_000) * outPrice

  return {
    inputCost,
    outputCost,
    totalCost:
      inputCost === null || outputCost === null ? null : inputCost + outputCost,
  }
}

/** 估算值与真实值的对照结果 */
export interface EstimationComparison {
  estimatedInputTokens: number
  actualInputTokens: number | null
  /** (实际 - 估算) / 实际；正数表示估算偏低（危险方向），负数表示估算偏高（安全方向） */
  estimationErrorRatio: number | null
}

/**
 * 对比预估 token 与 provider 返回的真实 prompt_tokens
 *
 * 这个对照是"估算器是否真的保守"的唯一证据来源：
 * 若 estimationErrorRatio 长期为正，说明估算偏低，必须收紧系数。
 */
export function compareEstimatedToActual(
  estimatedInputTokens: number,
  actualInputTokens: number | null | undefined
): EstimationComparison {
  if (!actualInputTokens || actualInputTokens <= 0) {
    return {
      estimatedInputTokens,
      actualInputTokens: null,
      estimationErrorRatio: null,
    }
  }
  return {
    estimatedInputTokens,
    actualInputTokens,
    estimationErrorRatio:
      (actualInputTokens - estimatedInputTokens) / actualInputTokens,
  }
}

/**
 * 输出一行结构化指标日志
 *
 * ## 为什么是 console.warn 而不是 console.log
 *
 * `next.config.ts` 里配置了 `compiler.removeConsole = { exclude: ['error','warn'] }`，
 * 生产构建会把 `console.log` **整段删掉**（已实测：构建产物里连既有业务日志字符串
 * 都不存在）。指标日志是给运维看的，如果它在生产里被删掉，那"可观测"就只是开发机上
 * 的错觉。用 warn 是这里能被保留的最低级别。
 *
 * 用单行 JSON 而不是多行文本：既能 `grep '[Context]'` 捞出来，
 * 也能直接被日志系统按字段解析——不需要接监控 SDK、不写库、不增加任何请求成本。
 *
 * 测试环境跳过（一条 JSON 约 700 字节，跑一遍单测会打印上千行，把失败信息淹掉）；
 * 需要断言日志内容时在用例里临时改 NODE_ENV 再调用。
 * 生产可用 `CONTEXT_METRICS_LOG=off` 关掉。
 */
export function logContextMetrics(metrics: ContextMetrics): void {
  if (process.env.NODE_ENV === 'test') return
  if (process.env.CONTEXT_METRICS_LOG === 'off') return
  console.warn(`[Context] ${JSON.stringify(metrics)}`)
}

/** 构建 metrics 时省略掉"由调用方填充"的字段，避免两处各写一遍默认值 */
export type ContextMetricsDraft = Omit<
  ContextMetrics,
  'estimator' | 'buildDurationMs'
> & {
  buildDurationMs?: number
}

/** 补齐默认字段，保证 metrics 结构稳定（下游解析不必判 undefined） */
export function finalizeMetrics(draft: ContextMetricsDraft): ContextMetrics {
  return {
    ...draft,
    buildDurationMs: draft.buildDurationMs ?? 0,
    estimator: TOKEN_ESTIMATOR_KIND,
  }
}

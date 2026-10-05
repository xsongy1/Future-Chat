/**
 * 分层上下文预算
 *
 * ## 唯一一份预算实现
 *
 * 整个上下文管理里"谁能用多少 token"只由这个文件决定。
 * manager / window / attachments / compactor 一律接收**算好的预算数字**，
 * 不允许自己再算一遍（重复实现必然导致两处口径漂移）。
 *
 * ## 分层顺序
 *
 * ```
 * contextWindow                      模型总窗口
 * ├── outputReserve                  completion 预留（= 真实下发的 max_tokens）
 * ├── safetyMargin                   估算误差边际
 * └── availableContext              可分配给输入部分的总量
 *     ├── system                    system prompt
 *     ├── currentUser               当前用户消息正文
 *     ├── toolReserve               工具轮次预留（按实际启用的工具算）
 *     ├── attachment                附件（截断后实际占用）
 *     └── history                   历史区
 *         ├── summary               已持久化的摘要
 *         └── recent                最近若干条消息
 * ```
 *
 * 分两阶段是必要的：附件的**上限**要在截断前算（第 1 阶段），
 * 附件的**实际占用**只有截断后才知道（第 2 阶段），而历史预算依赖实际占用。
 * 把这两件事硬塞进一个函数只能靠"先假设附件用满"之类的近似，
 * 那会让历史预算凭空少掉一半。
 */

import { resolveMaxOutputTokens, type Model } from '@/shared/constants/models'
import { calculateToolReserveTokens, type ContextConfig } from './config'

/** 可用上下文的下限：窗口配得再离谱也要留一点点空间，否则预算全为 0、什么都发不出去 */
const MIN_AVAILABLE_CONTEXT_TOKENS = 512

/** 输出预留最多只能占窗口的这个比例（只在窗口被配置得过小时触发） */
const MAX_OUTPUT_RESERVE_RATIO = 0.5

/** 窗口与输出预留的解析结果 */
export interface ContextWindowPlan {
  modelId: string
  /** 实际使用的窗口（可能来自环境变量覆盖） */
  contextWindow: number
  /** 是否来自环境变量覆盖（用于在 metrics 里标记"窗口未经 provider 核实"） */
  contextWindowOverridden: boolean
  /** completion 预留，与真实请求下发的 max_tokens 同源 */
  outputReserveTokens: number
  /** 估算误差边际 */
  safetyMarginTokens: number
  /**
   * 可分配给输入部分的总量（**软预算**，已扣掉安全边际）
   *
   * 规划时按它分配各层，让估算误差有地方吸收。
   */
  availableContextTokens: number
  /**
   * 输入部分的**硬上限** = 窗口 - 输出预留
   *
   * 这是 provider 真正会拒绝的那条线，发送前的最终校验按它判。
   * 与软预算分开的原因：窗口选择为了保住"整轮对话"允许小幅超预算
   * （见 window.ts 的容差），这点超出应该被安全边际吸收，
   * 而不该被当成"超窗"从而触发把所有历史丢光的降级。
   */
  hardInputLimitTokens: number
}

export interface ContextBudgetPlan extends ContextWindowPlan {
  systemTokens: number
  /** 当前用户消息正文（不含附件） */
  currentUserTokens: number
  toolReserveTokens: number
  /** 按工具拆分的预留明细，用于 metrics 单独报 RAG 预留 */
  toolReservePerTool: Record<string, number>
  /** 知识库工具的预留部分（RAG 独立成账，不混进 history） */
  ragReserveTokens: number
  /** 附件可用的 token 上限（截断目标） */
  attachmentBudgetTokens: number
}

export interface ContextBudget extends ContextBudgetPlan {
  /** 附件截断后的实际占用 */
  attachmentTokens: number
  /** 摘要实际占用（无摘要时为 0） */
  summaryTokens: number
  /** 历史区总预算 = 摘要 + 最近消息 */
  historyBudgetTokens: number
  /** 最近消息可用的预算 = historyBudget - summary 实际占用 */
  recentBudgetTokens: number
  /** 未被任何层占用的可用上下文（正常情况是历史没用满的部分） */
  unallocatedTokens: number
  /** 超预算的 token 数（> 0 表示"连 history 砍到 0 都放不下"，需要走降级） */
  overflowTokens: number
}

/**
 * 解析上下文窗口与输出预留
 *
 * 窗口取值优先级：环境变量覆盖 > 模型白名单声明。
 * 模型声明的是**保守下界**（见 shared/constants/models.ts 的说明），
 * 环境变量是部署方核对 provider 文档后的精确值。
 */
export function resolveContextWindowPlan(
  model: Model | undefined,
  enableThinking: boolean,
  config: ContextConfig
): ContextWindowPlan {
  const declared = model?.contextWindow ?? 0
  const overridden = config.contextWindowOverride !== null
  const contextWindow = overridden ? config.contextWindowOverride! : declared

  if (!contextWindow || contextWindow <= 0) {
    throw new Error(
      `[Context] 无法确定上下文窗口：模型 "${model?.id ?? 'unknown'}" 未声明 contextWindow，` +
        `且未设置 CONTEXT_WINDOW_OVERRIDE。请在 shared/constants/models.ts 补上声明，` +
        `或用环境变量指定窗口。`
    )
  }

  // 输出预留与真实下发的 max_tokens 同源，避免"预算按 1024 留、请求按 4096 发"
  let outputReserveTokens = resolveMaxOutputTokens(model, enableThinking)
  const outputCap = Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO)
  if (outputReserveTokens > outputCap) {
    console.warn(
      `[Context] 上下文窗口 ${contextWindow} 过小（CONTEXT_WINDOW_OVERRIDE 可能配错）：` +
        `输出预留 ${outputReserveTokens} 超过窗口的 ${MAX_OUTPUT_RESERVE_RATIO * 100}%，` +
        `已压到 ${outputCap}。注意真实请求仍按 ${outputReserveTokens} 下发 max_tokens。`
    )
    outputReserveTokens = outputCap
  }

  const afterOutput = contextWindow - outputReserveTokens
  const safetyMarginTokens = Math.floor(afterOutput * config.safetyMarginRatio)
  const availableContextTokens = Math.max(
    MIN_AVAILABLE_CONTEXT_TOKENS,
    afterOutput - safetyMarginTokens
  )

  return {
    modelId: model?.id ?? 'unknown',
    contextWindow,
    contextWindowOverridden: overridden,
    outputReserveTokens,
    safetyMarginTokens,
    availableContextTokens,
    hardInputLimitTokens: afterOutput,
  }
}

export interface PlanContextBudgetInput {
  model: Model | undefined
  enableThinking: boolean
  config: ContextConfig
  systemTokens: number
  currentUserTokens: number
  /** 本轮实际启用的工具名（用于只给真正会产出大载荷的工具预留） */
  enabledToolNames: readonly string[]
}

/**
 * 第一阶段：算各层**上限**（在附件截断之前调用）
 *
 * 附件上限的取法：剩余空间的一半与绝对上限取小。
 * 取一半而不是全部，是因为"附件能吃光所有剩余空间"会直接把历史挤成空窗口——
 * 用户上传一个 1MB 文件之后，对话本身就失忆了，这显然不是想要的行为。
 */
export function planContextBudget(
  input: PlanContextBudgetInput
): ContextBudgetPlan {
  const {
    model,
    enableThinking,
    config,
    systemTokens,
    currentUserTokens,
    enabledToolNames,
  } = input

  const window = resolveContextWindowPlan(model, enableThinking, config)
  const toolReserve = calculateToolReserveTokens(
    enabledToolNames,
    window.availableContextTokens
  )

  const remainingBeforeAttachments = Math.max(
    0,
    window.availableContextTokens -
      systemTokens -
      currentUserTokens -
      toolReserve.total
  )

  const attachmentBudgetTokens = Math.max(
    0,
    Math.min(
      Math.floor(remainingBeforeAttachments * config.attachmentShareRatio),
      config.attachmentMaxTokens
    )
  )

  return {
    ...window,
    systemTokens,
    currentUserTokens,
    toolReserveTokens: toolReserve.total,
    toolReservePerTool: toolReserve.perTool,
    ragReserveTokens: toolReserve.perTool.knowledge_search ?? 0,
    attachmentBudgetTokens,
  }
}

/**
 * 第二阶段：附件截断后落地实际占用，得出历史预算
 *
 * @param attachmentTokens - 附件截断后的实际 token 数
 * @param summaryTokens - 已持久化摘要的实际 token 数（无摘要传 0）
 */
export function finalizeContextBudget(
  plan: ContextBudgetPlan,
  attachmentTokens: number,
  summaryTokens: number
): ContextBudget {
  const consumed =
    plan.systemTokens +
    plan.currentUserTokens +
    plan.toolReserveTokens +
    attachmentTokens
  const afterContent = plan.availableContextTokens - consumed

  // historyBudget 允许为 0（历史被上下文之外的内容挤没），但不允许为负：
  // 负值会让下游的窗口选择拿到一个无意义的预算。
  const historyBudgetTokens = Math.max(0, afterContent)
  const overflowTokens = Math.max(0, -afterContent)
  const effectiveSummaryTokens = Math.min(summaryTokens, historyBudgetTokens)
  const recentBudgetTokens = Math.max(
    0,
    historyBudgetTokens - effectiveSummaryTokens
  )

  return {
    ...plan,
    attachmentTokens,
    summaryTokens: effectiveSummaryTokens,
    historyBudgetTokens,
    recentBudgetTokens,
    unallocatedTokens: recentBudgetTokens,
    overflowTokens,
  }
}

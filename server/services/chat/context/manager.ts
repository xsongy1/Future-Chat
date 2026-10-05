/**
 * 上下文管理器（对外唯一入口）
 *
 * ## 完整链路
 *
 * ```
 * system prompt｜历史消息｜当前消息｜附件｜启用的工具｜已有摘要
 *         │
 *         ├─ 1. planContextBudget        算各层上限（附件截断前）
 *         ├─ 2. applyAttachmentBudget    附件：够则全量，不够则头+尾截断/丢弃
 *         ├─ 3. finalizeContextBudget     得到 history 预算
 *         ├─ 4. selectRecentMessages      按 token 预算选最近窗口（保证整轮、不孤立 tool）
 *         ├─ 5. shouldCompactHistory?     缺口攒够了才压缩（低频事件）
 *         │      └─ summarizeHistory       增量摘要：旧摘要 + 新缺口 → 新摘要（持久化，CAS 写入）
 *         ├─ 6. 用新摘要重算一次窗口（摘要变小/变大都会影响窗口大小）
 *         ├─ 7. assembleMessages          system → 摘要 → 最近消息 → 当前消息
 *         └─ 8. 发送前最终校验            超预算则确定性降级（丢历史 → 截断用户消息）
 * ```
 *
 * ## 两条设计红线
 *
 * 1. **不重算**：预算、token、窗口一律用上游算好的结果，本文件不重新实现任何一条规则。
 *    任何"顺手再算一遍"的写法都会在两次改动之后与源头漂移。
 * 2. **不改变语义**：只回放 role + content（与改造前一致），不把 tool_calls 从历史里翻出来；
 *    summary 用 system 角色承载，不伪装成 user 发言（伪装会让模型把摘要当成用户的原话）。
 */

import type { Model } from '@/shared/constants/models'
import { appendAttachments, assembleMessages } from '../prompt.builder'
import { applyAttachmentBudget } from './attachments'
import { finalizeContextBudget, planContextBudget } from './budget'
import {
  capSummaryToTokens,
  findUncoveredRange,
  shouldCompactHistory,
  summarizeHistory,
  type SummarizerComplete,
} from './compactor'
import { getContextConfig, type ContextConfig } from './config'
import {
  finalizeMetrics,
  logContextMetrics,
  estimateCost,
  type ContextFallbackReason,
  type ContextMetrics,
} from './metrics'
import {
  REQUEST_OVERHEAD_TOKENS,
  estimateHistoryTokens,
  estimateMessageTokens,
} from './tokens'
import { truncateTextToTokenBudget } from './truncate'
import type { ContextAttachment, ContextHistoryMessage } from './types'
import { selectRecentMessages } from './window'

/** 摘要注入时的说明文字 */
const SUMMARY_HEADER =
  '【历史对话摘要】更早的对话已压缩为下面这份摘要，它不是逐字原文。' +
  '摘要中没有的细节请如实说明"该细节未保留"，不要编造。'

/**
 * 摘要预算占可用上下文的比例
 *
 * 摘要是一次**独立的模型调用**，它的输入只有缺口消息与旧摘要，
 * 不占用本次聊天的上下文，所以可以放得比较宽（缺口很大时不切开就会丢信息）。
 * 留 30% 给摘要提示词本身与输出。
 */
const SUMMARY_INPUT_SHARE = 0.7

/** 已有摘要状态（来自 Conversation 行） */
export interface ConversationSummaryState {
  summary: string | null
  /** 兼任并发写入的版本号 */
  summaryUpdatedAt: Date | null
  /** 摘要覆盖到的最后一条消息 */
  summaryUpToMessageId: string | null
}

/** 压缩所需的外部能力（缺省则不压缩，只做窗口截断） */
export interface CompactionContext {
  apiKey: string
  /** 调用摘要模型用的模型 ID（沿用本轮模型，不引入"多模型摘要路由"） */
  model: string
  /**
   * 持久化摘要
   *
   * 返回 false 表示 CAS 失败（另一个并发请求写了更新的摘要）——
   * 此时本次结果只用于当前请求，不覆盖对方。
   */
  save: (summary: string, watermarkMessageId: string | null) => Promise<boolean>
}

export interface BuildManagedContextInput {
  systemPrompt: string
  /** 全部历史消息（时间正序） */
  historyMessages: readonly ContextHistoryMessage[]
  /** 当前用户消息正文（不含附件） */
  currentUserMessage: string
  attachments?: readonly ContextAttachment[]
  /** 模型配置；未命中白名单时为 undefined（此时只能用 CONTEXT_WINDOW_OVERRIDE） */
  model: Model | undefined
  /** 是否开启思考模式（影响输出预留大小） */
  enableThinking: boolean
  /** 本轮实际启用的工具名 */
  enabledToolNames: readonly string[]
  summaryState?: ConversationSummaryState
  compaction?: CompactionContext
  cancelSignal?: AbortSignal
  /** 测试注入：默认读环境变量 */
  config?: ContextConfig
  /** 测试注入：摘要模型调用实现 */
  complete?: SummarizerComplete
}

export interface ContextBuildResult {
  /** 最终下发的消息数组 */
  messages: Array<{ role: string; content: string | null }>
  /**
   * 一次性降级上下文：只保留 system +（摘要）+ 当前用户消息
   *
   * 给"预算是合法的，但 provider 仍然报超窗"这种情况兜底
   * （上游窗口比我们声明的保守值更小，或估算与实际偏差过大）。
   * 调用方**最多**用它重试一次，不允许无限重试：那会让一次失败变成一串计费请求。
   */
  degradedMessages: Array<{ role: string; content: string | null }>
  metrics: ContextMetrics
  /** 本次是否把新摘要写进了数据库 */
  summaryPersisted: boolean
}

/** 可用上下文连 system + 当前消息都放不下：属于无法通过降级挽救的配置/输入问题 */
export class ContextBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextBudgetExceededError'
  }
}

/** 摘要以 system 角色承载（不放 user：伪装成用户发言会让模型当成用户的原话） */
function buildSummaryMessage(summary: string): ContextHistoryMessage {
  return { role: 'system', content: `${SUMMARY_HEADER}\n${summary}` }
}

/** 摘要（含说明文字）的 token 占用 */
function measureSummaryTokens(summary: string | null): number {
  if (!summary) return 0
  return estimateMessageTokens(buildSummaryMessage(summary))
}

/**
 * 构建受管的上下文
 *
 * 这是本模块唯一对外的构建入口。纯函数式的预算/窗口计算与一次有副作用的摘要调用
 * 都在这里编排，调用方（chat.service）只需要提供材料与持久化回调。
 */
export async function buildManagedContext(
  input: BuildManagedContextInput
): Promise<ContextBuildResult> {
  const startedAt = Date.now()
  const config = input.config ?? getContextConfig()
  const history = input.historyMessages
  const attachments = input.attachments ?? []

  const systemTokens = estimateMessageTokens({
    role: 'system',
    content: input.systemPrompt,
  })
  const rawUserTokens = estimateMessageTokens({
    role: 'user',
    content: input.currentUserMessage,
  })

  // ---- 1. 预算第一阶段：先算附件能拿多少 ----
  const plan = planContextBudget({
    model: input.model,
    enableThinking: input.enableThinking,
    config,
    systemTokens,
    currentUserTokens: rawUserTokens,
    enabledToolNames: input.enabledToolNames,
  })

  // ---- 2. 附件 ----
  const attachmentResult = applyAttachmentBudget(
    attachments,
    plan.attachmentBudgetTokens,
    config
  )

  // 附件说明会写进当前消息，所以当前消息的 token 要在拼装后再算一次
  const userText = attachmentResult.notice
    ? `${input.currentUserMessage}\n\n${attachmentResult.notice}`
    : input.currentUserMessage
  const currentUserContent = appendAttachments(
    userText,
    attachmentResult.attachments
  )
  const currentUserTokens = estimateMessageTokens({
    role: 'user',
    content: currentUserContent,
  })

  // ---- 3. 已有摘要（读取时再压一次：summaryMaxTokens 可能被调小过） ----
  const persistedSummary = input.summaryState?.summary
    ? capSummaryToTokens(input.summaryState.summary, config.summaryMaxTokens) ||
      null
    : null

  const historyBreakdown = estimateHistoryTokens(history)
  const withCurrentUser = { ...plan, currentUserTokens }

  // ---- 4. 第一轮：按"摘要不变"选窗口，得到缺口 ----
  let summary = persistedSummary
  let budget = finalizeContextBudget(
    withCurrentUser,
    attachmentResult.tokens,
    measureSummaryTokens(summary)
  )
  let windowResult = selectRecentMessages(
    history,
    historyBreakdown,
    budget.recentBudgetTokens,
    {
      minUserTurns: config.minRecentUserTurns,
    }
  )

  let wasCompacted = false
  let compactionFailed = false
  let summaryPersisted = false

  // 当前生效的水位线。压缩成功后会被推进到本次真正并入摘要的最后一条，
  // 因此它同时服务于"下一次压缩只需摘哪一段"和"本次残留缺口有多大"。
  let watermarkMessageId = input.summaryState?.summaryUpToMessageId ?? null

  const compaction = input.compaction
  if (compaction && !input.cancelSignal?.aborted) {
    const gapBefore = findUncoveredRange(
      history,
      historyBreakdown,
      watermarkMessageId,
      windowResult.startIndex
    )

    const needed = shouldCompactHistory({
      uncoveredTokens: gapBefore.tokens,
      historyBudgetTokens: budget.historyBudgetTokens,
      thresholdRatio: config.compactThresholdRatio,
    })

    if (needed) {
      const outcome = await summarizeHistory({
        apiKey: compaction.apiKey,
        model: compaction.model,
        previousSummary: summary,
        gapMessages: gapBefore.messages,
        // 单块输入 = min(可用上下文的一个比例, 绝对上限)。
        // 绝对上限是**限制首字延迟**的关键：摘要同步发生在首 token 之前，
        // 块越大单次调用越慢（实测 20K token 的块在 8 秒内跑不完）。
        chunkBudgetTokens: Math.min(
          Math.max(
            1024,
            Math.floor(budget.availableContextTokens * SUMMARY_INPUT_SHARE)
          ),
          config.summaryChunkMaxTokens
        ),
        summaryMaxTokens: config.summaryMaxTokens,
        totalTimeoutMs: config.summaryTimeoutMs,
        cancelSignal: input.cancelSignal,
        complete: input.complete,
      })

      if (outcome.summary && outcome.consumedCount > 0) {
        summary = outcome.summary
        wasCompacted = true

        // 水位线推进到"本次真正并入摘要的最后一条"。
        // 注意用 consumedCount 而不是 gapBefore.messages.length：
        // 分块上限/超时都可能让本次只处理了一部分，水位线必须跟着实际处理量走，
        // 否则没被摘要的那一段会被当成"已覆盖"而永久丢失。
        const watermarkIndex = gapBefore.start + outcome.consumedCount - 1
        watermarkMessageId = history[watermarkIndex]?.id ?? null
        summaryPersisted = await compaction.save(summary, watermarkMessageId)
      } else if (!outcome.ok && !outcome.cancelled) {
        // 摘要失败/取消：退回纯窗口截断，聊天继续
        compactionFailed = true
        console.warn(
          `[Context] 摘要未生效，退回窗口截断：${outcome.error ?? 'cancelled'}`
        )
      }
    }
  }

  // ---- 5. 第二轮：用新摘要重算预算与窗口 ----
  budget = finalizeContextBudget(
    withCurrentUser,
    attachmentResult.tokens,
    measureSummaryTokens(summary)
  )
  windowResult = selectRecentMessages(
    history,
    historyBreakdown,
    budget.recentBudgetTokens,
    {
      minUserTurns: config.minRecentUserTurns,
    }
  )

  // 残留缺口（本次没摘完、且已滑出窗口的部分）：压缩会在后续轮次继续追赶它
  const uncoveredTokens = findUncoveredRange(
    history,
    historyBreakdown,
    watermarkMessageId,
    windowResult.startIndex
  ).tokens

  // ---- 6. 发送前最终校验与降级 ----
  //
  // 校验按**硬上限**（窗口 - 输出预留）判，而不是软预算：窗口选择为了保住"整轮对话"
  // 允许小幅超出软预算（见 window.ts 的容差），这点超出应当由安全边际吸收，
  // 而不该被判成超窗、进而把所有历史丢光。
  let retainedMessages = windowResult.messages
  let finalUserContent = currentUserContent
  let fallback: ContextFallbackReason = 'none'

  const summaryInPromptTokens = summary ? measureSummaryTokens(summary) : 0
  let retainedTokens = windowResult.tokens
  const limit = budget.hardInputLimitTokens

  const estimateFromParts = () =>
    REQUEST_OVERHEAD_TOKENS +
    systemTokens +
    summaryInPromptTokens +
    retainedTokens +
    estimateMessageTokens({ role: 'user', content: finalUserContent })

  let estimatedInputTokens = estimateFromParts()

  // 降级 1：从**最旧**的一端逐条丢弃历史，直到装得下。
  // 逐条丢而不是"一超就全丢"：后者会让一次轻微超预算直接把模型打回失忆状态。
  if (estimatedInputTokens > limit && retainedMessages.length > 0) {
    const baseIndex = windowResult.startIndex
    let dropped = 0
    while (estimatedInputTokens > limit && dropped < retainedMessages.length) {
      retainedTokens -= historyBreakdown.perMessage[baseIndex + dropped]
      dropped++
      estimatedInputTokens = estimateFromParts()
    }
    retainedMessages = retainedMessages.slice(dropped)
    fallback = 'dropped-history'
  }

  // 降级 2：确定性截断当前用户消息。
  // 走到这里说明**单条用户消息本身就超过了窗口**（例如直接粘贴一份超长文本），
  // 此时唯一能做的就是截断它，并显式留下省略标记。
  if (estimatedInputTokens > limit) {
    // 目标里必须扣掉整请求固定开销，否则截断后的总量仍会差那么几个 token
    const target =
      limit -
      REQUEST_OVERHEAD_TOKENS -
      systemTokens -
      summaryInPromptTokens -
      retainedTokens
    const truncated = truncateTextToTokenBudget(finalUserContent, target, {
      measure: (text) => estimateMessageTokens({ role: 'user', content: text }),
    })

    if (truncated === null) {
      throw new ContextBudgetExceededError(
        `[Context] 上下文预算不足：输入硬上限 ${limit} token，` +
          `system prompt 已占 ${systemTokens}。请调大 CONTEXT_WINDOW_OVERRIDE 或精简 system prompt。`
      )
    }

    finalUserContent = truncated
    fallback = 'truncated-user-message'
    estimatedInputTokens = estimateFromParts()
  }

  if (estimatedInputTokens > limit) {
    // 走到这里说明上面的降级都没收敛，属于不该出现的状态：宁可明确失败，
    // 也不要把一个必然被 provider 拒绝的请求发出去（那只会让用户看到一个 400）。
    throw new ContextBudgetExceededError(
      `[Context] 降级后仍超出硬上限：估算输入 ${estimatedInputTokens} > ${limit}`
    )
  }

  // ---- 7. 组装 ----
  const promptHistory: ContextHistoryMessage[] = summary
    ? [buildSummaryMessage(summary), ...retainedMessages]
    : [...retainedMessages]
  const messages = assembleMessages(
    input.systemPrompt,
    promptHistory,
    finalUserContent
  )

  // 降级重试用的最小上下文：摘要是可复用的长期记忆（体积受控），值得保留；
  // 最近窗口是"可以再读一次原文"的部分，所以优先丢它。
  const degradedMessages = assembleMessages(
    input.systemPrompt,
    summary ? [buildSummaryMessage(summary)] : [],
    finalUserContent
  )

  const metrics = finalizeMetrics({
    modelId: budget.modelId,
    contextWindow: budget.contextWindow,
    contextWindowOverridden: budget.contextWindowOverridden,
    outputReserveTokens: budget.outputReserveTokens,
    safetyMarginTokens: budget.safetyMarginTokens,
    availableContextTokens: budget.availableContextTokens,
    hardInputLimitTokens: budget.hardInputLimitTokens,
    estimatedInputTokens,
    systemTokens,
    currentUserTokens,
    // 报告**实际下发**的量（降级可能已经砍掉了部分历史），而不是规划期的上限
    historyTokens: summaryInPromptTokens + retainedTokens,
    summaryTokens: summaryInPromptTokens,
    recentMessageTokens: retainedTokens,
    attachmentTokens: attachmentResult.tokens,
    ragReserveTokens: budget.ragReserveTokens,
    toolReserveTokens: budget.toolReserveTokens,
    historyBudgetTokens: budget.historyBudgetTokens,
    recentBudgetTokens: budget.recentBudgetTokens,
    historyMessageCount: history.length,
    retainedMessageCount: retainedMessages.length,
    uncoveredTokens,
    wasCompacted,
    compactionFailed,
    summaryReused: summary !== null && !wasCompacted,
    wasTruncated: attachmentResult.truncated || fallback !== 'none',
    attachmentCount: attachments.length,
    droppedAttachmentCount: attachmentResult.droppedNames.length,
    fallback,
    buildDurationMs: Date.now() - startedAt,
    // 只算输入侧：输出 token 要等模型答完才知道（见 metrics.estimatedInputCost 的说明）
    estimatedInputCost: estimateCost(
      {
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        totalTokens: estimatedInputTokens,
      },
      config
    ).inputCost,
  })

  logContextMetrics(metrics)

  return { messages, degradedMessages, metrics, summaryPersisted }
}

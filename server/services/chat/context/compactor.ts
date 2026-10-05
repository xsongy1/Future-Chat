/**
 * 历史压缩（Recent Window + Summary 策略里的 Summary 一侧）
 *
 * ## 触发时机：低频事件，不是每轮事件
 *
 * 判据是**未被摘要覆盖的"缺口"有多大**，而不是"历史有多长"。
 * 窗口负责装最近的消息，缺口就是"既不在摘要里、也不在窗口里"的那一段——
 * 它才是真正会丢信息的部分。
 *
 * 为什么必须有阈值：如果不设阈值，只要窗口一开始滑动，每轮都会产生一点新缺口，
 * 于是每轮都要调一次摘要模型（既慢又贵，而且摘要会反复重写已有的内容）。
 * 阈值让它变成"缺口攒够了才压缩一次"。
 * 阈值取值由 benchmark 的扫描结果决定（见 docs/context-management.md）。
 *
 * ## 为什么是增量摘要
 *
 * 每次压缩的输入是「已有摘要 + 新增缺口」，输出是**一份新的完整摘要**。
 * 绝不能写成一"旧摘要 + 旧摘要 + 新摘要"的拼接：那样摘要会线性膨胀，
 * 最终比它替代掉的历史还占地方，压缩就白做了。
 * 输出侧还有 `capSummaryToTokens` 兜底硬上限。
 *
 * ## 为什么分块
 *
 * 第一次压缩时缺口可能非常大（整个会话减去一个窗口，几十万 token 都可能），
 * 一次请求根本放不下。所以按 `chunkBudgetTokens` 切块、从旧到新**顺序**滚动摘要，
 * 每块都以上一块的结果作为 previousSummary。
 * 整步有总超时兜底，触顶就停在当前水位线，剩下的留到下一轮继续（追赶式压缩）。
 *
 * ## 失败必须无害
 *
 * 摘要超时 / 5xx / 返回空 → 返回 ok:false，调用方退回"纯最近窗口截断"，
 * 聊天照常进行。长期记忆系统挂掉不能把聊天一起带下去。
 */

import { createChatCompletion } from '@/server/services/ai/siliconflow'
import { parseSSELine, splitSSEBuffer } from '@/shared/utils/sse'
import { estimateTokens } from './tokens'
import type { TokenUsage } from './metrics'
import type { ContextHistoryMessage } from './types'

/**
 * 单次压缩最多发起几次摘要调用
 *
 * 上限的目的是**限制尾延迟**：压缩是同步发生在首 token 之前的，
 * 3 次调用已经是用户能明显感知的量级。超出的部分留到下一轮继续压缩。
 */
export const MAX_SUMMARY_CHUNKS_PER_REQUEST = 3

/** 摘要输出被硬截断时插入的标记 */
const SUMMARY_TRUNCATION_MARKER = '\n\n[... 摘要过长，已截断 ...]'

/** 截断摘要时保留给头部的比例（结构化摘要的骨架在前面，头部多留一些） */
const SUMMARY_HEAD_SHARE = 0.75

/** 被截断摘要时允许的最小 token 数，低于它就直接丢掉摘要而不是给一段无意义的残句 */
const MIN_USABLE_SUMMARY_TOKENS = 16

/** 摘要请求的输出硬上限（字符）：防止上游异常时无限输出，也用于提前停止读取流 */
const MAX_SUMMARY_OUTPUT_CHARS = 8000

/**
 * 摘要的可注入实现
 *
 * 把"调用模型"这个唯一的副作用做成注入点：
 * 单测不需要 mock 整个 siliconflow 模块，也能精确控制超时/报错/空响应这些分支。
 */
export type SummarizerComplete = (input: {
  apiKey: string
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  signal: AbortSignal
}) => Promise<{ text: string; usage: TokenUsage | null }>

/**
 * 是否应该压缩历史
 *
 * @param uncoveredTokens - 既不在摘要里、也不在最近窗口里的消息的 token 数
 * @param historyBudgetTokens - 历史区总预算（摘要 + 最近窗口）
 * @param thresholdRatio - 阈值比例（缺口达到预算的这个比例才压缩）
 */
export function shouldCompactHistory(input: {
  uncoveredTokens: number
  historyBudgetTokens: number
  thresholdRatio: number
}): boolean {
  const { uncoveredTokens, historyBudgetTokens, thresholdRatio } = input
  if (uncoveredTokens <= 0) return false
  if (historyBudgetTokens <= 0) return false
  return uncoveredTokens >= Math.ceil(historyBudgetTokens * thresholdRatio)
}

/** 缺口区间（待并入摘要的消息） */
export interface UncoveredRange {
  /** 起始下标（含） */
  start: number
  /** 结束下标（不含） */
  end: number
  messages: ContextHistoryMessage[]
  tokens: number
  /** 水位线消息是否还能在历史里找到（删过消息就会找不到） */
  watermarkFound: boolean
}

/**
 * 找出"既不在摘要里、也不在最近窗口里"的缺口
 *
 * 水位线（summaryUpToMessageId）指向摘要已经覆盖到的最后一条消息。
 * 水位线消息被删掉时会找不到：此时把 start 退回 0，让整段旧历史重新并入摘要。
 * 这样做的代价是重复摘要一段已经摘过的内容（浪费一点 token），
 * 收益是**绝不会因为消息被删而永久丢掉中间那一段**——宁可重复，不可丢失。
 */
export function findUncoveredRange(
  messages: readonly ContextHistoryMessage[],
  breakdown: { perMessage: number[] },
  watermarkMessageId: string | null | undefined,
  recentStartIndex: number
): UncoveredRange {
  let start = 0
  let watermarkFound = false

  if (watermarkMessageId) {
    const index = messages.findIndex(
      (message) => message.id === watermarkMessageId
    )
    if (index >= 0) {
      start = index + 1
      watermarkFound = true
    }
  } else {
    // 从未压缩过：水位线等价于"紧邻 0 之前"，此处不必标记为丢失
    watermarkFound = true
  }

  const end = Math.max(start, Math.min(recentStartIndex, messages.length))

  let tokens = 0
  for (let i = start; i < end; i++) tokens += breakdown.perMessage[i]

  return {
    start,
    end,
    messages: messages.slice(start, end),
    tokens,
    watermarkFound,
  }
}

/**
 * 摘要提示词
 *
 * 结构化 + 反幻觉约束写死在提示里。两条最重要的规则：
 * - 不许编造，不许从对话里"推断"用户偏好（推断出来的偏好会被永久写进记忆，
 *   一次错误的推断会污染后续所有轮次）
 * - 姓名、数字、需求、决定必须原样保留（这些是最容易被摘要模型"润色"掉的信息）
 */
export function buildSummaryPrompt(input: {
  previousSummary: string | null
  messages: readonly ContextHistoryMessage[]
  maxChars: number
}): Array<{ role: 'system' | 'user'; content: string }> {
  const system = [
    '你是一个对话摘要器。你的任务是把多轮对话压缩成一份结构化摘要，供后续对话继续使用。',
    '',
    '严格遵守以下规则：',
    '1. 只依据给定内容总结。Never invent facts.（绝不编造事实）',
    '2. 不要推断用户偏好、意图或身份，除非用户明确说过。',
    '   Never infer user preferences unless explicitly stated.',
    '3. 原样保留姓名、数字、编号、文件名、额度、时限、需求与已经做出的决定，不要改写、不要四舍五入。',
    '   Preserve names, numbers, requirements and decisions.',
    '4. 工具调用得出的结论要写进来（例如检索到的规定原文、搜索到的关键数据），但不要写工具的原始 JSON。',
    '5. 与本次任务无关的寒暄、客套不要保留。',
    '6. 直接输出摘要正文，不要任何前言、后记或解释。',
    '',
    '摘要必须包含以下小节；某一节确实没有内容时写「无」：',
    '# 用户目标',
    '# 已确认的事实',
    '# 关键实体（人名 / 文件名 / 编号 / 参数）',
    '# 用户偏好与约束（仅限用户明确说过的）',
    '# 已做出的决定',
    '# 未解决的问题',
    '# 工具调用得出的重要结论',
    '',
    `总长度不超过 ${input.maxChars} 字。宁可精炼，也不要遗漏上面这些小节。`,
  ].join('\n')

  const parts: string[] = []
  if (input.previousSummary) {
    parts.push('【已有摘要（需要与新增对话合并，不要丢失其中的信息）】')
    parts.push(input.previousSummary)
    parts.push('')
  }
  parts.push('【新增对话】')
  parts.push(renderConversation(input.messages))

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ]
}

/** 把消息渲染成摘要模型的输入文本 */
function renderConversation(
  messages: readonly ContextHistoryMessage[]
): string {
  return messages
    .map((message) => `${roleLabel(message.role)}: ${message.content ?? ''}`)
    .join('\n')
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'tool') return '工具'
  return role
}

/**
 * 把摘要硬压到 token 上限内
 *
 * 提示词已经要求模型控制长度，但**不能依赖模型遵守提示**：
 * 摘要超限会直接吃掉最近窗口的预算，让"压缩"变成"换个方式撑爆上下文"。
 * 所以输出侧必须有一道确定性的闸门。
 */
export function capSummaryToTokens(text: string, maxTokens: number): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  if (maxTokens < MIN_USABLE_SUMMARY_TOKENS) return ''
  if (estimateTokens(trimmed) <= maxTokens) return trimmed

  let keepChars = trimmed.length
  for (let attempt = 0; attempt < 8; attempt++) {
    const headChars = Math.floor(keepChars * SUMMARY_HEAD_SHARE)
    const tailChars = Math.floor(keepChars * (1 - SUMMARY_HEAD_SHARE))
    const candidate =
      trimmed.slice(0, headChars) +
      SUMMARY_TRUNCATION_MARKER +
      (tailChars > 0 ? trimmed.slice(trimmed.length - tailChars) : '')

    if (estimateTokens(candidate) <= maxTokens) return candidate
    keepChars = Math.floor(
      (keepChars * maxTokens) / Math.max(1, estimateTokens(candidate))
    )
    if (keepChars <= 0) return ''
  }

  return ''
}

export interface SummarizeHistoryInput {
  apiKey: string
  model: string
  previousSummary: string | null
  /** 待并入摘要的消息（缺口），按时间正序 */
  gapMessages: readonly ContextHistoryMessage[]
  /** 单次摘要调用的输入 token 上限（超出则分块） */
  chunkBudgetTokens: number
  /** 摘要输出上限 */
  summaryMaxTokens: number
  /** 整个压缩步骤的总超时，覆盖所有分块调用 */
  totalTimeoutMs: number
  cancelSignal?: AbortSignal
  /** 注入点：默认走真实模型调用 */
  complete?: SummarizerComplete
}

export interface SummarizeHistoryResult {
  ok: boolean
  summary: string | null
  /** 本次已并入摘要的缺口消息条数（水位线推进量） */
  consumedCount: number
  /** 因分块上限/超时未处理、留给下一轮的缺口条数 */
  remainingCount: number
  usage: TokenUsage | null
  durationMs: number
  /** 失败原因（ok=false 时存在） */
  error?: string
  /** 是否因用户取消而跳过（不算失败，也不应持久化） */
  cancelled?: boolean
}

/**
 * 累加多次摘要调用的 token 用量
 *
 * 独立成函数（而不是在循环里内联相加）：参数有显式类型标注，
 * 不会被 TS 的控制流分析收窄成 `null`。
 */
function accumulateUsage(
  previous: TokenUsage | null,
  next: TokenUsage
): TokenUsage {
  return {
    inputTokens: (previous?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (previous?.totalTokens ?? 0) + next.totalTokens,
  }
}

/** 把缺口按 token 预算切块 */
function chunkByTokenBudget(
  messages: readonly ContextHistoryMessage[],
  budgetTokens: number
): ContextHistoryMessage[][] {
  if (messages.length === 0) return []

  const chunks: ContextHistoryMessage[][] = []
  let current: ContextHistoryMessage[] = []
  let currentTokens = 0

  for (const message of messages) {
    const tokens = estimateTokens(message.content ?? '') + 8
    // 单条就超预算：自成一块（交给模型处理，不在这里丢数据）
    if (current.length > 0 && currentTokens + tokens > budgetTokens) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(message)
    currentTokens += tokens
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 执行压缩：把缺口消息并入摘要
 *
 * @returns 失败时 ok=false（调用方退回截断），取消时 cancelled=true 且不持久化
 */
export async function summarizeHistory(
  input: SummarizeHistoryInput
): Promise<SummarizeHistoryResult> {
  const startedAt = Date.now()
  const { apiKey, model, gapMessages, summaryMaxTokens, totalTimeoutMs } = input

  if (gapMessages.length === 0) {
    return {
      ok: true,
      summary: input.previousSummary,
      consumedCount: 0,
      remainingCount: 0,
      usage: null,
      durationMs: 0,
    }
  }

  // 用户已取消：直接跳过，不做任何摘要、不落库
  if (input.cancelSignal?.aborted) {
    return {
      ok: false,
      summary: input.previousSummary,
      consumedCount: 0,
      remainingCount: gapMessages.length,
      usage: null,
      durationMs: 0,
      cancelled: true,
    }
  }

  const complete = input.complete ?? defaultSummarizerComplete
  const chunks = chunkByTokenBudget(gapMessages, input.chunkBudgetTokens)

  let summary = input.previousSummary
  let consumedCount = 0
  let usage: TokenUsage | null = null
  const deadline = startedAt + totalTimeoutMs

  for (let i = 0; i < chunks.length; i++) {
    if (i >= MAX_SUMMARY_CHUNKS_PER_REQUEST) break
    if (input.cancelSignal?.aborted) {
      return {
        ok: consumedCount > 0,
        summary,
        consumedCount,
        remainingCount: gapMessages.length - consumedCount,
        usage,
        durationMs: Date.now() - startedAt,
        cancelled: true,
      }
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return {
        ok: consumedCount > 0,
        summary,
        consumedCount,
        remainingCount: gapMessages.length - consumedCount,
        usage,
        durationMs: Date.now() - startedAt,
        error: '摘要总超时，剩余缺口留到下一轮',
      }
    }

    const chunk = chunks[i]
    try {
      const outcome = await callSummarizer({
        complete,
        apiKey,
        model,
        previousSummary: summary,
        messages: chunk,
        summaryMaxTokens,
        timeoutMs: remainingMs,
        cancelSignal: input.cancelSignal,
      })

      // 累加摘要自身的 token 用量：这是"压缩的额外成本"的唯一真实来源，
      // benchmark 的冷压缩成本就是靠它算的。
      if (outcome.usage) {
        usage = accumulateUsage(usage, outcome.usage)
      }

      const capped = capSummaryToTokens(outcome.text, summaryMaxTokens)
      if (!capped) {
        // 空摘要/无法压缩：**不推进水位线**，否则这段历史就永远消失了
        return {
          ok: consumedCount > 0,
          summary,
          consumedCount,
          remainingCount: gapMessages.length - consumedCount,
          usage,
          durationMs: Date.now() - startedAt,
          error: '摘要模型返回空内容，已放弃本轮压缩',
        }
      }

      summary = capped
      consumedCount += chunk.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (input.cancelSignal?.aborted) {
        return {
          ok: consumedCount > 0,
          summary,
          consumedCount,
          remainingCount: gapMessages.length - consumedCount,
          usage,
          durationMs: Date.now() - startedAt,
          cancelled: true,
        }
      }
      return {
        ok: consumedCount > 0,
        summary,
        consumedCount,
        remainingCount: gapMessages.length - consumedCount,
        usage,
        durationMs: Date.now() - startedAt,
        error: message,
      }
    }
  }

  return {
    ok: true,
    summary,
    consumedCount,
    remainingCount: gapMessages.length - consumedCount,
    usage,
    durationMs: Date.now() - startedAt,
  }
}

/** 单块摘要调用（含超时与取消合并） */
async function callSummarizer(input: {
  complete: SummarizerComplete
  apiKey: string
  model: string
  previousSummary: string | null
  messages: readonly ContextHistoryMessage[]
  summaryMaxTokens: number
  timeoutMs: number
  cancelSignal?: AbortSignal
}): Promise<{ text: string; usage: TokenUsage | null }> {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), input.timeoutMs)

  const signal = input.cancelSignal
    ? AbortSignal.any([timeoutController.signal, input.cancelSignal])
    : timeoutController.signal

  try {
    // 摘要的输出预算按"1 token ≈ 1 字"的保守口径换算成字符上限，
    // 提示词里的字数要求与这里的硬上限用同一个数，不会互相矛盾。
    const messages = buildSummaryPrompt({
      previousSummary: input.previousSummary,
      messages: input.messages,
      maxChars: input.summaryMaxTokens,
    })

    return await input.complete({
      apiKey: input.apiKey,
      model: input.model,
      messages,
      signal,
    })
  } catch (error) {
    // 区分"我们自己设的超时"与"上游报错"：前者是可预期的降级原因，
    // 后者需要看原始错误文本。用户主动取消不算超时。
    if (timeoutController.signal.aborted && !input.cancelSignal?.aborted) {
      throw new Error(`摘要调用超时（${input.timeoutMs}ms）`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * 默认摘要实现：复用现有的流式对话接口，读完整流后拼出正文
 *
 * 刻意不新增一个"非流式补全"的 API 封装：多一套请求构造就多一处需要与
 * 模型白名单/鉴权/参数保持同步的地方，复用流式接口则这些约束全是现成的。
 */
const defaultSummarizerComplete: SummarizerComplete = async ({
  apiKey,
  model,
  messages,
  signal,
}) => {
  const { reader } = await createChatCompletion(apiKey, {
    model,
    messages,
    // 摘要不需要思考：思考只会增加延迟与输出 token，不提升摘要质量
    enableThinking: false,
    signal,
  })

  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let usage: TokenUsage | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const { lines, remaining } = splitSSEBuffer(buffer)
    buffer = remaining

    for (const line of lines) {
      const data = parseSSELine(line)
      if (!data) continue
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_tokens?: number
          }
        }
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) text += delta
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          }
        }
      } catch {
        // 非 JSON 行（心跳等）忽略
      }
    }

    // 上游异常输出时提前停止读取，避免把整段无意义内容读进内存
    if (text.length >= MAX_SUMMARY_OUTPUT_CHARS) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }

  return { text, usage }
}

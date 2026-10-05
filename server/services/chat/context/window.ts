/**
 * 最近消息窗口选择
 *
 * ## 为什么不是 `history.slice(-20)`
 *
 * 按**条数**截断有两个问题：
 * 1. 条数不等于 token：20 条短消息可能只有 200 token（浪费了 90% 预算），
 *    20 条长消息可能是 20000 token（直接超窗）。预算必须按 token 花。
 * 2. 会切出"半轮对话"：窗口第一句是 assistant 的回答，用户问了什么却不在上下文里，
 *    模型看到的就是一段没有问题的答案。
 *
 * ## 本文件的规则
 *
 * - 从**最新**往前累加，直到用满预算（保留的是连续后缀，不是抽样）
 * - 窗口必须以 `user` 消息开头（必要时向前扩一轮，或向前丢掉半轮）
 * - 永远不以 `tool` / `assistant` 开头：孤立 tool 结果在 OpenAI 兼容协议里是非法序列
 * - 至少保留一个用户轮次，避免"预算刚好卡死"时窗口退化成空
 */

import type { HistoryTokenBreakdown } from './tokens'
import type { ContextHistoryMessage } from './types'

/**
 * 为了补全"半轮对话"允许的预算超支比例
 *
 * 往前多扩一条 user 消息通常会超一点预算。允许 15% 的溢出：
 * 超一点换来的是"模型知道用户在问什么"，比严格守住预算更值。
 * 超过这个比例就不再扩，改为向前丢掉那半轮。
 */
const PAIR_OVERSHOOT_TOLERANCE = 0.15

export interface SelectRecentWindowOptions {
  /** 为补全半轮允许的预算溢出比例 */
  overshootTolerance?: number
  /**
   * 至少保留的用户轮次
   *
   * 来自 `CONTEXT_MIN_RECENT_USER_TURNS`。把"至少一个用户轮次"做成参数而不是写死，
   * 是因为这个下限直接决定"预算刚好卡死时窗口还剩多少可用信息"：
   * 留 1 轮只能保证模型知道"最后一问是什么"，留 2~3 轮才能在追问场景里保住上下文。
   */
  minUserTurns?: number
}

export interface RecentWindowResult {
  /** 保留的连续后缀 */
  messages: ContextHistoryMessage[]
  /** 窗口起点在输入数组中的下标（等于 messages.length 时表示窗口为空） */
  startIndex: number
  /** 窗口内消息的估算 token 合计 */
  tokens: number
  /** 因预算未纳入窗口的消息条数 */
  droppedCount: number
  /** 是否为了对齐 user 边界而调整过起点（用于测试与 metrics 判断） */
  adjustedForPair: boolean
}

/** 在 [0, start) 中找最靠后的 `user` 消息下标；找不到返回 -1 */
function findUserBoundaryBefore(
  messages: readonly ContextHistoryMessage[],
  start: number
): number {
  for (let i = start; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** 在 [start, len) 中找最靠前的 `user` 消息下标；找不到返回 -1 */
function findUserBoundaryAtOrAfter(
  messages: readonly ContextHistoryMessage[],
  start: number
): number {
  for (let i = start; i < messages.length; i++) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** 累加 [from, to) 的 token */
function sumRange(
  breakdown: HistoryTokenBreakdown,
  from: number,
  to: number
): number {
  let total = 0
  for (let i = from; i < to; i++) total += breakdown.perMessage[i]
  return total
}

function countUserTurns(
  messages: readonly ContextHistoryMessage[],
  from = 0
): number {
  let count = 0
  for (let i = from; i < messages.length; i++) {
    if (messages[i].role === 'user') count++
  }
  return count
}

/**
 * 选出符合预算的最近消息窗口
 *
 * @param messages - 全部历史消息（按时间正序）
 * @param breakdown - `estimateHistoryTokens(messages)` 的结果（复用，不在这里重估）
 * @param budgetTokens - 历史区可用预算（已扣除摘要占用）
 */
export function selectRecentMessages(
  messages: readonly ContextHistoryMessage[],
  breakdown: HistoryTokenBreakdown,
  budgetTokens: number,
  options: SelectRecentWindowOptions = {}
): RecentWindowResult {
  const tolerance = options.overshootTolerance ?? PAIR_OVERSHOOT_TOLERANCE

  if (messages.length === 0) {
    return {
      messages: [],
      startIndex: 0,
      tokens: 0,
      droppedCount: 0,
      adjustedForPair: false,
    }
  }

  // 预算为 0（或负）：一条都不留。调用方随后会走降级逻辑。
  if (budgetTokens <= 0) {
    return {
      messages: [],
      startIndex: messages.length,
      tokens: 0,
      droppedCount: messages.length,
      adjustedForPair: false,
    }
  }

  // 1) 从最新往前累加，得到"预算装得下的连续后缀"
  let startIndex = messages.length
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = breakdown.perMessage[i]
    if (used + cost > budgetTokens) break
    used += cost
    startIndex = i
  }

  let adjustedForPair = false

  // 2) 对齐到 user 边界：窗口不该从半轮中间开始
  //
  // ⚠️ 前提是"历史里确实存在 user 消息"。整段历史**没有一条 user 消息**时（真实发生过：
  // 重试/只落 assistant 占位符的调用路径下，历史可能全是 assistant），
  // 对齐逻辑找不到任何边界，会一路走到"清空窗口"——那等于把仅有的历史全丢掉。
  // 没有边界可对齐时应当原样保留后缀：模型看到"只有回答、没有问题"虽然不完美，
  // 但比完全失忆好得多。
  const hasUserBoundary = findUserBoundaryAtOrAfter(messages, 0) !== -1

  if (
    hasUserBoundary &&
    startIndex < messages.length &&
    messages[startIndex].role !== 'user'
  ) {
    const extendTo = findUserBoundaryBefore(messages, startIndex - 1)
    const overshoot =
      extendTo >= 0 ? sumRange(breakdown, extendTo, startIndex) : 0
    const fitsWithTolerance =
      extendTo >= 0 && used + overshoot <= budgetTokens * (1 + tolerance)

    if (fitsWithTolerance) {
      // 向前扩一轮，保住"用户问了什么"
      used += overshoot
      startIndex = extendTo
      adjustedForPair = true
    } else {
      // 扩不动：优先向前丢掉这半轮，从下一个 user 消息重新开始
      const nextUser = findUserBoundaryAtOrAfter(messages, startIndex)
      if (nextUser === -1) {
        // 后面已经没有 user 边界了（历史尾部全是 assistant/tool）。
        // 这里退化为"无条件向前扩到最近的 user"而不是把窗口清空：
        // 空窗口意味着模型完全失忆，比略微超预算更糟——真正的超预算由
        // manager 的发送前校验兜底，不会真的发出去。
        used += overshoot
        startIndex = extendTo
        adjustedForPair = true
      } else {
        used -= sumRange(breakdown, startIndex, nextUser)
        startIndex = nextUser
        adjustedForPair = true
      }
    }
  }

  // 3) 至少保留 N 个用户轮次：宁可略微超预算，也不要给模型一个"没有问题的答案"
  const minUserTurns = Math.max(1, options.minUserTurns ?? 1)
  if (startIndex < messages.length) {
    let turns = countUserTurns(messages, startIndex)
    while (turns < minUserTurns) {
      const extendTo = findUserBoundaryBefore(messages, startIndex - 1)
      if (extendTo < 0) break
      used += sumRange(breakdown, extendTo, startIndex)
      startIndex = extendTo
      adjustedForPair = true
      turns = countUserTurns(messages, startIndex)
    }
  }

  return {
    messages: messages.slice(startIndex),
    startIndex,
    tokens: used,
    droppedCount: startIndex,
    adjustedForPair,
  }
}

/**
 * 上下文管理测试的确定性数据工厂
 *
 * 为什么不用随机数据：benchmark 与回归测试都需要**可复现**的数字。
 * 固定长度的构造文本能让"估算 token 数"完全可预测（1 个汉字 = 1 token），
 * 于是断言可以写精确值而不是范围，失败时也能立刻定位到是哪一层的算法变了。
 */

import type { ContextConfig } from '../config'
import type { ContextHistoryMessage } from '../types'

/** 构造恰好 `tokens` 个 token 的文本（汉字按 1 token/字，与估算器口径一致） */
export function filler(tokens: number, prefix = ''): string {
  return prefix + '测'.repeat(Math.max(0, tokens))
}

/**
 * 测试用配置：所有默认值显式写死，不受环境变量影响
 *
 * 环境变量会让"本机跑通、CI 失败"，所以测试一律显式注入配置，
 * 只有专门测环境变量解析的用例才去动 process.env。
 *
 * 这里的数字是**测试夹具自己的取值**，不要求与生产默认值一致
 * （生产默认值由 budget.test.ts 单独守住）。压缩阈值取 0.75 是为了让
 * "不压缩"的分支在中等规模的历史下也能稳定复现。
 */
export function makeContextConfig(
  overrides: Partial<ContextConfig> = {}
): ContextConfig {
  return {
    contextWindowOverride: null,
    safetyMarginRatio: 0.1,
    compactThresholdRatio: 0.75,
    summaryMaxTokens: 800,
    summaryChunkMaxTokens: 4000,
    attachmentShareRatio: 0.5,
    attachmentMaxTokens: 12000,
    attachmentMinTokens: 120,
    summaryTimeoutMs: 15000,
    minRecentUserTurns: 1,
    inputPricePer1MTokens: null,
    outputPricePer1MTokens: null,
    ...overrides,
  }
}

/**
 * 构造一段对话历史
 *
 * 每条消息的 content 长度固定为 `tokensPerMessage`，所以整段历史的估算 token 数
 * 完全可计算：`turns * 2 * (tokensPerMessage + MESSAGE_OVERHEAD_TOKENS)`。
 */
export function makeHistory(options: {
  /** 完整轮数（每轮 = 1 条 user + 1 条 assistant） */
  turns: number
  /** 每条消息正文的估算 token 数 */
  tokensPerMessage: number
  /** 消息 id 前缀（水位线测试需要可预测的 id） */
  idPrefix?: string
}): ContextHistoryMessage[] {
  const { turns, tokensPerMessage, idPrefix = 'm' } = options
  const messages: ContextHistoryMessage[] = []

  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      id: `${idPrefix}-${turn * 2}`,
      role: 'user',
      content: filler(tokensPerMessage, `第${turn + 1}问：`),
    })
    messages.push({
      id: `${idPrefix}-${turn * 2 + 1}`,
      role: 'assistant',
      content: filler(tokensPerMessage, `第${turn + 1}答：`),
    })
  }

  return messages
}

/** 构造一个 always-succeed 的假摘要实现，按调用顺序返回预置文本 */
export function makeFakeSummarizer(outputs: string[]): {
  calls: Array<{ messages: Array<{ role: string; content: string }> }>
  complete: (input: {
    apiKey: string
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    signal: AbortSignal
  }) => Promise<{
    text: string
    usage: {
      inputTokens: number
      outputTokens: number
      totalTokens: number
    } | null
  }>
} {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> =
    []
  let index = 0

  return {
    calls,
    complete: async (input) => {
      calls.push({ messages: input.messages })
      const text = outputs[Math.min(index, outputs.length - 1)] ?? ''
      index++
      return {
        text,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      }
    },
  }
}

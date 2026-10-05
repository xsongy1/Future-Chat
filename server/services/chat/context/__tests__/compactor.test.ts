/**
 * 压缩器测试
 *
 * 重点覆盖四件事：
 * 1. **触发时机**：缺口攒够阈值才压缩（这是"摘要不是每轮事件"的唯一保证）
 * 2. **水位线语义**：只有真正并入摘要的消息才能推进水位线（推早了会永久丢历史）
 * 3. **失败无害**：超时 / 5xx / 空响应都必须退化为截断，而不是让聊天失败
 * 4. **摘要不膨胀**：输出侧有确定性硬上限，不能依赖模型守规矩
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_SUMMARY_CHUNKS_PER_REQUEST,
  capSummaryToTokens,
  buildSummaryPrompt,
  findUncoveredRange,
  shouldCompactHistory,
  summarizeHistory,
} from '../compactor'
import { estimateHistoryTokens, estimateTokens } from '../tokens'
import { filler, makeHistory } from './fixtures'
import type { ContextHistoryMessage } from '../types'

describe('shouldCompactHistory：缺口攒够阈值才压缩', () => {
  const base = { historyBudgetTokens: 10000, thresholdRatio: 0.75 }

  it('没有缺口时不压缩（历史还没滑出窗口）', () => {
    expect(shouldCompactHistory({ ...base, uncoveredTokens: 0 })).toBe(false)
  })

  it('缺口低于阈值时不压缩 —— 这是"摘要不是每轮事件"的关键', () => {
    expect(shouldCompactHistory({ ...base, uncoveredTokens: 7499 })).toBe(false)
  })

  it('缺口达到阈值时压缩', () => {
    expect(shouldCompactHistory({ ...base, uncoveredTokens: 7500 })).toBe(true)
    expect(shouldCompactHistory({ ...base, uncoveredTokens: 9000 })).toBe(true)
  })

  it('历史预算为 0 时不压缩（没有可压缩的空间）', () => {
    expect(
      shouldCompactHistory({
        uncoveredTokens: 5000,
        historyBudgetTokens: 0,
        thresholdRatio: 0.75,
      })
    ).toBe(false)
  })
})

describe('findUncoveredRange：水位线语义', () => {
  const history = makeHistory({ turns: 5, tokensPerMessage: 100 })
  const breakdown = estimateHistoryTokens(history)

  it('从未压缩过时，缺口是窗口之前的全部历史', () => {
    const range = findUncoveredRange(history, breakdown, null, 4)
    expect(range.start).toBe(0)
    expect(range.end).toBe(4)
    expect(range.messages).toHaveLength(4)
    expect(range.tokens).toBe(
      breakdown.perMessage.slice(0, 4).reduce((a, b) => a + b, 0)
    )
  })

  it('水位线之后的才是缺口（已经摘过的部分不重复摘）', () => {
    const range = findUncoveredRange(history, breakdown, 'm-3', 6)
    expect(range.start).toBe(4)
    expect(range.end).toBe(6)
    expect(range.messages.map((m) => m.id)).toEqual(['m-4', 'm-5'])
    expect(range.watermarkFound).toBe(true)
  })

  it('水位线之后没有新消息时缺口为空', () => {
    const range = findUncoveredRange(history, breakdown, 'm-9', 6)
    expect(range.messages).toEqual([])
    expect(range.tokens).toBe(0)
  })

  it('水位线消息被删除时退回 0 并标记 watermarkFound=false（宁可重复摘，不可丢失）', () => {
    const range = findUncoveredRange(history, breakdown, 'm-deleted', 6)
    expect(range.start).toBe(0)
    expect(range.watermarkFound).toBe(false)
    expect(range.messages).toHaveLength(6)
  })

  it('窗口起点早于水位线时不会产生负区间', () => {
    const range = findUncoveredRange(history, breakdown, 'm-7', 2)
    expect(range.start).toBe(8)
    expect(range.end).toBe(8)
    expect(range.messages).toEqual([])
  })
})

describe('buildSummaryPrompt：结构化与反幻觉约束', () => {
  const messages: ContextHistoryMessage[] = [
    { id: '1', role: 'user', content: '我叫 Alice' },
    { id: '2', role: 'assistant', content: '你好 Alice' },
  ]

  it('包含全部要求的小节', () => {
    const prompt = buildSummaryPrompt({
      previousSummary: null,
      messages,
      maxChars: 800,
    })
    const system = prompt[0].content
    for (const section of [
      '# 用户目标',
      '# 已确认的事实',
      '# 关键实体',
      '# 用户偏好与约束',
      '# 已做出的决定',
      '# 未解决的问题',
      '# 工具调用得出的重要结论',
    ]) {
      expect(system).toContain(section)
    }
  })

  it('写明了不许编造、不许推断偏好、必须保留姓名与数字', () => {
    const system = buildSummaryPrompt({
      previousSummary: null,
      messages,
      maxChars: 800,
    })[0].content
    expect(system).toContain('Never invent facts')
    expect(system).toContain('Never infer user preferences')
    expect(system).toContain('Preserve names, numbers')
  })

  it('把字数上限写进提示词（与硬上限用同一个数）', () => {
    const system = buildSummaryPrompt({
      previousSummary: null,
      messages,
      maxChars: 321,
    })[0].content
    expect(system).toContain('321 字')
  })

  it('没有旧摘要时不出现"已有摘要"段落；有旧摘要时必须带上', () => {
    const without = buildSummaryPrompt({
      previousSummary: null,
      messages,
      maxChars: 800,
    })[1].content
    expect(without).not.toContain('【已有摘要')

    const withOld = buildSummaryPrompt({
      previousSummary: '用户叫 Alice',
      messages,
      maxChars: 800,
    })[1].content
    expect(withOld).toContain('【已有摘要')
    expect(withOld).toContain('用户叫 Alice')
    expect(withOld).toContain('【新增对话】')
  })

  it('按角色渲染发言，便于模型区分谁说的', () => {
    const user = buildSummaryPrompt({
      previousSummary: null,
      messages,
      maxChars: 800,
    })[1].content
    expect(user).toContain('用户: 我叫 Alice')
    expect(user).toContain('助手: 你好 Alice')
  })
})

describe('capSummaryToTokens：输出侧的确定性硬上限', () => {
  it('未超限时原样返回（只去首尾空白）', () => {
    expect(capSummaryToTokens('  简短摘要  ', 100)).toBe('简短摘要')
  })

  it('超限时被压到上限内并留下截断标记', () => {
    const long = filler(5000)
    const capped = capSummaryToTokens(long, 500)
    expect(estimateTokens(capped)).toBeLessThanOrEqual(500)
    expect(capped).toContain('已截断')
  })

  it('空摘要与不可用上限都返回空字符串（调用方据此不推进水位线）', () => {
    expect(capSummaryToTokens('   ', 100)).toBe('')
    expect(capSummaryToTokens('内容', 5)).toBe('')
  })

  it('确定性：同样输入两次结果一致', () => {
    const long = filler(3000)
    expect(capSummaryToTokens(long, 400)).toBe(capSummaryToTokens(long, 400))
  })
})

describe('summarizeHistory：增量、分块与失败处理', () => {
  const baseInput = {
    apiKey: 'sk-test',
    model: 'test-model',
    previousSummary: null as string | null,
    chunkBudgetTokens: 5000,
    summaryMaxTokens: 800,
    totalTimeoutMs: 8000,
  }

  it('缺口为空时不调用模型，直接沿用旧摘要', async () => {
    let called = 0
    const result = await summarizeHistory({
      ...baseInput,
      previousSummary: '旧摘要',
      gapMessages: [],
      complete: async () => {
        called++
        return { text: 'x', usage: null }
      },
    })
    expect(called).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('旧摘要')
    expect(result.consumedCount).toBe(0)
  })

  it('成功时把旧摘要与缺口合并成新摘要，并报出推进条数', async () => {
    const gap = makeHistory({ turns: 3, tokensPerMessage: 10 })
    const result = await summarizeHistory({
      ...baseInput,
      previousSummary: '用户叫 Alice',
      gapMessages: gap,
      complete: async () => ({
        text: '合并后的摘要',
        usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      }),
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('合并后的摘要')
    expect(result.consumedCount).toBe(gap.length)
    expect(result.remainingCount).toBe(0)
    expect(result.usage?.totalTokens).toBe(60)
  })

  it('缺口超过单块预算时自动分块，每块都带上前一块的结果', async () => {
    const gap = makeHistory({ turns: 20, tokensPerMessage: 500 }) // 约 20000 token
    const prompts: string[] = []
    let index = 0

    const result = await summarizeHistory({
      ...baseInput,
      chunkBudgetTokens: 3000,
      gapMessages: gap,
      complete: async (input) => {
        prompts.push(input.messages[1].content)
        index++
        return { text: `摘要第${index}块`, usage: null }
      },
    })

    expect(prompts.length).toBe(MAX_SUMMARY_CHUNKS_PER_REQUEST)
    // 第一块没有旧摘要，第二块必须带上第一块的结果
    expect(prompts[0]).not.toContain('【已有摘要')
    expect(prompts[1]).toContain('【已有摘要')
    expect(prompts[1]).toContain('摘要第1块')
    // 只处理了上限内的块 → 水位线只推进这么多
    expect(result.consumedCount).toBeGreaterThan(0)
    expect(result.consumedCount).toBeLessThan(gap.length)
    expect(result.remainingCount).toBe(gap.length - result.consumedCount)
  })

  it('摘要模型报错时不抛出，退回 ok=false 并保留旧摘要', async () => {
    const gap = makeHistory({ turns: 2, tokensPerMessage: 10 })
    const result = await summarizeHistory({
      ...baseInput,
      previousSummary: '旧摘要',
      gapMessages: gap,
      complete: async () => {
        throw new Error('SiliconFlow API error: 503 - upstream busy')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('503')
    expect(result.summary).toBe('旧摘要')
    expect(result.consumedCount).toBe(0)
    expect(result.remainingCount).toBe(gap.length)
  })

  it('模型返回空内容时不推进水位线（那段历史必须留到下一轮重摘）', async () => {
    const gap = makeHistory({ turns: 2, tokensPerMessage: 10 })
    const result = await summarizeHistory({
      ...baseInput,
      gapMessages: gap,
      complete: async () => ({ text: '   ', usage: null }),
    })

    expect(result.consumedCount).toBe(0)
    expect(result.remainingCount).toBe(gap.length)
    expect(result.summary).toBeNull()
  })

  it('用户取消时不做摘要、不落库，也不算失败', async () => {
    const controller = new AbortController()
    controller.abort()
    const gap = makeHistory({ turns: 2, tokensPerMessage: 10 })
    let called = 0

    const result = await summarizeHistory({
      ...baseInput,
      gapMessages: gap,
      cancelSignal: controller.signal,
      complete: async () => {
        called++
        return { text: 'x', usage: null }
      },
    })

    expect(called).toBe(0)
    expect(result.cancelled).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('总超时后停在当前水位线，剩余缺口留给下一轮', async () => {
    const gap = makeHistory({ turns: 20, tokensPerMessage: 500 })
    const result = await summarizeHistory({
      ...baseInput,
      chunkBudgetTokens: 3000,
      totalTimeoutMs: 30,
      gapMessages: gap,
      // 模拟真实调用：上游请求会响应 abort 信号（createChatCompletion 用的就是它）
      complete: async (input) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('上游太慢')), 200)
          input.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('The operation was aborted'))
          })
        }),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('超时')
    expect(result.consumedCount).toBe(0)
  })

  it('分块上限内的成功是部分成功：ok=true 且 remainingCount > 0', async () => {
    const gap = makeHistory({ turns: 20, tokensPerMessage: 500 })
    const result = await summarizeHistory({
      ...baseInput,
      chunkBudgetTokens: 3000,
      gapMessages: gap,
      complete: async () => ({ text: '部分摘要', usage: null }),
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('部分摘要')
    expect(result.remainingCount).toBeGreaterThan(0)
  })

  it('摘要输出超长时被硬压到上限（压缩不能变成新的膨胀源）', async () => {
    const gap = makeHistory({ turns: 2, tokensPerMessage: 10 })
    const result = await summarizeHistory({
      ...baseInput,
      summaryMaxTokens: 200,
      gapMessages: gap,
      complete: async () => ({ text: filler(5000), usage: null }),
    })

    expect(result.summary).not.toBeNull()
    expect(estimateTokens(result.summary!)).toBeLessThanOrEqual(200)
  })
})

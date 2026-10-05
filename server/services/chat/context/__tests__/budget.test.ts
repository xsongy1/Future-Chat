/**
 * 分层预算测试
 *
 * 覆盖点：
 * - 窗口/输出预留的解析（含环境变量覆盖与非法值回退）
 * - 各层占用的计算与"总额不超可用上下文"的不变量
 * - 边界：预算刚好用完、预算为负、窗口被配得过小
 * - **守卫测试**：工具预留必须仍然覆盖 RAG / web_search 的真实输出上限
 */

import { describe, expect, it, afterEach } from 'vitest'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  THINKING_MAX_OUTPUT_TOKENS,
  getModelById,
  resolveMaxOutputTokens,
} from '@/shared/constants/models'
import { DEFAULT_TOP_K, MAX_SNIPPET_CHARS } from '@/server/services/rag'
import {
  TOOL_PAYLOAD_RESERVE_TOKENS,
  calculateToolReserveTokens,
  getContextConfig,
} from '../config'
import {
  finalizeContextBudget,
  planContextBudget,
  resolveContextWindowPlan,
} from '../budget'
import { estimateTokens } from '../tokens'
import { makeContextConfig } from './fixtures'

const MODEL = getModelById('deepseek-ai/DeepSeek-V3.2')!

afterEach(() => {
  delete process.env.CONTEXT_WINDOW_OVERRIDE
  delete process.env.CONTEXT_COMPACT_THRESHOLD_RATIO
  delete process.env.LLM_INPUT_PRICE_PER_1M_TOKENS
})

describe('resolveContextWindowPlan', () => {
  it('未覆盖时使用模型声明的保守窗口', () => {
    const plan = resolveContextWindowPlan(MODEL, false, makeContextConfig())
    expect(plan.contextWindow).toBe(MODEL.contextWindow)
    expect(plan.contextWindowOverridden).toBe(false)
  })

  it('环境变量可覆盖窗口（部署方核对 provider 文档后的精确值）', () => {
    const plan = resolveContextWindowPlan(
      MODEL,
      false,
      makeContextConfig({ contextWindowOverride: 128000 })
    )
    expect(plan.contextWindow).toBe(128000)
    expect(plan.contextWindowOverridden).toBe(true)
  })

  it('输出预留与真实下发的 max_tokens 同源', () => {
    const plain = resolveContextWindowPlan(MODEL, false, makeContextConfig())
    expect(plain.outputReserveTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(plain.outputReserveTokens).toBe(resolveMaxOutputTokens(MODEL, false))

    const thinking = resolveContextWindowPlan(MODEL, true, makeContextConfig())
    expect(thinking.outputReserveTokens).toBe(THINKING_MAX_OUTPUT_TOKENS)
    expect(thinking.outputReserveTokens).toBe(
      resolveMaxOutputTokens(MODEL, true)
    )
  })

  it('可用上下文 = 窗口 - 输出预留 - 安全边际', () => {
    const plan = resolveContextWindowPlan(MODEL, false, makeContextConfig())
    const afterOutput = plan.contextWindow - plan.outputReserveTokens
    expect(plan.safetyMarginTokens).toBe(Math.floor(afterOutput * 0.1))
    expect(plan.availableContextTokens).toBe(
      afterOutput - plan.safetyMarginTokens
    )
  })

  it('模型未声明窗口且未覆盖时抛出可操作的错误', () => {
    expect(() =>
      resolveContextWindowPlan(undefined, false, makeContextConfig())
    ).toThrow(/CONTEXT_WINDOW_OVERRIDE/)
  })

  it('窗口被配得过小时压缩输出预留，并保留最小可用上下文', () => {
    const plan = resolveContextWindowPlan(
      MODEL,
      false,
      makeContextConfig({ contextWindowOverride: 1000 })
    )
    expect(plan.outputReserveTokens).toBe(500) // 被压到窗口的 50%
    expect(plan.availableContextTokens).toBeGreaterThan(0)
  })
})

describe('calculateToolReserveTokens：只为真正会产出大载荷的工具预留', () => {
  it('没有启用任何大载荷工具时不预留', () => {
    const reserve = calculateToolReserveTokens([], 20000)
    expect(reserve.total).toBe(0)
  })

  it('generate_image 这类小结果工具不占用预留', () => {
    const reserve = calculateToolReserveTokens(['generate_image'], 20000)
    expect(reserve.total).toBe(0)
    expect(reserve.perTool).toEqual({})
  })

  it('知识库与搜索按各自单轮上限 × 预留轮数累加', () => {
    // 可用上下文取足够大，避免触发 25% 的封顶（封顶行为由下一条用例单独覆盖）
    const reserve = calculateToolReserveTokens(
      ['knowledge_search', 'web_search'],
      100000
    )
    expect(reserve.perTool.knowledge_search).toBe(
      TOOL_PAYLOAD_RESERVE_TOKENS.knowledge_search * 2
    )
    expect(reserve.perTool.web_search).toBe(
      TOOL_PAYLOAD_RESERVE_TOKENS.web_search * 2
    )
    expect(reserve.total).toBe(
      reserve.perTool.knowledge_search + reserve.perTool.web_search
    )
  })

  it('工具预留不超过可用上下文的 25%（不能让工具把历史挤没）', () => {
    const available = 4000
    const reserve = calculateToolReserveTokens(
      ['knowledge_search', 'web_search'],
      available
    )
    expect(reserve.total).toBeLessThanOrEqual(Math.floor(available * 0.25))
    // 缩放后各工具仍保持相对权重
    expect(reserve.perTool.knowledge_search).toBeGreaterThan(
      reserve.perTool.web_search
    )
  })
})

describe('工具预留守卫：真实输出上限变大时必须让测试失败', () => {
  it('knowledge_search 的预留 ≥ 一次检索的最大片段总量', () => {
    const worstCaseTokens = estimateTokens(
      '测'.repeat(DEFAULT_TOP_K * MAX_SNIPPET_CHARS)
    )
    expect(TOOL_PAYLOAD_RESERVE_TOKENS.knowledge_search).toBeGreaterThanOrEqual(
      worstCaseTokens
    )
  })

  it('web_search 的预留 ≥ 5 条结果（标题 + URL + 200 字符正文）的量级', () => {
    // 5 条 × (标题 40 + URL 60 + 正文 200 + 结构字符 40) ≈ 1700 字符
    const worstCaseTokens = estimateTokens('测'.repeat(1700))
    expect(TOOL_PAYLOAD_RESERVE_TOKENS.web_search).toBeGreaterThanOrEqual(
      worstCaseTokens
    )
  })

  it('守卫本身是有效的：把上限调大后同一个断言会失败', () => {
    const doubled = estimateTokens(
      '测'.repeat(DEFAULT_TOP_K * 2 * MAX_SNIPPET_CHARS)
    )
    expect(doubled).toBeGreaterThan(
      TOOL_PAYLOAD_RESERVE_TOKENS.knowledge_search
    )
  })
})

describe('planContextBudget / finalizeContextBudget', () => {
  const baseInput = {
    model: MODEL,
    enableThinking: false,
    config: makeContextConfig(),
    systemTokens: 2000,
    currentUserTokens: 100,
    enabledToolNames: [] as string[],
  }

  it('没有附件与工具时，历史预算 = 可用上下文 - system - 当前消息', () => {
    const plan = planContextBudget(baseInput)
    const budget = finalizeContextBudget(plan, 0, 0)
    expect(budget.historyBudgetTokens).toBe(
      budget.availableContextTokens - 2000 - 100
    )
    expect(budget.recentBudgetTokens).toBe(budget.historyBudgetTokens)
    expect(budget.overflowTokens).toBe(0)
  })

  it('附件上限 = 剩余空间的一半，且不超过绝对上限', () => {
    const plan = planContextBudget(baseInput)
    const remaining = plan.availableContextTokens - 2000 - 100
    // 默认绝对上限 12000 比"剩余空间的一半"更小，所以这里取到了上限
    expect(plan.attachmentBudgetTokens).toBe(
      Math.min(
        Math.floor(remaining * 0.5),
        makeContextConfig().attachmentMaxTokens
      )
    )
    expect(plan.attachmentBudgetTokens).toBe(12000)

    const raised = planContextBudget({
      ...baseInput,
      config: makeContextConfig({ attachmentMaxTokens: 999999 }),
    })
    expect(raised.attachmentBudgetTokens).toBe(Math.floor(remaining * 0.5))
  })

  it('摘要占用从历史预算里扣除，不额外增加总额', () => {
    const plan = planContextBudget(baseInput)
    const budget = finalizeContextBudget(plan, 0, 500)
    expect(budget.summaryTokens).toBe(500)
    expect(budget.recentBudgetTokens).toBe(budget.historyBudgetTokens - 500)
  })

  it('摘要超过历史预算时被压到历史预算内（不会产生负的窗口预算）', () => {
    const tiny = planContextBudget({
      ...baseInput,
      systemTokens: 100,
      config: makeContextConfig({ contextWindowOverride: 2000 }),
    })
    const budget = finalizeContextBudget(tiny, 0, 999999)
    expect(budget.summaryTokens).toBeLessThanOrEqual(budget.historyBudgetTokens)
    expect(budget.recentBudgetTokens).toBeGreaterThanOrEqual(0)
  })

  it('不变量：各层占用之和 + 历史预算 == 可用上下文', () => {
    const plan = planContextBudget({
      ...baseInput,
      enabledToolNames: ['knowledge_search', 'web_search'],
    })
    const budget = finalizeContextBudget(plan, 1234, 300)
    const sum =
      budget.systemTokens +
      budget.currentUserTokens +
      budget.toolReserveTokens +
      budget.attachmentTokens +
      budget.historyBudgetTokens
    expect(sum).toBe(budget.availableContextTokens)
  })

  it('当前消息本身就超过可用上下文时如实报出 overflow（交给上层降级）', () => {
    const systemTokens = 2000
    const window = resolveContextWindowPlan(MODEL, false, makeContextConfig())
    const overflowing = window.availableContextTokens - systemTokens + 500

    const plan = planContextBudget({
      ...baseInput,
      systemTokens,
      currentUserTokens: overflowing,
    })
    const budget = finalizeContextBudget(plan, 0, 0)

    expect(budget.historyBudgetTokens).toBe(0)
    expect(budget.recentBudgetTokens).toBe(0)
    expect(budget.overflowTokens).toBe(500)
  })

  it('恰好等于上限：既不是溢出，历史预算也为 0（边界是闭区间）', () => {
    const systemTokens = 2000
    const window = resolveContextWindowPlan(MODEL, false, makeContextConfig())
    const exact = window.availableContextTokens - systemTokens

    const plan = planContextBudget({
      ...baseInput,
      systemTokens,
      currentUserTokens: exact,
    })
    const budget = finalizeContextBudget(plan, 0, 0)

    expect(budget.historyBudgetTokens).toBe(0)
    expect(budget.overflowTokens).toBe(0)
  })

  it('零预算：历史预算为 0 且不产生负数', () => {
    const plan = planContextBudget({ ...baseInput, currentUserTokens: 0 })
    const budget = finalizeContextBudget(plan, plan.attachmentBudgetTokens, 0)
    expect(budget.historyBudgetTokens).toBeGreaterThanOrEqual(0)
    expect(budget.recentBudgetTokens).toBeGreaterThanOrEqual(0)
  })
})

describe('getContextConfig：环境变量解析', () => {
  /**
   * 压缩阈值的生产默认值
   *
   * 0.1 由 `pnpm context:bench` 的阈值扫描定出来的（见 config.ts 里的对照表与
   * docs/context-benchmark.md）。这里硬编码它是**故意的**：默认值被悄悄改回 0.75
   * 会让"暂时不可见的旧对话"峰值从 9.9% 涨到 74.9% 的历史预算，
   * 而那是很难在线上察觉的退化，必须有测试挡住。
   */
  const PRODUCTION_COMPACT_THRESHOLD = 0.1

  it('未配置时使用默认值，价格为 null（不编造价格）', () => {
    const config = getContextConfig()
    expect(config.contextWindowOverride).toBeNull()
    expect(config.compactThresholdRatio).toBeCloseTo(
      PRODUCTION_COMPACT_THRESHOLD
    )
    expect(config.summaryChunkMaxTokens).toBeGreaterThan(0)
    expect(config.inputPricePer1MTokens).toBeNull()
    expect(config.outputPricePer1MTokens).toBeNull()
  })

  it('非法值回退到默认值而不是让请求失败', () => {
    process.env.CONTEXT_COMPACT_THRESHOLD_RATIO = '3'
    expect(getContextConfig().compactThresholdRatio).toBeCloseTo(
      PRODUCTION_COMPACT_THRESHOLD
    )

    process.env.CONTEXT_WINDOW_OVERRIDE = 'abc'
    expect(getContextConfig().contextWindowOverride).toBeNull()
  })

  it('配置了价格时按每百万 token 读取', () => {
    process.env.LLM_INPUT_PRICE_PER_1M_TOKENS = '2'
    expect(getContextConfig().inputPricePer1MTokens).toBe(2)
  })
})

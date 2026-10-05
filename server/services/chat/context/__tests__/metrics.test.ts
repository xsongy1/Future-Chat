/**
 * 指标与成本估算测试
 *
 * 两类断言：
 * 1. **不编造价格**：未配置单价时成本必须是 null，而不是拿一个硬编码数字冒充事实
 * 2. **估算 vs 实测的方向可解释**：estimationErrorRatio 的正负必须对应
 *    "估算偏低（危险）/ 偏高（安全）"，否则线上校准会调反方向
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareEstimatedToActual,
  estimateCost,
  finalizeMetrics,
  logContextMetrics,
  type ContextMetrics,
} from '../metrics'
import { TOKEN_ESTIMATOR_KIND } from '../tokens'
import { isContextLengthError } from '../index'
import { makeContextConfig } from './fixtures'

function makeMetrics(overrides: Partial<ContextMetrics> = {}): ContextMetrics {
  return finalizeMetrics({
    modelId: 'deepseek-ai/DeepSeek-V3.2',
    contextWindow: 32768,
    contextWindowOverridden: false,
    outputReserveTokens: 1024,
    safetyMarginTokens: 3174,
    availableContextTokens: 28570,
    hardInputLimitTokens: 31744,
    estimatedInputTokens: 1000,
    systemTokens: 100,
    currentUserTokens: 20,
    historyTokens: 800,
    summaryTokens: 0,
    recentMessageTokens: 800,
    attachmentTokens: 0,
    ragReserveTokens: 0,
    toolReserveTokens: 0,
    historyBudgetTokens: 28450,
    recentBudgetTokens: 28450,
    historyMessageCount: 10,
    retainedMessageCount: 10,
    uncoveredTokens: 0,
    wasCompacted: false,
    compactionFailed: false,
    summaryReused: false,
    wasTruncated: false,
    attachmentCount: 0,
    droppedAttachmentCount: 0,
    fallback: 'none',
    estimatedInputCost: null,
    ...overrides,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('estimateCost：不编造价格', () => {
  const usage = {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    totalTokens: 1_500_000,
  }

  it('未配置单价时全部为 null（宁可显示"未配置"，也不显示一个假数字）', () => {
    const cost = estimateCost(usage, makeContextConfig())
    expect(cost.inputCost).toBeNull()
    expect(cost.outputCost).toBeNull()
    expect(cost.totalCost).toBeNull()
  })

  it('配置了单价时按每百万 token 线性换算', () => {
    const cost = estimateCost(
      usage,
      makeContextConfig({ inputPricePer1MTokens: 2, outputPricePer1MTokens: 8 })
    )
    expect(cost.inputCost).toBeCloseTo(2)
    expect(cost.outputCost).toBeCloseTo(4)
    expect(cost.totalCost).toBeCloseTo(6)
  })

  it('只配置了输入价时总价仍为 null（不能拿半份数据算总价）', () => {
    const cost = estimateCost(
      usage,
      makeContextConfig({ inputPricePer1MTokens: 2 })
    )
    expect(cost.inputCost).toBeCloseTo(2)
    expect(cost.outputCost).toBeNull()
    expect(cost.totalCost).toBeNull()
  })

  it('零用量成本为 0（而不是 null）', () => {
    const cost = estimateCost(
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      makeContextConfig({ inputPricePer1MTokens: 2, outputPricePer1MTokens: 8 })
    )
    expect(cost.totalCost).toBe(0)
  })
})

describe('compareEstimatedToActual：误差方向可解释', () => {
  it('没有真实用量时误差为 null（不假装估得准）', () => {
    expect(compareEstimatedToActual(1000, null).estimationErrorRatio).toBeNull()
    expect(compareEstimatedToActual(1000, 0).estimationErrorRatio).toBeNull()
  })

  it('估算高于实测 → 负值（安全方向，只会让我们提前压缩）', () => {
    const result = compareEstimatedToActual(1200, 1000)
    expect(result.estimationErrorRatio).toBeCloseTo(-0.2)
  })

  it('估算低于实测 → 正值（危险方向，需要收紧系数）', () => {
    const result = compareEstimatedToActual(800, 1000)
    expect(result.estimationErrorRatio).toBeCloseTo(0.2)
  })

  it('完全吻合时为 0', () => {
    expect(compareEstimatedToActual(1000, 1000).estimationErrorRatio).toBe(0)
  })
})

describe('finalizeMetrics：结构稳定', () => {
  it('补齐默认字段并打上估算器标记', () => {
    const metrics = makeMetrics()
    expect(metrics.estimator).toBe(TOKEN_ESTIMATOR_KIND)
    expect(metrics.buildDurationMs).toBe(0)
  })

  it('显式传入的 buildDurationMs 不会被覆盖', () => {
    const metrics = finalizeMetrics({
      ...makeMetrics(),
      buildDurationMs: 42,
    })
    expect(metrics.buildDurationMs).toBe(42)
  })
})

describe('isContextLengthError：用 provider 真实报文验证过', () => {
  it('识别 SiliconFlow 真实返回的超限报文（code 20015 / max_prompt_tokens）', () => {
    // ⚠️ 这条字符串是从真实接口原样粘回来的，不要"顺手改通顺"——
    // 它的价值就在于逐字对应线上会出现的报文
    const real = new Error(
      'SiliconFlow API error: 400 - {"code":20015,"message":"number of input tokens (249319) ' +
        'has exceeded max_prompt_tokens (163840) limit.","data":null}'
    )
    expect(isContextLengthError(real)).toBe(true)
  })

  it('识别 OpenAI 风格的 context_length_exceeded', () => {
    expect(
      isContextLengthError(new Error('{"code":"context_length_exceeded"}'))
    ).toBe(true)
    expect(
      isContextLengthError(new Error('maximum context length is 8192 tokens'))
    ).toBe(true)
    expect(isContextLengthError(new Error('too many tokens in request'))).toBe(
      true
    )
  })

  it('不把无关错误误判成超窗（误判会白花一次大请求的钱）', () => {
    expect(
      isContextLengthError(
        new Error('SiliconFlow API error: 401 - invalid api key')
      )
    ).toBe(false)
    expect(
      isContextLengthError(
        new Error('SiliconFlow API error: 429 - rate limit reached')
      )
    ).toBe(false)
    expect(isContextLengthError(new Error('fetch failed'))).toBe(false)
    expect(isContextLengthError(null)).toBe(false)
    expect(isContextLengthError(undefined)).toBe(false)
  })
})

describe('logContextMetrics：单行结构化、测试环境静默', () => {
  it('生产环境用 warn 输出一行可被 JSON.parse 的日志', () => {
    // NODE_ENV 在 Next 的类型定义里是只读的，所以用 vitest 的 stubEnv 而不是直接赋值
    vi.stubEnv('NODE_ENV', 'production')
    // 必须断言 console.warn：next.config.ts 的 removeConsole 会把生产构建里的
    // console.log 整段删掉，用 log 输出的指标在线上等于没有
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      logContextMetrics(makeMetrics({ wasCompacted: true }))
      expect(logSpy).not.toHaveBeenCalled()
      expect(spy).toHaveBeenCalledTimes(1)

      const line = spy.mock.calls[0][0] as string
      expect(line.startsWith('[Context] ')).toBe(true)
      const parsed = JSON.parse(
        line.slice('[Context] '.length)
      ) as ContextMetrics
      expect(parsed.wasCompacted).toBe(true)
      expect(parsed.contextWindow).toBe(32768)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('CONTEXT_METRICS_LOG=off 时静默（生产可选择关掉这条逐请求日志）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CONTEXT_METRICS_LOG', 'off')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      logContextMetrics(makeMetrics())
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('测试环境不输出（否则一次单测会刷上千行 JSON，淹掉失败信息）', () => {
    vi.stubEnv('NODE_ENV', 'test')
    delete process.env.CONTEXT_METRICS_LOG
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      logContextMetrics(makeMetrics())
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

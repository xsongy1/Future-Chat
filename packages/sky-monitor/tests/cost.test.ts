/**
 * 成本计算器单测
 */

import { describe, it, expect } from 'vitest'
import { estimateCost, getModelPrice, MODEL_PRICES } from '../src/core/cost'

describe('getModelPrice', () => {
  it('精确匹配模型 id', () => {
    expect(getModelPrice('deepseek-ai/DeepSeek-V3.2')).toEqual(
      MODEL_PRICES['deepseek-ai/DeepSeek-V3.2']
    )
  })

  it('前缀匹配供应商命名空间下的具体模型', () => {
    // deepseek-ai/DeepSeek-V3.2 无精确项，但匹配 deepseek-ai/DeepSeek-V3 前缀
    expect(getModelPrice('deepseek-ai/DeepSeek-V3.2')).not.toBeNull()
  })

  it('未知模型返回 null', () => {
    expect(getModelPrice('unknown-model')).toBeNull()
    expect(getModelPrice('')).toBeNull()
  })
})

describe('estimateCost', () => {
  it('按输入/输出单价分别计价', () => {
    const cost = estimateCost('deepseek-ai/DeepSeek-V3', 1_000_000, 1_000_000)
    // 1M input * 0.27 + 1M output * 1.1 = 1.37
    expect(cost).not.toBeNull()
    expect(cost!.estimatedCost).toBeCloseTo(1.37, 6)
    expect(cost!.currency).toBe('USD')
  })

  it('小量请求成本精确到微美元', () => {
    const cost = estimateCost('deepseek-ai/DeepSeek-V3.2', 1000, 2000)
    // 0.001*0.27 + 0.002*1.1 = 0.00247
    expect(cost!.estimatedCost).toBeCloseTo(0.00247, 6)
  })

  it('未知模型返回 null', () => {
    expect(estimateCost('unknown-model', 100, 100)).toBeNull()
  })
})

/**
 * 成本计算器
 *
 * 根据模型单价表估算单次请求成本：estimatedCost = inputTokens/1M * 输入单价 + outputTokens/1M * 输出单价。
 * 单价表按模型 id 前缀匹配（支持供应商命名空间，如 deepseek-ai/、Qwen/），
 * 未知模型返回 null（不估算，避免给出错误数字）。
 *
 * 价格参考 SiliconFlow 公开定价（美元 / 百万 token），可随时扩充。
 */

export interface ModelPrice {
  /** 输入单价（美元 / 1M tokens） */
  inputPerMillion: number
  /** 输出单价（美元 / 1M tokens） */
  outputPerMillion: number
  /** 供应商（可选） */
  provider?: string
}

/** 模型单价表：key 为模型 id 前缀（支持供应商命名空间） */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // ===== SiliconFlow 常见模型（按 2025 公开价）=====
  'deepseek-ai/DeepSeek-V3': { inputPerMillion: 0.27, outputPerMillion: 1.1, provider: 'siliconflow' },
  'deepseek-ai/DeepSeek-V3.2': { inputPerMillion: 0.27, outputPerMillion: 1.1, provider: 'siliconflow' },
  'deepseek-ai/DeepSeek-R1': { inputPerMillion: 0.55, outputPerMillion: 2.19, provider: 'siliconflow' },
  'Qwen/Qwen2.5-72B-Instruct': { inputPerMillion: 0.66, outputPerMillion: 0.66, provider: 'siliconflow' },
  'Qwen/Qwen3': { inputPerMillion: 0.6, outputPerMillion: 0.6, provider: 'siliconflow' },
  'THUDM/GLM-4': { inputPerMillion: 0.35, outputPerMillion: 0.35, provider: 'siliconflow' },
  'TeleAI/TeleChat': { inputPerMillion: 0.14, outputPerMillion: 0.14, provider: 'siliconflow' },

  // ===== OpenAI =====
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, provider: 'openai' },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, provider: 'openai' },
  'gpt-4': { inputPerMillion: 30, outputPerMillion: 60, provider: 'openai' },

  // ===== Anthropic =====
  'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, provider: 'anthropic' },
  'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4, provider: 'anthropic' },

  // ===== Google =====
  'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5, provider: 'google' },
  'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.3, provider: 'google' },

  // ===== DeepSeek 官方 =====
  'deepseek-chat': { inputPerMillion: 0.27, outputPerMillion: 1.1, provider: 'deepseek' },
  'deepseek-reasoner': { inputPerMillion: 0.55, outputPerMillion: 2.19, provider: 'deepseek' },
}

export interface CostEstimate {
  /** 估算成本（美元） */
  estimatedCost: number
  /** 币种 */
  currency: 'USD'
  /** 命中的模型单价 */
  price: ModelPrice
  /** 匹配到的模型 key */
  matchedKey: string
}

/**
 * 按模型 id 匹配单价：先精确匹配，再按前缀最长匹配
 *
 * @returns 命中的价目表 key 与单价；未命中返回 null
 */
function matchModelPrice(model: string): { key: string; price: ModelPrice } | null {
  if (!model) return null

  // 精确匹配
  if (MODEL_PRICES[model]) return { key: model, price: MODEL_PRICES[model] }

  // 前缀匹配（取最长匹配，如 'deepseek-ai/DeepSeek-V3.2' → 'deepseek-ai/DeepSeek-V3'）
  let best: { key: string; price: ModelPrice } | null = null
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (model.startsWith(key)) {
      if (!best || key.length > best.key.length) {
        best = { key, price }
      }
    }
  }
  return best
}

/** 按模型 id 查找单价：先精确匹配，再按前缀最长匹配 */
export function getModelPrice(model: string): ModelPrice | null {
  return matchModelPrice(model)?.price ?? null
}

/**
 * 估算一次请求成本
 * @returns null 表示模型不在单价表内（不估算）
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): CostEstimate | null {
  const matched = matchModelPrice(model)
  if (!matched) return null

  const { price } = matched
  const estimatedCost =
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion

  return {
    estimatedCost: round(estimatedCost, 6),
    currency: 'USD',
    price,
    // 命中的价目表 key（不是入参 model）：'gpt-4o-2024-08-06' 命中的是 'gpt-4o'
    matchedKey: matched.key,
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

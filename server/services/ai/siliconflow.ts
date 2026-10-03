/**
 * SiliconFlow AI API 封装
 * 
 * 负责与 SiliconFlow API 的通信
 */

import {
  CHAT_MODELS,
  EMBEDDING_MODELS,
  RERANK_MODELS,
  getModelById,
  getEmbeddingModelById,
  getRerankModelById,
} from '@/shared/constants/models'

const SILICONFLOW_API_URL = 'https://api.siliconflow.cn/v1/chat/completions'
const SILICONFLOW_EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'
const SILICONFLOW_RERANK_URL = 'https://api.siliconflow.cn/v1/rerank'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  model: string
  messages: ChatMessage[]
  enableThinking?: boolean
  thinkingBudget?: number
  tools?: unknown[]
  toolChoice?: 'auto' | 'required' | { type: 'function'; function: { name: string } }
  /** 取消信号：客户端断开或用户取消时中断上游请求 */
  signal?: AbortSignal
}

export interface SiliconFlowResponse {
  reader: ReadableStreamDefaultReader<Uint8Array>
}

/**
 * 调用 SiliconFlow Chat Completion API（流式）
 */
export async function createChatCompletion(
  apiKey: string,
  options: ChatCompletionOptions
): Promise<SiliconFlowResponse> {
  const { model, messages, enableThinking = false, thinkingBudget = 4096, tools, toolChoice, signal } = options
  
  const modelInfo = getModelById(model)

  // 白名单校验：防止配置漂移导致请求打到未授权/已下线的模型
  if (!modelInfo) {
    throw new Error(
      `Unsupported model "${model}". Allowed models: ${CHAT_MODELS.map(m => m.id).join(', ')}`
    )
  }
  
  // 构建请求体
  const requestBody: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: enableThinking || modelInfo?.isReasoningModel ? 4096 : 1024,
  }

  // Reasoning 模型：只用 thinking_budget
  if (modelInfo?.isReasoningModel) {
    requestBody.thinking_budget = thinkingBudget
  }
  // 普通模型支持思考开关：用 enable_thinking + thinking_budget
  else if (enableThinking && modelInfo?.supportsThinkingToggle) {
    requestBody.enable_thinking = true
    requestBody.thinking_budget = thinkingBudget
  }

  // 如果提供了 tools，添加到请求中
  if (tools && Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools
    // 默认 auto，有工具时让 AI 自己决定
    requestBody.tool_choice = toolChoice || 'auto'
  }

  const response = await fetch(SILICONFLOW_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`SiliconFlow API error: ${response.status} - ${errorText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('No stream available')
  }

  return { reader }
}

/** Embedding 请求超时（批量文本比单次对话慢，给足余量） */
const EMBEDDING_TIMEOUT = 30000

export interface EmbeddingOptions {
  model: string
  /** 待向量化文本，批量一次请求 */
  input: string[]
  signal?: AbortSignal
}

/**
 * 调用 SiliconFlow Embeddings API
 *
 * 与 createChatCompletion 同一 provider（同一 API Key、同一鉴权方式），
 * 只把 URL 换成 /v1/embeddings，不引入第二套 SDK。
 *
 * @returns 与 input 顺序一致的向量数组
 */
export async function createEmbedding(
  apiKey: string,
  options: EmbeddingOptions
): Promise<number[][]> {
  const { model, input, signal } = options

  if (input.length === 0) return []

  // 白名单校验：embedding 模型与聊天模型不共用列表，避免误用对话模型
  const modelInfo = getEmbeddingModelById(model)
  if (!modelInfo) {
    throw new Error(
      `Unsupported embedding model "${model}". Allowed models: ${EMBEDDING_MODELS.map(m => m.id).join(', ')}`
    )
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), EMBEDDING_TIMEOUT)

  const fetchSignal = signal
    ? AbortSignal.any([timeoutController.signal, signal])
    : timeoutController.signal

  try {
    const response = await fetch(SILICONFLOW_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input, encoding_format: 'float' }),
      signal: fetchSignal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(
        `SiliconFlow embeddings error: ${response.status} - ${errorText}`
      )
    }

    const json = (await response.json()) as {
      data?: Array<{ embedding: number[]; index: number }>
    }

    const data = json.data
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error(
        `Embedding 返回数量不匹配：期望 ${input.length}，实际 ${data?.length ?? 0}`
      )
    }

    // 上游不保证数组顺序，按 index 归位后再交给调用方
    const sorted = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding)

    // 维度漂移防护：白名单里的 dimensions 与实际不符时，存进去的向量长度会不一致
    const actualDim = sorted[0]?.length ?? 0
    if (actualDim !== modelInfo.dimensions) {
      throw new Error(
        `Embedding 维度不匹配：模型 ${model} 白名单声明 ${modelInfo.dimensions} 维，实际返回 ${actualDim} 维。` +
          `请核对 shared/constants/models.ts 中的 EMBEDDING_MODELS 配置。`
      )
    }

    return sorted
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Rerank 请求超时（cross-encoder 要对 query×文档逐对打分，文档一多明显慢于 embedding） */
const RERANK_TIMEOUT = 20000

export interface RerankOptions {
  model: string
  query: string
  /** 待打分文本，顺序即返回结果的 index 基准 */
  documents: string[]
  /** 只保留前 N 条（省略时上游按自身默认截断） */
  topN?: number
  signal?: AbortSignal
}

/**
 * 调用 SiliconFlow Rerank API
 *
 * 与 createEmbedding 同一 provider（同一 API Key、同一鉴权方式），
 * 只把 URL 换成 /v1/rerank，不引入第二套 SDK。
 *
 * @returns 与 documents 顺序对齐的 { index, score }，按 index 升序
 */
export async function createRerank(
  apiKey: string,
  options: RerankOptions
): Promise<Array<{ index: number; score: number }>> {
  const { model, query, documents, topN, signal } = options

  if (documents.length === 0) return []

  // 白名单校验：rerank 模型与聊天/embedding 模型不共用列表，端点不同不可互换
  const modelInfo = getRerankModelById(model)
  if (!modelInfo) {
    throw new Error(
      `Unsupported rerank model "${model}". Allowed models: ${RERANK_MODELS.map(m => m.id).join(', ')}`
    )
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), RERANK_TIMEOUT)

  const fetchSignal = signal
    ? AbortSignal.any([timeoutController.signal, signal])
    : timeoutController.signal

  try {
    const requestBody: Record<string, unknown> = { model, query, documents }
    // topN 未指定时不能带 top_n=undefined：JSON.stringify 会把它丢掉，但显式传 null/0
    // 会被上游当成"取 0 条"，所以这个字段只能条件写入
    if (topN !== undefined) requestBody.top_n = topN

    const response = await fetch(SILICONFLOW_RERANK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: fetchSignal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`SiliconFlow rerank error: ${response.status} - ${errorText}`)
    }

    const json = (await response.json()) as {
      results?: Array<{ index: number; relevance_score: number }>
    }

    const results = json.results
    if (!Array.isArray(results)) {
      throw new Error(
        `Rerank 返回格式异常：期望 results 为数组，实际 ${typeof results}`
      )
    }

    // 返回条数理论上只会因 top_n 变少，多出来必然是上游串了响应
    if (results.length > documents.length) {
      throw new Error(
        `Rerank 返回数量不匹配：期望不超过 ${documents.length}，实际 ${results.length}`
      )
    }

    // 越界 index 不可放过：分数会贴到错误的片段上，比"没有精排"更糟
    const outOfRange = results.find(
      (r) => !Number.isInteger(r?.index) || r.index < 0 || r.index >= documents.length
    )
    if (outOfRange) {
      throw new Error(
        `Rerank 返回下标越界：期望 0~${documents.length - 1}（共 ${documents.length} 篇），` +
          `实际 ${outOfRange.index}`
      )
    }

    // 上游不保证按 index 升序返回（实测是乱序的），归位后再交给调用方。
    // relevance_score 原样透传不做转换：解析层不该把 null/字符串"修"成 0 分，
    // 那会让一条坏数据变成"排最后但有效"，由调用方按有限数判断更准确。
    return [...results]
      .map((r) => ({ index: r.index, score: r.relevance_score }))
      .sort((a, b) => a.index - b.index)
  } finally {
    clearTimeout(timeoutId)
  }
}

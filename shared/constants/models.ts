/**
 * 硅基流动聊天模型配置（前端与服务端共享）
 *
 * 位于 shared/ 中立共享层：前端（模型选择器/聊天 store/UI store）与服务端
 * （模型白名单校验、默认模型、思考参数）共同引用，避免配置漂移。
 * lib/ 保持纯前端，不承载跨端代码。
 *
 * @see https://docs.siliconflow.cn/api-reference/chat-completions/chat-completions
 */

export interface Model {
  /** 模型 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 模型类别 */
  category: 'reasoning' | 'chat' | 'code' | 'vision'
  /** 是否为原生推理模型（只用 thinking_budget） */
  isReasoningModel: boolean
  /** 是否支持 enable_thinking 参数 */
  supportsThinkingToggle: boolean
  /** 是否为默认模型 */
  default?: boolean
  /** 最大 tokens */
  maxTokens?: number
}

/**
 * 聊天模型列表
 */
export const CHAT_MODELS: Model[] = [
  {
    id: 'Qwen/Qwen2.5-72B-Instruct',
    name: 'Qwen2.5-72B-Instruct',
    description: '通义千问 72B 对话模型',
    category: 'chat',
    isReasoningModel: false,
    supportsThinkingToggle: false,
    maxTokens: 8192,
  },
  {
    id: 'deepseek-ai/DeepSeek-V3.2',
    name: 'DeepSeek-V3.2',
    // 默认模型：Function Calling 稳定性直接决定知识库/工具调用能否触发。
    // Qwen2.5-72B-Instruct 实测会把工具调用写成正文文本（或误判"工具未开启"），
    // 导致 knowledge_search / web_search 时灵时不灵，故默认改用 DeepSeek-V3.2。
    description: '默认模型，Function Calling 稳定',
    category: 'chat',
    isReasoningModel: false,
    supportsThinkingToggle: true,
    default: true,
    maxTokens: 8192,
  },
]

/**
 * 获取默认模型
 */
export function getDefaultModel(): Model {
  return CHAT_MODELS.find(m => m.default) || CHAT_MODELS[0]
}

/**
 * 根据 ID 获取模型
 */
export function getModelById(id: string): Model | undefined {
  return CHAT_MODELS.find(m => m.id === id)
}

/**
 * 按类别获取模型
 */
export function getModelsByCategory(category: Model['category']): Model[] {
  return CHAT_MODELS.filter(m => m.category === category)
}

/**
 * 模型类别显示名称
 */
export const MODEL_CATEGORY_NAMES = {
  reasoning: '推理模型',
  chat: '对话模型',
  code: '代码模型',
  vision: '视觉模型',
} as const

/**
 * 硅基流动 Embedding 模型配置
 *
 * 与 CHAT_MODELS 分开维护：embedding 走 /v1/embeddings，不能用于对话。
 * 若混进 CHAT_MODELS，createChatCompletion 的白名单会把它当成聊天模型放行。
 *
 * dimensions 必须与该模型真实输出维度一致，否则 DocumentChunk.embedding
 * 存进去的向量长度不统一，检索时会算错相似度。
 *
 * @see https://api-docs.siliconflow.cn/docs/api/embeddings-post
 */
export interface EmbeddingModel {
  /** 模型 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 向量维度 */
  dimensions: number
  /** 是否为默认模型 */
  default?: boolean
}

/**
 * Embedding 模型列表（白名单）
 */
export const EMBEDDING_MODELS: EmbeddingModel[] = [
  {
    id: 'BAAI/bge-m3',
    name: 'BGE-M3',
    description: '多语言，中英文检索效果均衡',
    dimensions: 1024,
    default: true,
  },
  {
    id: 'BAAI/bge-large-zh-v1.5',
    name: 'BGE-Large-ZH',
    description: '中文检索优化',
    dimensions: 1024,
  },
  {
    id: 'Qwen/Qwen3-Embedding-0.6B',
    name: 'Qwen3-Embedding-0.6B',
    description: '轻量，速度更快',
    dimensions: 1024,
  },
]

/**
 * 获取默认 Embedding 模型
 */
export function getDefaultEmbeddingModel(): EmbeddingModel {
  return EMBEDDING_MODELS.find((m) => m.default) || EMBEDDING_MODELS[0]
}

/**
 * 根据 ID 获取 Embedding 模型
 */
export function getEmbeddingModelById(id: string): EmbeddingModel | undefined {
  return EMBEDDING_MODELS.find((m) => m.id === id)
}

/**
 * 硅基流动 Rerank 模型配置
 *
 * 与 CHAT_MODELS / EMBEDDING_MODELS 并列的第三份白名单：rerank 走 /v1/rerank，
 * 既不是对话补全也不是向量化。混进另外两份列表，会让 createChatCompletion /
 * createEmbedding 的白名单放行一个端点上根本不存在的模型。
 *
 * @see https://docs.siliconflow.cn/docs/api/rerank-post
 */
export interface RerankModel {
  /** 模型 ID */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 是否为默认模型 */
  default?: boolean
}

/**
 * Rerank 模型列表（白名单）
 *
 * 每一条都用真实请求验证过（2026-08 实测 /v1/rerank 返回 200 且带 relevance_score）。
 * 曾被写进这里但**不存在**的模型（实测报 400 Model does not exist）：
 *   - BAAI/bge-reranker-v2-minicpm-layerwise
 *   - netease-youdao/bce-reranker-base_v1（实测 403 Model disabled）
 * 白名单里放一个必然失败的 ID 是个陷阱：用户按文档配上去，只会在日志里看到
 * 一条"回退到默认模型"的 warn，检索质量悄悄变化而没有任何报错。
 */
export const RERANK_MODELS: RerankModel[] = [
  {
    id: 'BAAI/bge-reranker-v2-m3',
    name: 'BGE-Reranker-v2-M3',
    // 与默认 embedding 同源：向量召回和精排的打分口径一致，分数分布不会对不上
    description: '默认模型，中英文 cross-encoder 精排，与 BGE-M3 embedding 同源',
    default: true,
  },
  {
    id: 'Qwen/Qwen3-Reranker-0.6B',
    name: 'Qwen3-Reranker-0.6B',
    description: '轻量精排，延迟与成本更低，适合候选较多的场景',
  },
  {
    id: 'Qwen/Qwen3-Reranker-4B',
    name: 'Qwen3-Reranker-4B',
    description: '中大号精排，长文本与多语言场景的精度更好',
  },
]

/**
 * 获取默认 Rerank 模型
 */
export function getDefaultRerankModel(): RerankModel {
  return RERANK_MODELS.find((m) => m.default) || RERANK_MODELS[0]
}

/**
 * 根据 ID 获取 Rerank 模型
 */
export function getRerankModelById(id: string): RerankModel | undefined {
  return RERANK_MODELS.find((m) => m.id === id)
}

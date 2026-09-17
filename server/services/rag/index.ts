/**
 * RAG 核心服务
 *
 * 只做两件事：
 * - ingestDocument：文档 → chunk → embedding → 落库
 * - retrieve：query → embedding → 余弦相似度 Top-K → 给 AI 的文本 + 给前端的来源
 *
 * 刻意不引入 Orchestrator / Manager / Pipeline 之类的分层：整个 RAG 就是
 * 两个函数 + 一个纯切分函数，其余交给已有的 ToolRegistry 与 SSE 链路。
 *
 * ## 关于向量检索实现
 * 当前 PostgreSQL 实例（docker-compose.yml 的 postgres:16-alpine）没有 pgvector
 * 扩展，Prisma 也不原生支持 vector 类型，因此这里的方案是：
 *   - 向量存 DocumentChunk.embedding（Float[] → double precision[]）
 *   - 候选集取出后在应用层算余弦相似度
 * 代价是 O(n) 扫描，故用 MAX_SCAN_CHUNKS 限制单次参与计算的数据量。
 * 规模上来后的升级路径是装 pgvector、把相似度下推到 SQL，chunk 表结构不用改。
 */

import { createEmbedding } from '@/server/services/ai/siliconflow'
import {
  getDefaultEmbeddingModel,
  getEmbeddingModelById,
} from '@/shared/constants/models'
import { KnowledgeRepository, type RetrievedChunk } from '@/server/repositories/knowledge.repository'
import { chunkText, type Chunk } from './chunker'

/** 单次向量化请求的最大文本数（批量过小会让大文档入库变得很慢，过大容易触发上游限流） */
const EMBEDDING_BATCH_SIZE = 32

/** 默认返回片段数 */
const DEFAULT_TOP_K = 5

/** 单次检索参与相似度计算的最大 chunk 数（无 pgvector 时的扫描上限） */
const MAX_SCAN_CHUNKS = 2000

/**
 * 低于该余弦相似度的片段视为不相关，不返回给模型。
 *
 * 这个默认值来自实测标定，不是拍脑袋。用 BAAI/bge-m3 对一份多主题技术文档
 * 做 chunk 级检索，8 条「相关」查询的 Top-1 分数区间为 0.4465 ~ 0.6320，
 * 10 条「不相关」查询为 0.1970 ~ 0.4805。两者分布有重叠（相关的下沿低于不相关的上沿），
 * 所以不存在完美阈值，只能选折中点：
 *
 *   阈值   相关命中   不相关误命中
 *   0.30     8/8        4/10   ← 原值，明显偏低，容易把无关片段喂给模型
 *   0.45     7/8        1/10   ← 当前默认
 *   0.50     7/8        0/10
 *   0.55     4/8        0/10   ← 过于激进而漏检
 *
 * 为什么最终选 0.45 而不是 0.50：在「小知识库 + 口语化短问句」这种最常见的
 * 真实用法下，0.50 会误杀正确答案。实测（3 文档 / 3 chunk 的测试知识库）：
 *   - 「这个知识库的负责人是谁？」→ 正确片段只有 0.4510 → 被 0.50 全部过滤 → 检索为空、答不出
 *   - 而「生产环境部署在东京还是新加坡？」（文档里没有答案）→ 仍有 0.5557~0.6600
 *     的无关片段通过 0.50，说明「抬高阈值」并不能换来干净的"无结果"
 * 也就是说：高分噪声挡不住，低分正解却被挡住，绝对阈值在小语料上分辨力有限。
 * 好在模型侧有兜底——prompt 明确要求"片段不足以回答时如实说明知识库没有相关资料"，
 * 实测即使返回了无关片段，模型也会正确回答"没有找到"。因此这里偏向召回，取 0.45。
 *
 * 注意：该值依赖语料与 embedding 模型。换模型或换语料后应重新标定，
 * 可用环境变量 RAG_MIN_SCORE 覆盖（取值 0~1），无需改代码。
 */
const DEFAULT_MIN_SCORE = 0.45

/**
 * 解析相似度阈值（env 可覆盖）
 */
function resolveMinScore(): number {
  const raw = process.env.RAG_MIN_SCORE
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseFloat(raw)
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      return parsed
    }
    console.warn(
      `[RAG] RAG_MIN_SCORE="${raw}" 不是 0~1 的合法数值，回退到默认值 ${DEFAULT_MIN_SCORE}`
    )
  }
  return DEFAULT_MIN_SCORE
}

/** 每个片段在结果文本中的最大字符数（防止单片段撑爆上下文） */
const MAX_SNIPPET_CHARS = 600

/** 单次入库的文档最大 chunk 数（防止超大文件把库和上下文打爆） */
const MAX_CHUNKS_PER_DOCUMENT = 500

/** 解析当前使用的 Embedding 模型（env 可覆盖白名单默认值） */
export function resolveEmbeddingModelId(): string {
  const fromEnv = process.env.EMBEDDING_MODEL
  if (fromEnv) {
    const info = getEmbeddingModelById(fromEnv)
    if (!info) {
      throw new Error(
        `EMBEDDING_MODEL="${fromEnv}" 不在共享白名单中，请先在 shared/constants/models.ts 的 EMBEDDING_MODELS 中登记`
      )
    }
    return info.id
  }
  return getDefaultEmbeddingModel().id
}

/**
 * 批量向量化
 */
async function embedTexts(
  apiKey: string,
  texts: string[],
  signal?: AbortSignal
): Promise<number[][]> {
  const model = resolveEmbeddingModelId()
  const vectors: number[][] = []

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    signal?.throwIfAborted()
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE)
    const result = await createEmbedding(apiKey, { model, input: batch, signal })
    vectors.push(...result)
  }

  return vectors
}

/**
 * 余弦相似度
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 给前端展示的来源条目（与 web_search 的 URL 来源不同，这里是文件来源） */
export interface KnowledgeSource {
  /** 文档名 */
  documentName: string
  /** 文档内片段序号 */
  chunkIndex: number
  /** 余弦相似度，保留 4 位 */
  score: number
  /** 内容摘要 */
  snippet: string
}

export interface RetrievalOutcome {
  /** 给模型看的文本（作为 tool result 内容） */
  content: string
  /** 给前端展示的来源列表 */
  sources: KnowledgeSource[]
  /** 命中片段数 */
  resultCount: number
}

export interface IngestResult {
  documentId: string
  chunkCount: number
}

/**
 * 文档入库：切分 → 向量化 → 落库
 *
 * @param params.apiKey - 调用 embedding 的 API Key（复用聊天用的 SiliconFlow Key）
 * @param params.content - 已解析出的纯文本
 * @param params.signal - 取消信号
 */
export async function ingestDocument(params: {
  userId: string
  knowledgeBaseId: string
  name: string
  type: 'txt' | 'md'
  size: number
  content: string
  apiKey: string
  signal?: AbortSignal
}): Promise<IngestResult> {
  const { userId, knowledgeBaseId, name, type, size, content, apiKey, signal } = params

  const chunks: Chunk[] = chunkText(content)

  if (chunks.length === 0) {
    // 空文档不产生 chunk，直接失败，避免留下一个永远检索不到东西的"成功"记录
    await KnowledgeRepository.createDocument({
      knowledgeBaseId,
      name,
      type,
      size,
      status: 'failed',
      error: '文档内容为空，未解析到可入库文本',
      chunkCount: 0,
    })
    throw new Error('文档内容为空，未解析到可入库文本')
  }

  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    const msg = `文档切分后得到 ${chunks.length} 个片段，超过单文档上限 ${MAX_CHUNKS_PER_DOCUMENT}，请拆分后上传`
    await KnowledgeRepository.createDocument({
      knowledgeBaseId,
      name,
      type,
      size,
      status: 'failed',
      error: msg,
      chunkCount: 0,
    })
    throw new Error(msg)
  }

  // 向量化：失败时落一条 failed 文档，让用户在知识库里看得到失败原因
  let embeddings: number[][]
  try {
    embeddings = await embedTexts(apiKey, chunks.map((c) => c.content), signal)
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    await KnowledgeRepository.createDocument({
      knowledgeBaseId,
      name,
      type,
      size,
      status: 'failed',
      error: `文本向量化失败：${msg}`,
      chunkCount: 0,
    })
    throw new Error(`文本向量化失败：${msg}`)
  }

  // 文档与 chunk 必须一起落库（同一事务），避免出现 status=ready 却 0 chunk 的孤儿文档
  const document = await KnowledgeRepository.createDocumentWithChunks(
    {
      knowledgeBaseId,
      name,
      type,
      size,
      status: 'ready',
      chunkCount: chunks.length,
    },
    chunks.map((chunk, i) => ({
      index: chunk.index,
      content: chunk.content,
      embedding: embeddings[i],
    }))
  )

  // 让知识库列表按最近活跃排序（@updatedAt 只在知识库自身被 update 时刷新）
  await KnowledgeRepository.touchBase(knowledgeBaseId, userId)

  console.log(
    `[RAG] 文档入库完成: ${name} → ${chunks.length} 个片段 (${resolveEmbeddingModelId()})`
  )

  return { documentId: document.id, chunkCount: chunks.length }
}

/**
 * 检索：query → Top-K 相关片段
 *
 * @param params.userId - 当前登录用户（来自 getCurrentUserId，不信任客户端提交值）
 * @param params.knowledgeBaseId - 可选，限定单个知识库；仍会再走一次归属校验
 */
export async function retrieve(params: {
  userId: string
  query: string
  apiKey: string
  knowledgeBaseId?: string
  topK?: number
  signal?: AbortSignal
}): Promise<RetrievalOutcome> {
  const { userId, query, apiKey, knowledgeBaseId, topK = DEFAULT_TOP_K, signal } = params

  const trimmedQuery = query?.trim()
  if (!trimmedQuery) {
    return {
      content: '检索失败：query 不能为空。',
      sources: [],
      resultCount: 0,
    }
  }

  // 1. 收敛检索范围：只取当前用户拥有的知识库
  const ownedBaseIds = await KnowledgeRepository.findOwnedBaseIds(
    userId,
    knowledgeBaseId ? [knowledgeBaseId] : undefined
  )

  if (ownedBaseIds.length === 0) {
    // 指定了 id 却不在自己名下：不区分「不存在」与「无权」，避免泄露资源存在性
    const content = knowledgeBaseId
      ? '未检索到内容：该知识库不存在，或你没有访问权限。'
      : '未检索到内容：你还没有创建任何知识库，请先在知识库中上传文档。'
    return { content, sources: [], resultCount: 0 }
  }

  // 2. 向量化 query
  let queryVector: number[]
  try {
    const [vector] = await embedTexts(apiKey, [trimmedQuery], signal)
    queryVector = vector
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] query 向量化失败:', msg)
    return {
      content: `检索失败：查询向量化出错（${msg}）。请告知用户知识库检索暂时不可用。`,
      sources: [],
      resultCount: 0,
    }
  }

  // 3. 取候选片段（上限 MAX_SCAN_CHUNKS）
  let candidates: RetrievedChunk[]
  try {
    candidates = await KnowledgeRepository.findChunksForRetrieval(
      userId,
      ownedBaseIds,
      MAX_SCAN_CHUNKS
    )
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] 候选片段查询失败:', msg)
    return {
      content: `检索失败：读取知识库出错（${msg}）。请告知用户知识库检索暂时不可用。`,
      sources: [],
      resultCount: 0,
    }
  }

  if (candidates.length === 0) {
    return {
      content: '未检索到内容：知识库中还没有可检索的文档片段。',
      sources: [],
      resultCount: 0,
    }
  }

  // 4. 应用层余弦相似度 Top-K
  //    跳过维度不一致的片段（例如入库后换过 EMBEDDING_MODEL），否则会算出无意义的分数
  const scored = candidates
    .filter((c) => Array.isArray(c.embedding) && c.embedding.length === queryVector.length)
    .map((c) => ({
      chunk: c,
      score: cosineSimilarity(queryVector, c.embedding),
    }))
    .sort((a, b) => b.score - a.score)

  const dimMismatchCount = candidates.length - scored.length
  if (dimMismatchCount > 0) {
    console.warn(
      `[RAG] 有 ${dimMismatchCount} 个片段向量维度与当前查询不一致，已跳过。` +
        `常见原因是入库后更换了 EMBEDDING_MODEL，需要重新入库。`
    )
  }

  const hits = scored.filter((s) => s.score >= resolveMinScore()).slice(0, topK)

  if (hits.length === 0) {
    // 明确告诉模型"没检索到"，而不是让它靠常识编答案
    const extra =
      dimMismatchCount > 0
        ? `（另有 ${dimMismatchCount} 个片段因向量维度不匹配被跳过，可能需要重新入库）`
        : ''
    return {
      content: `未检索到与「${trimmedQuery}」相关的内容${extra}。请如实告知用户知识库中没有相关资料，不要凭常识编造答案。`,
      sources: [],
      resultCount: 0,
    }
  }

  // 5. 组装给模型的文本 + 给前端的来源
  const sources: KnowledgeSource[] = []
  const parts: string[] = [`从私有知识库中检索到 ${hits.length} 个相关片段：`]

  hits.forEach((hit, i) => {
    const snippet = hit.chunk.content.slice(0, MAX_SNIPPET_CHARS)
    parts.push(
      `\n[片段 ${i + 1}] 来源：${hit.chunk.documentName}\n${snippet}${
        hit.chunk.content.length > MAX_SNIPPET_CHARS ? '…' : ''
      }`
    )
    sources.push({
      documentName: hit.chunk.documentName,
      chunkIndex: hit.chunk.index,
      score: Number(hit.score.toFixed(4)),
      snippet: hit.chunk.content.slice(0, 120),
    })
  })

  parts.push(
    '\n请仅依据以上片段回答；若片段不足以回答，请明确说明知识库中没有相关信息。引用时请标注来源文件名。'
  )

  return {
    content: parts.join('\n'),
    sources,
    resultCount: hits.length,
  }
}

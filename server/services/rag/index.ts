/**
 * RAG 核心服务
 *
 * 对外只暴露两件事：
 * - ingestDocument：文档 → chunk → embedding → 落库（实现在 ./ingest.ts）
 * - retrieve：query → 混合召回 → 融合 → 精排 → 给 AI 的文本 + 给前端的来源
 *
 * 刻意不引入 Orchestrator / Manager / Pipeline 之类的分层：整个 RAG 就是
 * 两个入口 + 若干纯函数，其余交给已有的 ToolRegistry 与 SSE 链路。
 *
 * ## 检索链路（自下而上）
 *   1. 向量通道：pgvector KNN（相似度下推 SQL、走 HNSW）或应用层精确扫描
 *   2. 词法通道：BM25（CJK bigram 词项，走 GIN）
 *   3. RRF 融合：只看名次不看分数，因此不需要给两路分数标定权重
 *   4. cross-encoder 精排：纠正"关键词命中但答非所问"
 *   5. 相对阈值：用当前 query 的最好命中做参照，而不是一个全局常数
 *
 * ## 为什么去掉了绝对相似度阈值
 * 原实现用一个标定出来的常数（余弦 0.45）过滤片段，注释里记录了标定过程：
 * 8 条相关查询的 Top-1 落在 0.4465~0.6320，10 条不相关查询落在 0.1970~0.4805，
 * 两个分布重叠，于是阈值怎么选都是错的——0.30 放进 4/10 噪声，
 * 0.50 又会把正确答案（实测 0.4510）误杀。这说明问题不在"阈值调得准不准"，
 * 而在**单路余弦分在小语料上分辨力不足**，一个全局常数无法同时满足两种 query。
 * 现在的做法是：先靠两路召回 + 精排把候选排序做对，再用"相对当前最好命中"的比例
 * 阈值切尾；绝对下限只在精排不可用时作为兜底（见 RAG_VECTOR_MIN_SCORE 的注释）。
 */

import {
  embedQuery,
  resolveEmbeddingDim,
  resolveEmbeddingModelId,
} from './embedding'
import { searchByLexical } from './lexical'
import { exactScanByVector, searchByVector } from './vector-store'
import {
  reciprocalRankFusion,
  selectByRelativeThreshold,
  type RankedHit,
} from './fusion'
import { isRerankEnabled, rerankChunks, resolveRerankModel } from './rerank'
import {
  KnowledgeRepository,
  type RetrievedChunk,
} from '@/server/repositories/knowledge.repository'

export { ingestDocument } from './ingest'
export type { IngestResult, IngestParams } from './ingest'
export { resolveEmbeddingModelId } from './embedding'
export { MAX_CHUNKS_PER_DOCUMENT } from './ingest'

/** 默认返回片段数 */
const DEFAULT_TOP_K = 5

/** 单路召回候选数 = max(topK × 倍数, 下限)：融合与精排都需要比最终结果更多的候选才有得挑 */
const CANDIDATE_MULTIPLIER = 8
const CANDIDATE_MIN = 40

/** 进入精排的候选上限（精排按 query-文档对计费，这是成本闸门） */
const DEFAULT_FUSE_TOP = 30

/** 精排失败时的兜底：余弦分低于此值的片段不返回（仅在精排不可用时生效） */
const DEFAULT_VECTOR_MIN_SCORE = 0.35

/**
 * 每个片段在结果文本中的最大字符数（防止单片段撑爆上下文）
 */
const MAX_SNIPPET_CHARS = 600

/** 给前端展示的来源条目（与 web_search 的 URL 来源不同，这里是文件来源） */
export interface KnowledgeSource {
  /** 文档名 */
  documentName: string
  /** 文档内片段序号 */
  chunkIndex: number
  /** 最终得分（精排分或 RRF 分，保留 4 位） */
  score: number
  /** 内容摘要 */
  snippet: string
  /** 命中该片段的通道（vector / lexical），便于前端与排查共同判断 */
  channels?: string[]
  /** 向量余弦相似度（仅向量通道命中时有值） */
  vectorScore?: number
  /** BM25 分（仅词法通道命中时有值） */
  lexicalScore?: number
  /** 精排分（仅精排成功时有值） */
  rerankScore?: number
}

/** 检索诊断信息：出问题时先看这里，不用猜是哪条通道退化了 */
export interface RetrievalDebug {
  embeddingModel: string
  /** 当前模型的向量维度（与 chunk.embeddingDim 对不上时就是它导致的"跳过"） */
  embeddingDim: number
  vector: {
    backend: 'pgvector' | 'exact-scan' | 'unavailable'
    hits: number
    /** 精确扫描实际扫描的 chunk 数 */
    scanned?: number
    /** 因维度不匹配被跳过的片段数 */
    dimMismatch?: number
    /** 是否被 RAG_EXACT_SCAN_MAX_CHUNKS 截断 */
    truncated?: boolean
    /** 参与检索的旧模型（灰度重建期间） */
    legacyModels: string[]
  }
  lexical: { enabled: boolean; hits: number; terms: number }
  rerank: { enabled: boolean; applied: boolean; model: string; candidates: number }
  fused: number
  selected: number
  threshold: { ratio: number; absoluteFloor: number; mode: 'rerank' | 'fusion' }
  /** 降级原因（精排失败、旧模型查询失败、词法通道异常……） */
  degraded: string[]
}

export interface RetrievalOutcome {
  /** 给模型看的文本（作为 tool result 内容） */
  content: string
  /** 给前端展示的来源列表 */
  sources: KnowledgeSource[]
  /** 命中片段数 */
  resultCount: number
  /** 检索诊断（可观测性；不参与模型输入） */
  debug: RetrievalDebug
}

function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isInteger(parsed) && parsed >= min) return parsed
  if (raw) console.warn(`[RAG] ${name}="${raw}" 不是 >= ${min} 的整数，使用默认值 ${fallback}`)
  return fallback
}

function envFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[RAG] ${name}="${raw}" 不是 ${min}~${max} 的数值，使用默认值 ${fallback}`
    )
    return fallback
  }
  return parsed
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  return !['0', 'false', 'off', 'no'].includes(raw)
}

/** 降级原因最多展示几条，避免把 tool result 撑爆 */
const MAX_DEGRADED_NOTES = 3

/** RAG_MIN_SCORE 的废弃警告只打一次，避免每次检索都刷屏 */
let warnedLegacyMinScore = false

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
      debug: emptyDebug(),
    }
  }

  // ---- 1. 收敛检索范围：只取当前用户拥有的知识库 ----
  const ownedBaseIds = await KnowledgeRepository.findOwnedBaseIds(
    userId,
    knowledgeBaseId ? [knowledgeBaseId] : undefined
  )

  if (ownedBaseIds.length === 0) {
    // 指定了 id 却不在自己名下：不区分「不存在」与「无权」，避免泄露资源存在性
    const content = knowledgeBaseId
      ? '未检索到内容：该知识库不存在，或你没有访问权限。'
      : '未检索到内容：你还没有创建任何知识库，请先在知识库中上传文档。'
    return { content, sources: [], resultCount: 0, debug: emptyDebug() }
  }

  // ---- 2. 解析模型，并看范围内有没有"旧模型"的向量 ----
  let activeModel: string
  try {
    activeModel = resolveEmbeddingModelId()
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] embedding 模型配置错误:', msg)
    return {
      content: `检索失败：embedding 模型配置错误（${msg}）。请告知用户知识库检索暂时不可用。`,
      sources: [],
      resultCount: 0,
      debug: emptyDebug(),
    }
  }
  const activeDim = resolveEmbeddingDim(activeModel)

  const degraded: string[] = []
  let legacyModels: string[] = []
  let unknownModelCount = 0

  try {
    const distribution = await KnowledgeRepository.findChunkEmbeddingModels(ownedBaseIds)
    legacyModels = distribution
      .filter((row) => row.model !== null && row.model !== activeModel)
      .sort((a, b) => b.count - a.count)
      .map((row) => row.model as string)
    unknownModelCount = distribution
      .filter((row) => row.model === null)
      .reduce((sum, row) => sum + row.count, 0)
  } catch (error) {
    // 这个查询只用于"要不要为旧模型多查一次"，失败不应让检索整体失败：
    // 退化为只用当前模型检索，并在诊断里说明
    const msg = error instanceof Error ? error.message : '未知错误'
    degraded.push(`模型分布查询失败（${msg}），本次仅使用当前模型检索`)
  }

  // ---- 3. 查询向量化（当前模型；有旧模型时再为旧模型算一次） ----
  let activeVector: number[]
  try {
    const result = await embedQuery({ apiKey, query: trimmedQuery, model: activeModel, signal })
    activeVector = result.vector
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] query 向量化失败:', msg)
    return {
      content: `检索失败：查询向量化出错（${msg}）。请告知用户知识库检索暂时不可用。`,
      sources: [],
      resultCount: 0,
      debug: emptyDebug(),
    }
  }

  const grayQueryEnabled = envFlag('RAG_GRAY_LEGACY_QUERY', true)
  const maxLegacyModels = envInt('RAG_GRAY_MAX_LEGACY_MODELS', 1)
  const legacyVectors: Array<{ model: string; vector: number[] }> = []

  if (grayQueryEnabled && legacyModels.length > 0) {
    for (const model of legacyModels.slice(0, maxLegacyModels)) {
      try {
        const result = await embedQuery({ apiKey, query: trimmedQuery, model, signal })
        legacyVectors.push({ model, vector: result.vector })
      } catch (error) {
        const msg = error instanceof Error ? error.message : '未知错误'
        degraded.push(`旧模型 ${model} 的查询向量化失败（${msg}），该模型的片段本次未参与检索`)
      }
    }

    if (legacyModels.length > maxLegacyModels) {
      degraded.push(
        `库中存在 ${legacyModels.length} 个旧 embedding 模型，本次只为其中 ${maxLegacyModels} 个（片段最多的）做了查询，其余未参与检索`
      )
    }

    if (legacyVectors.length > 0) {
      console.log(
        `[RAG] 灰度期检索：当前模型 ${activeModel} + 旧模型 ${legacyVectors
          .map((l) => l.model)
          .join(', ')}（新模型完全重建后可执行 pnpm rag:rebuild）`
      )
    }
  }

  if (unknownModelCount > 0) {
    degraded.push(
      `${unknownModelCount} 个片段未标注 embedding 模型，未参与向量检索（请执行 pnpm rag:backfill 补齐）`
    )
  }

  // ---- 4. 混合召回 ----
  const candidateLimit = Math.max(topK * CANDIDATE_MULTIPLIER, CANDIDATE_MIN)
  const byId = new Map<string, RetrievedChunk>()
  const lists: RankedHit[][] = []

  let vectorBackend: RetrievalDebug['vector']['backend'] = 'unavailable'
  let vectorHits = 0
  let scanScanned: number | undefined
  let scanDimMismatch: number | undefined
  let scanTruncated: boolean | undefined

  const collect = (hits: Array<{ chunk: RetrievedChunk; score: number }>, channel: RankedHit['channel']) => {
    if (hits.length === 0) return
    for (const hit of hits) {
      // 同一片段可能被多个通道命中：保留首个写入的 chunk 元数据即可（内容相同）
      if (!byId.has(hit.chunk.id)) byId.set(hit.chunk.id, hit.chunk)
    }
    lists.push(
      hits.map((hit) => ({ id: hit.chunk.id, score: hit.score, channel }))
    )
  }

  const vectorTargets = [
    { model: activeModel, vector: activeVector },
    ...legacyVectors,
  ]

  try {
    for (const target of vectorTargets) {
      // 优先 pgvector；扩展不可用（或该模型向量不是 1024 维）时回退到分页精确扫描
      const knn = await searchByVector({
        ownedBaseIds,
        queryVector: target.vector,
        embeddingModel: target.model,
        limit: candidateLimit,
      })

      if (knn.enabled) {
        vectorBackend = 'pgvector'
        vectorHits += knn.hits.length
        collect(knn.hits, 'vector')
        continue
      }

      const scan = await exactScanByVector({
        ownedBaseIds,
        queryVector: target.vector,
        embeddingModel: target.model,
        limit: candidateLimit,
      })
      if (vectorBackend !== 'pgvector') vectorBackend = 'exact-scan'
      vectorHits += scan.hits.length
      scanScanned = (scanScanned ?? 0) + scan.scanned
      scanDimMismatch = (scanDimMismatch ?? 0) + scan.dimMismatch
      scanTruncated = scanTruncated || scan.truncated
      collect(scan.hits, 'vector')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] 向量通道失败:', msg)
    return {
      content: `检索失败：读取知识库出错（${msg}）。请告知用户知识库检索暂时不可用。`,
      sources: [],
      resultCount: 0,
      debug: emptyDebug(),
    }
  }

  let lexicalEnabled = false
  let lexicalHits = 0
  let lexicalTerms = 0

  try {
    const lexical = await searchByLexical({
      ownedBaseIds,
      query: trimmedQuery,
      limit: candidateLimit,
    })
    lexicalEnabled = lexical.enabled
    lexicalHits = lexical.hits.length
    lexicalTerms = lexical.terms.length
    collect(lexical.hits, 'lexical')
  } catch (error) {
    // 词法通道是"加分项"：GIN 索引没建好、tsquery 语法异常等都不该让整条检索失败
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error('[RAG] 词法通道失败:', msg)
    degraded.push(`词法检索失败（${msg}），本次仅使用向量召回`)
  }

  // ---- 5. 融合 ----
  const fused = reciprocalRankFusion(lists)
  const fuseTop = envInt('RAG_FUSE_TOP', DEFAULT_FUSE_TOP)
  const fusedTop = fused.slice(0, fuseTop)

  const baseDebug: RetrievalDebug = {
    embeddingModel: activeModel,
    embeddingDim: activeDim,
    vector: {
      backend: vectorBackend,
      hits: vectorHits,
      scanned: scanScanned,
      dimMismatch: scanDimMismatch,
      truncated: scanTruncated,
      legacyModels: legacyVectors.map((l) => l.model),
    },
    lexical: { enabled: lexicalEnabled, hits: lexicalHits, terms: lexicalTerms },
    rerank: {
      enabled: isRerankEnabled(),
      applied: false,
      model: resolveRerankModel(),
      candidates: 0,
    },
    fused: fused.length,
    selected: 0,
    threshold: { ratio: 0, absoluteFloor: 0, mode: 'fusion' },
    degraded,
  }

  if (fusedTop.length === 0) {
    // 一条候选都没有：先区分"库里没东西"和"有东西但没匹配上"，
    // 这两种情况给模型的提示完全不同（前者要用户先传文档）
    let totalChunks = 0
    try {
      totalChunks = await KnowledgeRepository.countRetrievableChunks(ownedBaseIds)
    } catch {
      // 计数失败不影响结论：按"有内容但没匹配上"处理
      totalChunks = 1
    }

    if (totalChunks === 0) {
      return {
        content: '未检索到内容：知识库中还没有可检索的文档片段。',
        sources: [],
        resultCount: 0,
        debug: baseDebug,
      }
    }

    return {
      content: noHitMessage(trimmedQuery, degraded, scanDimMismatch ?? 0),
      sources: [],
      resultCount: 0,
      debug: baseDebug,
    }
  }

  // ---- 6. 精排（失败自动降级为融合顺序） ----
  const rerankCandidates = fusedTop.map((hit) => ({
    id: hit.id,
    text: byId.get(hit.id)?.content ?? '',
  }))

  const reranked = await rerankChunks({
    apiKey,
    query: trimmedQuery,
    candidates: rerankCandidates,
    signal,
  })

  baseDebug.rerank.candidates = rerankCandidates.length

  // ---- 7. 选尾：相对阈值 ----
  let selected: Array<{ id: string; score: number }> = []
  let threshold: RetrievalDebug['threshold']

  if (reranked && reranked.length > 0) {
    const ratio = envFloat('RAG_RERANK_MIN_RATIO', 0.25, 0, 1)
    const absoluteFloor = envFloat('RAG_RERANK_MIN_SCORE', 0.05, 0, 1)
    threshold = { ratio, absoluteFloor, mode: 'rerank' }
    baseDebug.rerank.applied = true

    selected = selectByRelativeThreshold(reranked, { ratio, absoluteFloor }).map(
      (hit) => ({ id: hit.id, score: hit.score })
    )
  } else {
    // 兜底路径（精排不可用）：RRF 只看名次，所以用"名次截断 + 余弦下限"两道闸，
    // 而不是 RRF 分的比例阈值——RRF 分 = Σ1/(k+rank)，数值被压缩在 1/61 附近，
    // 第 2 名与第 1 名的比值就是 61/62≈0.984，任何 ≤0.98 的比例阈值都等于没设。
    // 名次才有稳定含义，所以默认按名次取前 N（RAG_FUSION_TOP_N）。
    const fusionTopN = envInt('RAG_FUSION_TOP_N', Math.max(topK * 3, 15))
    const fusionRatio = envFloat('RAG_FUSION_MIN_RATIO', 0, 0, 1)
    const vectorMinScore = envFloat(
      'RAG_VECTOR_MIN_SCORE',
      // RAG_MIN_SCORE 是旧版的绝对相似度阈值，保留为别名但语义已变：
      // 它现在只在"精排不可用"这条兜底路径上作为余弦下限生效。
      // 直接忽略它会让"我在 .env 里设了 0.45 却没生效"变成一个查不出的困惑，所以保留别名 + 警告。
      envFloat('RAG_MIN_SCORE', DEFAULT_VECTOR_MIN_SCORE, 0, 1),
      0,
      1
    )

    if (!warnedLegacyMinScore && process.env.RAG_MIN_SCORE) {
      warnedLegacyMinScore = true
      console.warn(
        '[RAG] RAG_MIN_SCORE 已废弃：现在只在精排不可用时作为余弦下限生效，' +
          '推荐改用 RAG_VECTOR_MIN_SCORE（详见 server/services/rag/README.md）'
      )
    }

    threshold = { ratio: fusionRatio, absoluteFloor: vectorMinScore, mode: 'fusion' }

    // 兜底路径上才用余弦绝对下限：精排不可用时，一条"排第一但显然不相关"的片段
    // 也会留在候选里；用余弦分把它挡掉。有精排时不能这么做——
    // 那正是"绝对阈值误杀正确答案"的老问题。
    selected = selectByRelativeThreshold(
      fusedTop.map((hit) => ({ id: hit.id, score: hit.rrfScore, hit })),
      { ratio: fusionRatio, absoluteFloor: 0 }
    )
      .filter((item) => {
        const vectorScore = item.hit.scores.vector
        // 只被词法通道命中的条目没有余弦分，不该用向量下限否掉它
        if (vectorScore === undefined) return true
        return vectorScore >= vectorMinScore
      })
      .slice(0, fusionTopN)
      .map((item) => ({ id: item.id, score: item.hit.rrfScore }))

    if (isRerankEnabled()) {
      degraded.push('精排未生效，本次按融合顺序返回')
    }
  }

  const hits = selected.slice(0, topK)
  baseDebug.selected = hits.length
  // 阈值信息必须回填：否则诊断里恒为初始值，"为什么这条被切掉"就无从查起
  baseDebug.threshold = threshold

  if (hits.length === 0) {
    return {
      content: noHitMessage(trimmedQuery, degraded, scanDimMismatch ?? 0),
      sources: [],
      resultCount: 0,
      debug: baseDebug,
    }
  }

  // ---- 8. 组装给模型的文本 + 给前端的来源 ----
  const fusedById = new Map(fusedTop.map((hit) => [hit.id, hit]))
  const sources: KnowledgeSource[] = []
  const parts: string[] = [`从私有知识库中检索到 ${hits.length} 个相关片段：`]

  hits.forEach((hit, i) => {
    const chunk = byId.get(hit.id)
    if (!chunk) return

    const snippet = chunk.content.slice(0, MAX_SNIPPET_CHARS)
    parts.push(
      `\n[片段 ${i + 1}] 来源：${chunk.documentName}\n${snippet}${
        chunk.content.length > MAX_SNIPPET_CHARS ? '…' : ''
      }`
    )

    const fusedHit = fusedById.get(hit.id)
    sources.push({
      documentName: chunk.documentName,
      chunkIndex: chunk.index,
      score: Number(hit.score.toFixed(4)),
      snippet: chunk.content.slice(0, 120),
      ...(fusedHit ? { channels: fusedHit.channels } : {}),
      ...(fusedHit?.scores.vector !== undefined
        ? { vectorScore: Number(fusedHit.scores.vector.toFixed(4)) }
        : {}),
      ...(fusedHit?.scores.lexical !== undefined
        ? { lexicalScore: Number(fusedHit.scores.lexical.toFixed(4)) }
        : {}),
      ...(baseDebug.rerank.applied ? { rerankScore: Number(hit.score.toFixed(4)) } : {}),
    })
  })

  parts.push(
    '\n请仅依据以上片段回答；若片段不足以回答，请明确说明知识库中没有相关信息。引用时请标注来源文件名。'
  )

  console.log(
    `[RAG] 检索完成: 「${trimmedQuery}」 → 向量 ${vectorHits}（${vectorBackend}）` +
      ` + 词法 ${lexicalHits} → 融合 ${fused.length} → 精排${
        baseDebug.rerank.applied ? '生效' : '降级'
      } → 返回 ${hits.length}`
  )

  return {
    content: parts.join('\n'),
    sources,
    resultCount: hits.length,
    debug: baseDebug,
  }
}

/**
 * 无结果时的提示语
 *
 * 关键是明确要求模型"不要凭常识编造"，并带上降级/维度信息：
 * 用户看到"查不到"时，最需要知道的是"库里确实没有"还是"有但没参与检索"。
 */
function noHitMessage(
  query: string,
  degraded: string[],
  dimMismatchCount: number
): string {
  const notes: string[] = []

  if (dimMismatchCount > 0) {
    notes.push(
      `另有 ${dimMismatchCount} 个片段因向量维度与当前模型不一致被跳过，需要重新入库`
    )
  }
  notes.push(...degraded.slice(0, MAX_DEGRADED_NOTES))

  const extra = notes.length > 0 ? `（${notes.join('；')}）` : ''

  return (
    `未检索到与「${query}」相关的内容${extra}。` +
    `请如实告知用户知识库中没有相关资料，不要凭常识编造答案。`
  )
}

function emptyDebug(): RetrievalDebug {
  return {
    embeddingModel: 'unknown',
    embeddingDim: 0,
    vector: { backend: 'unavailable', hits: 0, legacyModels: [] },
    lexical: { enabled: false, hits: 0, terms: 0 },
    rerank: { enabled: isRerankEnabled(), applied: false, model: '', candidates: 0 },
    fused: 0,
    selected: 0,
    threshold: { ratio: 0, absoluteFloor: 0, mode: 'fusion' },
    degraded: [],
  }
}

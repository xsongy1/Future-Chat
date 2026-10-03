/**
 * 向量通道
 *
 * 两条等价实现，按运行环境自动选择：
 *   1. pgvector（有扩展且维度匹配）—— 余弦距离用 `<=>` 下推给数据库，走 HNSW 索引
 *   2. 应用层精确扫描（没有扩展 / 维度不是 1024 / 灰度期旧模型）—— 分页全量扫描算余弦
 *
 * ## 关于"近似"与召回
 * HNSW 是近似最近邻：ef_search 越大召回越高、越慢，因此它是**召回率旋钮**而不是
 * 正确性开关；再加上 WHERE（知识库/文档状态/模型）过滤是后置的，过滤越狠越可能
 * 凑不满候选数。所以这里做两件事：
 *   - ef_search 可配（RAG_HNSW_EF_SEARCH，默认 100）
 *   - 支持 pgvector 0.8+ 的 hnsw.iterative_scan，让过滤场景下继续扫描直到凑够候选
 * 并在调用方按倍数放宽 KNN 的 limit（见 index.ts 的 vectorCandidates）。
 *
 * ## 关于应用层扫描没有上限截断
 * 早先的实现是 `take: 2000, orderBy: createdAt desc`：先按创建时间取最新 2000 条，
 * 再在应用层算相似度。chunk 一旦超过 2000 条，不在"最新 2000 条"里的正确答案
 * 就永远不可能被召回——创建时间与相关性无关，这是静默的正确性缺陷而不是性能取舍。
 * 现在改为 keyset 分页（id 游标）逐批扫描，召回与语料规模无关；
 * 内存只取决于 batchSize，不取决于总 chunk 数。
 */

import { KnowledgeRepository, type ScoredChunk } from '@/server/repositories/knowledge.repository'

/** pgvector 列固定为 vector(1024)：HNSW 索引要求定长，而白名单里的模型都是 1024 维 */
export const PGVECTOR_DIM = 1024

/** 能力探测结果缓存时长：避免每次检索都查一遍 pg_extension，又能在装完扩展后自动生效 */
const CAPABILITY_TTL_MS = 60_000

export interface VectorCapability {
  /** pgvector 扩展是否可用 */
  available: boolean
  /** 扩展版本（如 0.8.0），未安装为 null */
  version: string | null
  /** 是否支持 hnsw.iterative_scan（0.8+） */
  iterativeScan: boolean
  /** HNSW 索引是否存在（缺了不影响正确性，但向量检索会退化成顺序扫描） */
  hnswIndex: boolean
}

let capabilityCache: { value: VectorCapability; at: number } | null = null

/** 「HNSW 索引缺失」的告警只打一次，否则每次探测都会刷屏 */
let warnedMissingHnsw = false

/**
 * 探测 pgvector 能力
 *
 * @param force - 跳过缓存重新探测（维护脚本/测试用）
 */
export async function detectVectorCapability(force = false): Promise<VectorCapability> {
  const override = process.env.RAG_VECTOR_BACKEND
  if (override === 'app') {
    return { available: false, version: null, iterativeScan: false, hnswIndex: false }
  }

  if (!force && capabilityCache && Date.now() - capabilityCache.at < CAPABILITY_TTL_MS) {
    return capabilityCache.value
  }

  let value: VectorCapability = {
    available: false,
    version: null,
    iterativeScan: false,
    hnswIndex: false,
  }
  try {
    // 用 pg_extension 而不是 pg_available_extensions：后者只说明"能装"，
    // 没装扩展时 vector 类型仍然不存在，写 embeddingVec 会直接报错。
    const { prisma } = await import('@/server/db/client')
    const rows = await prisma.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'
    `
    const version = rows[0]?.extversion ?? null
    if (version) {
      const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10))

      // 顺带确认 HNSW 索引还在。它无法用 Prisma schema 表达，所以 prisma migrate dev
      // 有可能把它 diff 成 DROP INDEX（实测会）。缺索引**不影响正确性**——
      // ORDER BY <=> LIMIT k 会退化成顺序扫描并按精确距离排序，召回反而更全——
      // 但性能会掉一个量级，而且没有任何报错。所以这里显式探测并告警一次，
      // 让"检索突然变慢"能直接定位到原因，而不是变成一个查不出的哑故障。
      const indexRows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'DocumentChunk_embeddingVec_hnsw_idx'
        ) AS exists
      `
      const hnswIndex = indexRows[0]?.exists ?? false
      if (!hnswIndex && !warnedMissingHnsw) {
        warnedMissingHnsw = true
        console.warn(
          '[RAG] 检测到 pgvector 可用但缺少 HNSW 索引（DocumentChunk_embeddingVec_hnsw_idx）：' +
            '向量检索仍返回正确结果，但会退化为顺序扫描（大语料下明显变慢）。' +
            '执行 pnpm rag:indexes 补回索引。'
        )
      }

      value = {
        available: true,
        version,
        iterativeScan: major > 0 || minor >= 8,
        hnswIndex,
      }
    }
  } catch (error) {
    // 探测失败按"不可用"处理：检索会退到精确扫描，仍然能出结果
    console.warn(
      '[RAG] pgvector 能力探测失败，回退到应用层精确扫描:',
      error instanceof Error ? error.message : error
    )
  }

  capabilityCache = { value, at: Date.now() }
  return value
}

/** 清除能力探测缓存（测试/维护用） */
export function resetVectorCapabilityCache(): void {
  capabilityCache = null
}

/** 该维度的向量能否写进 pgvector 列（列是定长 vector(1024)） */
export function isVectorColumnCompatible(dim: number): boolean {
  return dim === PGVECTOR_DIM
}

function resolveEfSearch(): number {
  const raw = process.env.RAG_HNSW_EF_SEARCH
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (Number.isInteger(parsed) && parsed > 0) return parsed
  if (raw) {
    console.warn(`[RAG] RAG_HNSW_EF_SEARCH="${raw}" 不是正整数，使用默认值 100`)
  }
  return 100
}

function resolveIterativeScan(capability: VectorCapability): string | null {
  if (!capability.iterativeScan) return null
  const raw = process.env.RAG_HNSW_ITERATIVE_SCAN
  if (raw === 'off') return null
  if (raw === 'relaxed_order' || raw === 'strict_order') return raw
  if (raw) {
    console.warn(
      `[RAG] RAG_HNSW_ITERATIVE_SCAN="${raw}" 不是 off/relaxed_order/strict_order，使用 relaxed_order`
    )
  }
  // relaxed_order：允许返回顺序与距离不完全一致，换取过滤场景下的召回
  return 'relaxed_order'
}

/** 余弦相似度（应用层扫描用；pgvector 路径由 `<=>` 在 SQL 里算） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * pgvector KNN 检索
 *
 * @returns hits，以及是否因为扩展不可用而没走这条路径（enabled=false）
 */
export async function searchByVector(params: {
  ownedBaseIds: string[]
  queryVector: number[]
  embeddingModel: string
  limit: number
}): Promise<{ enabled: boolean; hits: ScoredChunk[] }> {
  const capability = await detectVectorCapability()
  if (!capability.available || !isVectorColumnCompatible(params.queryVector.length)) {
    return { enabled: false, hits: [] }
  }

  const hits = await KnowledgeRepository.searchChunksByVector({
    ownedBaseIds: params.ownedBaseIds,
    embeddingModel: params.embeddingModel,
    queryVector: params.queryVector,
    limit: params.limit,
    efSearch: resolveEfSearch(),
    iterativeScan: resolveIterativeScan(capability),
  })

  return { enabled: true, hits }
}

export interface ExactScanResult {
  hits: ScoredChunk[]
  /** 实际扫描的 chunk 数 */
  scanned: number
  /** 因维度与查询向量不一致被跳过的数量（换模型后重新入库前会出现） */
  dimMismatch: number
  /** 是否因为 RAG_EXACT_SCAN_MAX_CHUNKS 而提前停止（默认不设上限） */
  truncated: boolean
}

/** 每批扫描条数：决定内存峰值（每条约 8KB 的 1024 维 double 向量） */
const SCAN_BATCH_SIZE = 500

/**
 * 应用层精确扫描：分页取回所有候选，维护有界 top-K
 *
 * 有界 top-K 用插入排序维护（k 很小，通常 40~100），
 * 这样内存是 O(k) 而不是 O(候选总数)，才能做到"不设总量上限"。
 */
export async function exactScanByVector(params: {
  ownedBaseIds: string[]
  queryVector: number[]
  embeddingModel?: string | null
  limit: number
  batchSize?: number
}): Promise<ExactScanResult> {
  const { ownedBaseIds, queryVector, limit } = params
  const batchSize = params.batchSize ?? SCAN_BATCH_SIZE

  const maxChunks = (() => {
    const raw = process.env.RAG_EXACT_SCAN_MAX_CHUNKS
    const parsed = raw ? Number.parseInt(raw, 10) : 0
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
  })()

  const top: ScoredChunk[] = []
  let cursor: string | null = null
  let scanned = 0
  let dimMismatch = 0
  let truncated = false

  for (;;) {
    const remaining = maxChunks > 0 ? maxChunks - scanned : null

    if (remaining !== null && remaining <= 0) {
      // 到达显式上限：用一条探测确认后面是否真的还有数据。
      // 不探测的话，"语料恰好等于上限"会被误报成截断，而误报等于把
      // "召回可能不完整"这个信号变成噪声，久了就没人信了。
      const probe = await KnowledgeRepository.findChunkPageForExactScan({
        ownedBaseIds,
        cursor,
        batchSize: 1,
        embeddingModel: params.embeddingModel,
      })
      truncated = probe.length > 0
      break
    }

    // 本批实际请求的条数：与用于判断"是否取满"的 take 必须是同一个值，
    // 否则夹逼到上限的那一批会被当成"已扫到底"而漏掉截断标记
    const take = remaining === null ? batchSize : Math.min(batchSize, remaining)

    const page = await KnowledgeRepository.findChunkPageForExactScan({
      ownedBaseIds,
      cursor,
      batchSize: take,
      embeddingModel: params.embeddingModel,
    })

    if (page.length === 0) break

    for (const chunk of page) {
      scanned += 1
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== queryVector.length) {
        dimMismatch += 1
        continue
      }
      pushTopK(top, { chunk, score: cosineSimilarity(queryVector, chunk.embedding) }, limit)
    }

    cursor = page[page.length - 1].id

    if (page.length < take) break
  }

  if (truncated) {
    console.warn(
      `[RAG] 精确扫描在 ${scanned} 个 chunk 处被 RAG_EXACT_SCAN_MAX_CHUNKS 截断，` +
        `本次召回可能不完整（去掉该环境变量即可全量扫描）`
    )
  }

  return { hits: top, scanned, dimMismatch, truncated }
}

/** 维护一个按 score 降序的有界数组（k 很小，插入排序比堆更好读也足够快） */
function pushTopK(list: ScoredChunk[], item: ScoredChunk, limit: number): void {
  if (limit <= 0) return

  let index = list.length
  while (index > 0 && list[index - 1].score < item.score) index -= 1
  list.splice(index, 0, item)
  if (list.length > limit) list.pop()
}

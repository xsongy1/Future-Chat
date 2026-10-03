/**
 * RAG 维护操作：存量数据回填、按模型重建、索引修复
 *
 * 这些操作有三个入口，共用同一份实现：
 *   - worker 的 rebuild 任务（正常路径：新模型上线后灰度重建）
 *   - 运维脚本（scripts/rag-*.ts）
 *   - 测试
 *
 * ## 为什么"灰度重建"是 chunk 粒度而不是文档粒度
 * 重建期间检索必须仍然可用。以文档为单位重建时，一个文档要么全是旧向量、
 * 要么全是新向量；以 chunk 为单位时，重建到一半被中断的那批 chunk 只有一部分
 * 换了模型——这没问题，因为检索是按 embeddingModel 分区查两次再融合
 * （见 index.ts 的灰度双模型查询），新旧向量不会互相打分。
 * chunk 粒度的额外好处是中断后续跑不会重复向量化已完成的 chunk（省额度）。
 */

import { embedTexts, resolveEmbeddingDim, resolveEmbeddingModelId, sha256 } from './embedding'
import { toLexemeText, tokenize } from './tokenizer'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { detectVectorCapability, isVectorColumnCompatible } from './vector-store'
import { Prisma } from '@prisma/client'
import { prisma } from '@/server/db/client'

export interface RebuildOutcome {
  targetModel: string
  /** 本次重建的 chunk 数 */
  rebuilt: number
  /** 命中 embedding 缓存、未付费的条数 */
  cacheHits: number
  /** 真正调用 API 的条数 */
  embedded: number
  /** 重建后仍属于旧模型的 chunk 数（>0 说明本次受 limit 限制或还有别的知识库） */
  remaining: number
}

/**
 * 把 chunk 的向量重建为目标模型
 *
 * @param params.batchSize - 每批向量化条数，也就是"灰度粒度"：
 *                           一次处理 32 条，出问题最多影响 32 个片段
 * @param params.maxChunks - 本次最多重建多少条（先用小批量验证新模型效果再全量）
 */
export async function rebuildDocumentEmbeddings(params: {
  userId: string
  apiKey: string
  knowledgeBaseId?: string
  documentId?: string
  targetModel?: string
  batchSize?: number
  maxChunks?: number
  signal?: AbortSignal
  onProgress?: (progress: { rebuilt: number; total: number }) => void | Promise<void>
}): Promise<RebuildOutcome> {
  const targetModel = params.targetModel ?? resolveEmbeddingModelId()
  const targetDim = resolveEmbeddingDim(targetModel)
  const batchSize = params.batchSize ?? 32
  const maxChunks = params.maxChunks ?? 0

  const capability = await detectVectorCapability()
  const writeVector = capability.available && isVectorColumnCompatible(targetDim)

  const ownedBaseIds = await KnowledgeRepository.findOwnedBaseIds(
    params.userId,
    params.knowledgeBaseId ? [params.knowledgeBaseId] : undefined
  )

  let rebuilt = 0
  let cacheHits = 0
  let embedded = 0
  let cursor: string | null = null
  const touchedDocuments = new Set<string>()

  for (;;) {
    params.signal?.throwIfAborted()
    if (maxChunks > 0 && rebuilt >= maxChunks) break

    const page = await KnowledgeRepository.findChunksNeedingRebuild({
      ownedBaseIds,
      targetModel,
      cursor,
      batchSize: Math.min(
        batchSize,
        maxChunks > 0 ? Math.max(1, maxChunks - rebuilt) : batchSize
      ),
      documentId: params.documentId,
    })

    if (page.length === 0) break

    const result = await embedTexts({
      apiKey: params.apiKey,
      texts: page.map((chunk) => chunk.content),
      model: targetModel,
      signal: params.signal,
    })

    await KnowledgeRepository.updateChunkEmbedding(
      page.map((chunk, i) => ({
        id: chunk.id,
        embedding: result.embeddings[i],
        embeddingModel: result.model,
        embeddingDim: result.dim,
      })),
      { writeVector }
    )

    page.forEach((chunk) => touchedDocuments.add(chunk.documentId))
    rebuilt += page.length
    cacheHits += result.cacheHits
    embedded += result.embeddedCount
    cursor = page[page.length - 1].id

    await params.onProgress?.({ rebuilt, total: rebuilt + page.length })

    if (page.length < batchSize) break
  }

  // 整份文档都换完模型的，把文档级标记也更新掉（列表/详情页展示用）
  for (const documentId of touchedDocuments) {
    const left = await KnowledgeRepository.findChunksNeedingRebuild({
      ownedBaseIds,
      targetModel,
      cursor: null,
      batchSize: 1,
      documentId,
    })
    if (left.length === 0) {
      await prisma.knowledgeDocument.updateMany({
        where: { id: documentId },
        data: { embeddingModel: targetModel, embeddingDim: targetDim },
      })
    }
  }

  const remaining = (
    await KnowledgeRepository.findChunksNeedingRebuild({
      ownedBaseIds,
      targetModel,
      cursor: null,
      batchSize: 1000,
      documentId: params.documentId,
    })
  ).length

  console.log(
    `[RAG] 向量重建完成: 目标模型 ${targetModel}，重建 ${rebuilt} 条` +
      `（缓存命中 ${cacheHits}，实际调用 ${embedded}），剩余旧模型 ${remaining} 条`
  )

  return { targetModel, rebuilt, cacheHits, embedded, remaining }
}

export interface BackfillOutcome {
  /** 扫描到的 chunk 数 */
  scanned: number
  /** 补写 tsv/tokenCount 的 chunk 数 */
  lexicallyIndexed: number
  /** 补写 embeddingModel/Dim 的 chunk 数 */
  modelStamped: number
  /** 从 Float[] 复制到 embeddingVec 的 chunk 数 */
  vectorCopied: number
  /** 实际使用的模型标记 */
  assumedModel: string
}

/**
 * 存量数据回填：把 tsv / tokenCount / embeddingModel / embeddingDim / embeddingVec 补齐
 *
 * 这是给迁移前入库的数据用的。两处只能做"假设"的地方必须显式说明：
 *
 * 1. embeddingModel：旧数据没记模型，无法从向量反推。默认按当前 EMBEDDING_MODEL
 *    （即白名单默认的 BAAI/bge-m3）标记——如果历史上换过模型，必须显式传
 *    assumedModel，否则会把旧向量标成新模型，检索出来的分数没有意义。
 * 2. embeddingVec：从 Float[] 用 SQL 直接转换（数组转 vector 字面量），
 *    不经过 JS，避免把 1024 维向量在进程里搬来搬去。
 */
export async function backfillChunkIndexes(
  params: {
    userId?: string
    knowledgeBaseId?: string
    assumedModel?: string
    batchSize?: number
    onProgress?: (progress: { scanned: number; lexicallyIndexed: number }) => void
  } = {}
): Promise<BackfillOutcome> {
  const assumedModel = params.assumedModel ?? resolveEmbeddingModelId()
  const assumedDim = resolveEmbeddingDim(assumedModel)
  const batchSize = params.batchSize ?? 200

  const capability = await detectVectorCapability()

  let scanned = 0
  let lexicallyIndexed = 0
  let cursor: string | null = null

  // 范围条件用 Prisma.sql 片段拼接：$executeRaw / $queryRaw 是标签模板，
  // 直接把另一个 $queryRaw 的调用结果插进去只会插入一个 Promise，不是 SQL。
  const scopeFilter = params.knowledgeBaseId
    ? Prisma.sql`AND d."knowledgeBaseId" = ${params.knowledgeBaseId}`
    : params.userId
      ? Prisma.sql`AND d."knowledgeBaseId" IN (SELECT id FROM "KnowledgeBase" WHERE "userId" = ${params.userId})`
      : Prisma.empty

  // 1. tsv / tokenCount（需要 JS 分词器，逐批处理）
  //
  // 这里必须用 $queryRaw 而不是 Prisma Client：tsv 是 Unsupported 字段，
  // Prisma 的 where/select 里根本不认识它，客户端查询无法按它过滤。
  for (;;) {
    // 显式标注类型而不是依赖 $queryRaw 的泛型推断：
    // page 与 cursor 互相引用（分页游标取自上一页末尾），推断会绕成循环而报 TS7022
    const page: Array<{ id: string; index: number; content: string }> =
      await prisma.$queryRaw`
      SELECT c.id, c."index", c."content"
      FROM "DocumentChunk" c
      JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      WHERE (c."tsv" IS NULL OR c."tokenCount" = 0)
        ${cursor ? Prisma.sql`AND c.id > ${cursor}` : Prisma.empty}
        ${scopeFilter}
      ORDER BY c.id ASC
      LIMIT ${batchSize}
    `

    if (page.length === 0) break

    await KnowledgeRepository.writeChunkIndex(
      page.map((row) => ({
        id: row.id,
        lexemeText: toLexemeText(row.content),
        vectorLiteral: null,
      })),
      { writeVector: false }
    )

    // tokenCount 是普通列，可以走 Prisma（没有批量 update 的 API，逐条 updateMany）
    for (const row of page) {
      await prisma.documentChunk.updateMany({
        where: { id: row.id },
        data: { tokenCount: tokenize(row.content).length },
      })
    }

    scanned += page.length
    lexicallyIndexed += page.length
    cursor = page[page.length - 1].id
    params.onProgress?.({ scanned, lexicallyIndexed })

    if (page.length < batchSize) break
  }

  // 2. embeddingModel / embeddingDim：按维度从 Float[] 推断，
  //    维度与假设模型不符的**不标记**（宁可留空让检索报"未参与"，也不要标错模型）
  const stamped = await prisma.$executeRaw`
    UPDATE "DocumentChunk" AS c
    SET "embeddingModel" = ${assumedModel},
        "embeddingDim" = ${assumedDim}
    WHERE c."embeddingModel" IS NULL
      AND array_length(c."embedding", 1) = ${assumedDim}
      AND EXISTS (
        SELECT 1 FROM "KnowledgeDocument" d
        WHERE d.id = c."documentId"
        ${scopeFilter}
      )
  `

  // 3. embeddingVec：SQL 侧把 float8[] 转成 vector 字面量，不经过 JS
  let vectorCopied = 0
  if (capability.available && isVectorColumnCompatible(assumedDim)) {
    vectorCopied = await prisma.$executeRaw`
      UPDATE "DocumentChunk"
      SET "embeddingVec" = ('[' || array_to_string("embedding", ',') || ']')::vector
      WHERE "embeddingVec" IS NULL
        AND "embedding" IS NOT NULL
        AND array_length("embedding", 1) = ${assumedDim}
    `
  }

  console.log(
    `[RAG] 存量回填完成: 词法索引 ${lexicallyIndexed} 条，模型标记 ${stamped} 条` +
      `（假设为 ${assumedModel}），pgvector 列复制 ${vectorCopied} 条`
  )

  return {
    scanned,
    lexicallyIndexed,
    modelStamped: stamped,
    vectorCopied,
    assumedModel,
  }
}

/**
 * 确保 SQL 侧索引存在（HNSW / GIN / 唯一索引）
 *
 * 存在的理由：HNSW 索引无法在 Prisma schema 里表达，`prisma migrate dev` 生成 diff 时
 * 有可能把它 DROP 掉（Prisma 认为"schema 里没有这个索引"）。这个函数可以在迁移后
 * 一键补回，也可以挂到健康检查里。
 */
export async function ensureVectorIndexes(): Promise<{
  created: string[]
  existing: string[]
  pgvector: boolean
  hnsw: boolean
}> {
  const capability = await detectVectorCapability(true)
  const created: string[] = []
  const existing: string[] = []

  const required: Array<{ name: string; sql: string; needsPgvector: boolean }> = [
    {
      name: 'DocumentChunk_tsv_idx',
      sql: 'CREATE INDEX IF NOT EXISTS "DocumentChunk_tsv_idx" ON "DocumentChunk" USING GIN ("tsv")',
      needsPgvector: false,
    },
    {
      name: 'DocumentChunk_embeddingVec_hnsw_idx',
      sql: 'CREATE INDEX IF NOT EXISTS "DocumentChunk_embeddingVec_hnsw_idx" ON "DocumentChunk" USING hnsw ("embeddingVec" vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
      needsPgvector: true,
    },
  ]

  for (const index of required) {
    if (index.needsPgvector && !capability.available) continue

    const before = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = ${index.name}
      ) AS exists
    `
    if (before[0]?.exists) {
      existing.push(index.name)
      continue
    }

    await prisma.$executeRawUnsafe(index.sql)
    created.push(index.name)
  }

  let hnsw = false
  if (capability.available) {
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'DocumentChunk_embeddingVec_hnsw_idx'
      ) AS exists
    `
    hnsw = rows[0]?.exists ?? false
  }

  return { created, existing, pgvector: capability.available, hnsw }
}

/** 内容哈希缺失的 chunk 补写哈希（历史数据用） */
export async function backfillContentHashes(batchSize = 500): Promise<number> {
  let updated = 0
  let cursor: string | null = null

  for (;;) {
    const page: Array<{ id: string; content: string }> =
      await prisma.documentChunk.findMany({
        where: { ...(cursor ? { id: { gt: cursor } } : {}), contentHash: null },
        select: { id: true, content: true },
        orderBy: { id: 'asc' },
        take: batchSize,
      })
    if (page.length === 0) break

    for (const row of page) {
      await prisma.documentChunk.updateMany({
        where: { id: row.id },
        data: { contentHash: sha256(row.content) },
      })
      updated += 1
    }

    cursor = page[page.length - 1].id
    if (page.length < batchSize) break
  }

  return updated
}

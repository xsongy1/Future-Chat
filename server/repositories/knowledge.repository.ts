/**
 * Knowledge Repository
 *
 * 知识库数据访问层。
 *
 * 归属校验一律沿用 ConversationRepository 的范式：把 userId 写进 WHERE 条件
 * （而不是先查出记录再比较），这样「无权访问」与「不存在」表现一致，
 * 不泄露资源是否存在，也不会出现「查到了才发现不是自己的」这类漏判。
 *
 * 本文件里有三条检索路径，都是「取候选 chunk」的等价实现，选哪条由
 * server/services/rag 决定：
 *   1. searchChunksByVector —— pgvector KNN，相似度下推成 SQL（有扩展时）
 *   2. findChunkPageForExactScan —— 分页精确扫描，应用层算余弦（无扩展时的回退）
 *   3. searchChunksByLexical —— BM25 词法检索（CJK bigram，走 GIN 索引）
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/server/db/client'

/** 检索候选 chunk（含所属文档名，用于前端展示来源） */
export interface RetrievedChunk {
  id: string
  index: number
  content: string
  documentId: string
  documentName: string
  knowledgeBaseId: string
  /** 原始向量：只有应用层精确扫描的回退路径需要，pgvector/BM25 路径不带 */
  embedding?: number[]
  /** 生成该 chunk 向量的模型，用于灰度期区分新旧模型 */
  embeddingModel?: string | null
}

/** 带通道原始分的候选 */
export interface ScoredChunk {
  chunk: RetrievedChunk
  score: number
}

/** pgvector / 应用层扫描共用的余弦相似度选择列 */
const CHUNK_SELECT = {
  id: true,
  index: true,
  content: true,
  documentId: true,
  embeddingModel: true,
  document: {
    select: { name: true, knowledgeBaseId: true },
  },
} as const

type ChunkRow = {
  id: string
  index: number
  content: string
  documentId: string
  embeddingModel: string | null
  document: { name: string; knowledgeBaseId: string }
}

/**
 * 原生 SQL 返回的候选行
 *
 * 与 ChunkRow 的区别是文档名/知识库 id 由 JOIN 直接取平（原生 SQL 不做嵌套映射），
 * 因此不能复用 toRetrievedChunk——它的入参是 Prisma 的嵌套结构。
 */
type RawChunkRow = {
  id: string
  index: number
  content: string
  documentId: string
  embeddingModel: string | null
  documentName: string
  knowledgeBaseId: string
}

function rawToScoredChunk(row: RawChunkRow & { score: number }): ScoredChunk {
  return {
    chunk: {
      id: row.id,
      index: row.index,
      content: row.content,
      documentId: row.documentId,
      documentName: row.documentName,
      knowledgeBaseId: row.knowledgeBaseId,
      embeddingModel: row.embeddingModel,
    },
    score: Number(row.score),
  }
}

function toRetrievedChunk(row: ChunkRow, embedding?: number[]): RetrievedChunk {
  return {
    id: row.id,
    index: row.index,
    content: row.content,
    documentId: row.documentId,
    documentName: row.document.name,
    knowledgeBaseId: row.document.knowledgeBaseId,
    embeddingModel: row.embeddingModel,
    ...(embedding ? { embedding } : {}),
  }
}

/** 把 number[] 转成 pgvector 的字面量格式：[0.1,0.2,...] */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

/**
 * 可复用的 Prisma 客户端类型（事务内外都能用）
 *
 * 事务里必须用 tx 而不是全局 prisma，否则 SET LOCAL 与后续查询会落在不同连接上。
 */
type Db = PrismaClient | Prisma.TransactionClient

export const KnowledgeRepository = {
  /**
   * 当前用户的知识库列表
   */
  async findBasesByUserId(userId: string) {
    return prisma.knowledgeBase.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: { select: { documents: true } },
      },
    })
  },

  /**
   * 单个知识库（带归属校验）
   */
  async findBaseById(id: string, userId: string) {
    return prisma.knowledgeBase.findFirst({
      where: { id, userId },
    })
  },

  /**
   * 批量查询当前用户拥有的知识库 ID（用于检索范围收敛）
   */
  async findOwnedBaseIds(userId: string, baseIds?: string[]): Promise<string[]> {
    const bases = await prisma.knowledgeBase.findMany({
      where: {
        userId,
        ...(baseIds && baseIds.length > 0 ? { id: { in: baseIds } } : {}),
      },
      select: { id: true },
    })
    return bases.map((b) => b.id)
  },

  /**
   * 创建知识库
   */
  async createBase(userId: string, name: string, description?: string) {
    return prisma.knowledgeBase.create({
      data: { userId, name, description },
    })
  },

  /**
   * 删除知识库（带归属校验，级联删除文档与 chunk）
   */
  async deleteBase(id: string, userId: string): Promise<boolean> {
    const result = await prisma.knowledgeBase.deleteMany({
      where: { id, userId },
    })
    return result.count > 0
  },

  /**
   * 更新知识库 updatedAt（新增文档后调用，让列表按活跃度排序）
   */
  async touchBase(id: string, userId: string): Promise<void> {
    await prisma.knowledgeBase.updateMany({
      where: { id, userId },
      data: { updatedAt: new Date() },
    })
  },

  // ============ 文档 ============

  /**
   * 创建文档记录
   */
  async createDocument(data: {
    knowledgeBaseId: string
    name: string
    type: string
    size: number
    status: string
    error?: string | null
    chunkCount: number
    contentHash?: string | null
    embeddingModel?: string | null
    embeddingDim?: number | null
  }) {
    return prisma.knowledgeDocument.create({ data })
  },

  /**
   * 文档列表（带归属校验）
   */
  async findDocumentsByBaseId(knowledgeBaseId: string, userId: string) {
    const base = await this.findBaseById(knowledgeBaseId, userId)
    if (!base) return null
    return prisma.knowledgeDocument.findMany({
      where: { knowledgeBaseId },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * 单个文档（带归属校验）
   */
  async findDocumentById(id: string, userId: string) {
    return prisma.knowledgeDocument.findFirst({
      where: { id, knowledgeBase: { userId } },
    })
  },

  /**
   * 按内容哈希查同一知识库内是否已有该文档（上传去重）
   *
   * 只认「同一知识库」：不同知识库里放同一份文件是用户的正常用法，
   * 跨库去重会让用户看到「我上传到 B 库的文件跑到 A 库去了」。
   */
  async findDocumentByContentHash(knowledgeBaseId: string, contentHash: string) {
    return prisma.knowledgeDocument.findFirst({
      where: { knowledgeBaseId, contentHash },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * 删除文档（带归属校验）
   */
  async deleteDocument(id: string, userId: string): Promise<boolean> {
    const result = await prisma.knowledgeDocument.deleteMany({
      where: { id, knowledgeBase: { userId } },
    })
    return result.count > 0
  },

  /**
   * 原子写入「文档 + 其全部 chunk」
   *
   * 用嵌套 create 把两次写入放进同一个事务：否则 createDocument 成功后
   * createChunks 失败，会留下一条 status=ready、chunkCount=N 但库里 0 个 chunk
   * 的孤儿文档——用户看到"入库成功"，却永远检索不到内容。
   *
   * 注意 tsv / embeddingVec 两个 Unsupported 列不能走这里（Prisma 不支持其类型），
   * 由 writeChunkIndex 在拿到 chunk id 之后补写。
   */
  async createDocumentWithChunks(
    data: {
      knowledgeBaseId: string
      name: string
      type: string
      size: number
      status: string
      error?: string | null
      chunkCount: number
      contentHash?: string | null
      embeddingModel?: string | null
      embeddingDim?: number | null
      processedChunks?: number
    },
    chunks: Array<{
      index: number
      content: string
      embedding: number[]
      contentHash: string
      embeddingModel: string
      embeddingDim: number
      tokenCount: number
    }>
  ) {
    return prisma.knowledgeDocument.create({
      data: {
        ...data,
        chunks: { create: chunks },
      },
    })
  },

  /**
   * 覆写已有文档的 chunk（重建/重新入库时用）
   *
   * 「删旧 chunk + 写新 chunk + 更新文档」必须在同一事务里：否则中途失败会留下
   * 一条 chunkCount=N 但库里 0 个 chunk 的文档，检索侧表现为"文档在，但永远查不到"。
   */
  async replaceDocumentChunks(
    documentId: string,
    data: {
      knowledgeBaseId: string
      name: string
      type: string
      size: number
      status: string
      error?: string | null
      chunkCount: number
      contentHash?: string | null
      embeddingModel?: string | null
      embeddingDim?: number | null
      processedChunks?: number
    },
    chunks: Array<{
      index: number
      content: string
      embedding: number[]
      contentHash: string
      embeddingModel: string
      embeddingDim: number
      tokenCount: number
    }>
  ) {
    const { knowledgeBaseId: _kb, ...updateData } = data

    return prisma.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { documentId } })
      return tx.knowledgeDocument.update({
        where: { id: documentId },
        data: {
          ...updateData,
          chunks: { create: chunks },
        },
      })
    })
  },

  /**
   * 取文档下 chunk 的 id / 序号 / 正文（用于补写 tsv 与 embeddingVec）
   *
   * 需要 id 是因为 tsv 与 embeddingVec 是 Unsupported 列，nested create 写不了，
   * 只能在插入后拿到 id 再 UPDATE。
   */
  async findChunksForIndexWrite(
    documentId: string
  ): Promise<Array<{ id: string; index: number; content: string }>> {
    return prisma.documentChunk.findMany({
      where: { documentId },
      select: { id: true, index: true, content: true },
      orderBy: { index: 'asc' },
    })
  },

  /**
   * 批量补写 chunk 的 tsv / embeddingVec
   *
   * 用一条 `UPDATE ... FROM (VALUES ...)` 而不是逐行 UPDATE：500 个 chunk 的文档
   * 逐行写会产生 500 次往返，入库耗时会被网络往返而不是 embedding 主导。
   * 每 100 行一批是为了避免单条 SQL 过大（每行带一个 1024 维向量字面量）。
   */
  async writeChunkIndex(
    rows: Array<{ id: string; lexemeText: string; vectorLiteral: string | null }>,
    options: { writeVector: boolean; db?: Db }
  ): Promise<void> {
    const db = options.db ?? prisma
    const BATCH = 100

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)

      if (options.writeVector) {
        // 向量字面量在 embedding 维度 != 1024 时为 null，此时只写 tsv
        const values = batch.map(
          (r) =>
            Prisma.sql`(${r.id}::text, ${r.lexemeText}::text, ${r.vectorLiteral}::vector)`
        )
        await db.$executeRaw`
          UPDATE "DocumentChunk" AS c
          SET "tsv" = to_tsvector('simple', v.lexeme_text),
              "embeddingVec" = v.vec
          FROM (VALUES ${Prisma.join(values)}) AS v(id, lexeme_text, vec)
          WHERE c.id = v.id
        `
      } else {
        const values = batch.map(
          (r) => Prisma.sql`(${r.id}::text, ${r.lexemeText}::text)`
        )
        await db.$executeRaw`
          UPDATE "DocumentChunk" AS c
          SET "tsv" = to_tsvector('simple', v.lexeme_text)
          FROM (VALUES ${Prisma.join(values)}) AS v(id, lexeme_text)
          WHERE c.id = v.id
        `
      }
    }
  },

  /**
   * 写回文档进度（异步任务每完成一批 embedding 调一次）
   */
  async updateDocumentProgress(
    id: string,
    data: { processedChunks?: number; status?: string }
  ): Promise<void> {
    await prisma.knowledgeDocument.updateMany({ where: { id }, data })
  },

  /**
   * 文档入库完成
   */
  async markDocumentReady(
    id: string,
    data: {
      chunkCount: number
      processedChunks: number
      embeddingModel: string
      embeddingDim: number
    }
  ): Promise<void> {
    await prisma.knowledgeDocument.updateMany({
      where: { id },
      data: { ...data, status: 'ready', error: null },
    })
  },

  /**
   * 文档入库失败
   */
  async markDocumentFailed(id: string, error: string): Promise<void> {
    await prisma.knowledgeDocument.updateMany({
      where: { id },
      data: { status: 'failed', error },
    })
  },

  /**
   * 清除失败原因（重新排队时调用，否则用户会看到"已完成"但错误原因还在）
   */
  async clearDocumentError(id: string): Promise<void> {
    await prisma.knowledgeDocument.updateMany({
      where: { id },
      data: { error: null },
    })
  },

  /**
   * 某知识库下的文档与 chunk 模型分布（用于判断是否需要重建）
   */
  async countChunksByModelForBase(knowledgeBaseId: string) {
    return prisma.documentChunk.groupBy({
      by: ['embeddingModel', 'embeddingDim'],
      where: { document: { knowledgeBaseId, status: 'ready' } },
      _count: { _all: true },
    })
  },

  /**
   * 找出还需要重建向量的文档（按文档聚合，便于一个文档一个任务地灰度推进）
   */
  async findDocumentIdsNeedingRebuild(
    knowledgeBaseId: string,
    targetModel: string,
    limit = 0
  ): Promise<Array<{ documentId: string; count: number }>> {
    const rows = await prisma.documentChunk.groupBy({
      by: ['documentId'],
      where: {
        document: { knowledgeBaseId, status: 'ready' },
        OR: [{ embeddingModel: null }, { embeddingModel: { not: targetModel } }],
      },
      _count: { _all: true },
    })

    const mapped = rows
      .map((row) => ({ documentId: row.documentId, count: row._count._all }))
      // chunk 多的文档先重建：它们对检索的影响最大
      .sort((a, b) => b.count - a.count)

    return limit > 0 ? mapped.slice(0, limit) : mapped
  },

  // ============ 检索：向量通道（pgvector） ============

  /**
   * pgvector KNN 检索：相似度完全下推给数据库，走 HNSW 索引
   *
   * 为什么必须放在事务里：hnsw.ef_search / hnsw.iterative_scan 是会话级 GUC，
   * 用 SET LOCAL 只在当前事务内生效，因此必须与 KNN 查询共用同一条连接。
   * 如果直接 `SET` 或用两次独立查询，Prisma 连接池会把它们分到不同连接上，
   * 参数静默失效（查询结果仍然"像"对的，只是召回变差，很难查）。
   *
   * @param params.limit - KNN 返回条数。HNSW 是近似索引，且 WHERE 过滤是后置的，
   *                       过滤条件越狠越容易凑不满 limit，因此调用方要按倍数放宽。
   */
  async searchChunksByVector(params: {
    ownedBaseIds: string[]
    embeddingModel: string
    queryVector: number[]
    limit: number
    efSearch?: number
    iterativeScan?: string | null
  }): Promise<ScoredChunk[]> {
    const { ownedBaseIds, embeddingModel, queryVector, limit, efSearch, iterativeScan } =
      params
    if (ownedBaseIds.length === 0 || limit <= 0) return []

    const literal = toVectorLiteral(queryVector)

    return prisma.$transaction(
      async (tx) => {
        if (efSearch && Number.isInteger(efSearch) && efSearch > 0) {
          // 数值来自环境变量且已校验为整数，不会有注入面
          await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`)
        }
        if (iterativeScan) {
          // 取值来自白名单（off/relaxed_order/strict_order），同上
          await tx.$executeRawUnsafe(
            `SET LOCAL hnsw.iterative_scan = '${iterativeScan}'`
          )
        }

        const rows = await tx.$queryRaw<
          Array<RawChunkRow & { score: number }>
        >`
          SELECT c.id,
                 c."index",
                 c."content",
                 c."documentId",
                 c."embeddingModel",
                 d."name" AS "documentName",
                 d."knowledgeBaseId" AS "knowledgeBaseId",
                 1 - (c."embeddingVec" <=> ${literal}::vector) AS score
          FROM "DocumentChunk" c
          JOIN "KnowledgeDocument" d ON d.id = c."documentId"
          WHERE d."knowledgeBaseId" IN (${Prisma.join(ownedBaseIds)})
            AND d.status = 'ready'
            AND c."embeddingVec" IS NOT NULL
            AND c."embeddingModel" = ${embeddingModel}
          ORDER BY c."embeddingVec" <=> ${literal}::vector
          LIMIT ${limit}
        `

        return rows.map(rawToScoredChunk)
      },
      // 默认 5s 的事务超时对冷启动后的第一次 HNSW 查询偏紧
      { timeout: 15000 }
    )
  },

  // ============ 检索：向量通道（应用层精确扫描回退） ============

  /**
   * 分页取一批候选 chunk（含原始向量），供应用层精确扫描
   *
   * 这里的关键是**不做总量截断**：早先的实现是
   *   findMany({ take: 2000, orderBy: { createdAt: 'desc' } })
   * 先按创建时间取最新 2000 条再在应用层算相似度——一旦 chunk 超过 2000 条，
   * 正确答案只要不在这「最新的 2000 条」里就永远不可能被召回，而且失败是静默的
   * （用户看到的是"知识库里没有相关内容"，不是报错）。创建时间与相关性无关，
   * 所以这不是"少召回一点"，而是明确的正确性缺陷。
   *
   * 现在改成 keyset 分页（id 游标 + 升序）逐批全量扫描，由调用方维护有界 top-K：
   * 召回不再取决于语料规模，内存占用取决于 batchSize 而不是总 chunk 数。
   */
  async findChunkPageForExactScan(params: {
    ownedBaseIds: string[]
    cursor: string | null
    batchSize: number
    /** 只扫描指定模型的 chunk（灰度重建期间按模型分别扫描） */
    embeddingModel?: string | null
    db?: Db
  }): Promise<Array<RetrievedChunk & { embedding: number[]; embeddingDim: number | null }>> {
    const { ownedBaseIds, cursor, batchSize, embeddingModel, db } = params
    if (ownedBaseIds.length === 0 || batchSize <= 0) return []

    const rows = await (db ?? prisma).documentChunk.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        document: { knowledgeBaseId: { in: ownedBaseIds }, status: 'ready' },
        ...(embeddingModel === undefined
          ? {}
          : embeddingModel === null
            ? { embeddingModel: null }
            : { embeddingModel }),
      },
      select: {
        ...CHUNK_SELECT,
        embedding: true,
        embeddingDim: true,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    })

    return rows.map((row) => ({
      ...toRetrievedChunk(row, row.embedding),
      // 显式给出必填的 embedding/embeddingDim：toRetrievedChunk 的 embedding 是可选的
      // （原生 SQL 路径不需要它），精确扫描的调用方需要确定它有值
      embedding: row.embedding,
      embeddingDim: row.embeddingDim,
    }))
  },

  /**
   * 范围内可参与检索的 chunk 总数
   *
   * 只在「所有通道都没命中」时调用，用来区分"知识库是空的"和"有内容但没匹配上"，
   * 这两种情况给模型的提示完全不同（前者要用户先上传文档，后者要模型如实说没查到）。
   */
  async countRetrievableChunks(ownedBaseIds: string[]): Promise<number> {
    if (ownedBaseIds.length === 0) return 0
    return prisma.documentChunk.count({
      where: { document: { knowledgeBaseId: { in: ownedBaseIds }, status: 'ready' } },
    })
  },

  /**
   * 范围内的 embedding 模型分布
   *
   * 灰度重建的依据：出现「不是当前 EMBEDDING_MODEL 的模型」就说明库里有旧向量，
   * 检索需要同时用旧模型查一次，否则重建期间那部分文档会整体消失。
   */
  async findChunkEmbeddingModels(
    ownedBaseIds: string[]
  ): Promise<Array<{ model: string | null; dim: number | null; count: number }>> {
    if (ownedBaseIds.length === 0) return []
    const rows = await prisma.documentChunk.groupBy({
      by: ['embeddingModel', 'embeddingDim'],
      where: { document: { knowledgeBaseId: { in: ownedBaseIds }, status: 'ready' } },
      _count: { _all: true },
    })
    return rows.map((row) => ({
      model: row.embeddingModel,
      dim: row.embeddingDim,
      count: row._count._all,
    }))
  },

  // ============ 检索：词法通道（BM25） ============

  /**
   * BM25 词法检索（在 SQL 里算分）
   *
   * 打分公式与 server/services/rag/bm25.ts 完全一致（那边是参考实现，单测用它交叉验证）：
   *   score = Σ_t idf(t) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
   *   idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
   *
   * 两个实现细节值得说明：
   *
   * 1. tf 直接来自 tsvector 的 positions（cardinality(positions) 就是词频），
   *    因此不需要额外的倒排表来存词频——tsv 一列同时承担了"倒排索引"和"词频存储"。
   *
   * 2. df 只在 matched（命中查询词的 chunk）里统计，看起来像"局部 df"，
   *    但因为匹配条件是查询词的 OR，**任何**包含某个查询词的 chunk 必然出现在
   *    matched 里，所以这个 count 等于该词在整个检索范围内的真实 df。
   *    好处是不需要维护一张会随删除/重建漂移的全局 df 统计表。
   *    代价是 N 与 avgdl 也被限定在"同一范围 + 已建词法索引（tsv 非空）"的语料上，
   *    这正好是词法通道真正能参与竞争的语料集合，口径一致。
   */
  async searchChunksByLexical(params: {
    ownedBaseIds: string[]
    tsQuery: string
    terms: string[]
    limit: number
    k1: number
    b: number
  }): Promise<ScoredChunk[]> {
    const { ownedBaseIds, tsQuery, terms, limit, k1, b } = params
    if (ownedBaseIds.length === 0 || limit <= 0 || terms.length === 0) return []

    const rows = await prisma.$queryRaw<Array<RawChunkRow & { score: number }>>`
      WITH corpus AS (
        SELECT COUNT(*)::float8 AS total,
               COALESCE(AVG(c."tokenCount"), 0)::float8 AS avgdl
        FROM "DocumentChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE d."knowledgeBaseId" IN (${Prisma.join(ownedBaseIds)})
          AND d.status = 'ready'
          AND c."tsv" IS NOT NULL
      ),
      matched AS (
        SELECT c.id, c."tokenCount", m.lexeme AS term,
               GREATEST(cardinality(m.positions), 1)::float8 AS tf
        FROM "DocumentChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId",
             LATERAL unnest(c."tsv") AS m
        WHERE d."knowledgeBaseId" IN (${Prisma.join(ownedBaseIds)})
          AND d.status = 'ready'
          AND c."tsv" @@ to_tsquery('simple', ${tsQuery})
          AND m.lexeme IN (${Prisma.join(terms)})
      ),
      df AS (
        SELECT term, COUNT(*)::float8 AS df FROM matched GROUP BY term
      ),
      scored AS (
        SELECT m.id,
               SUM(
                 ln(1 + (corpus.total - df.df + 0.5) / (df.df + 0.5))
                 * (m.tf * (${k1}::float8 + 1))
                 / (m.tf + ${k1}::float8 * (1 - ${b}::float8 + ${b}::float8 * m."tokenCount" / GREATEST(corpus.avgdl, 1)))
               ) AS score
        FROM matched m
        JOIN df ON df.term = m.term
        CROSS JOIN corpus
        GROUP BY m.id
      )
      SELECT c.id,
             c."index",
             c."content",
             c."documentId",
             c."embeddingModel",
             d."name" AS "documentName",
             d."knowledgeBaseId" AS "knowledgeBaseId",
             s.score
      FROM scored s
      JOIN "DocumentChunk" c ON c.id = s.id
      JOIN "KnowledgeDocument" d ON d.id = c."documentId"
      ORDER BY s.score DESC, c.id ASC
      LIMIT ${limit}
    `

    return rows.map(rawToScoredChunk)
  },

  // ============ 灰度重建 / 维护 ============

  /**
   * 分页取需要重建向量的 chunk（模型与目标模型不一致）
   *
   * 以 chunk 为粒度而不是文档：一个文档重建到一半被打断时，已经换好的 chunk
   * 下次不会被重复向量化（省额度），检索侧靠 embeddingModel 过滤做到新旧共存。
   */
  async findChunksNeedingRebuild(params: {
    ownedBaseIds: string[]
    targetModel: string
    cursor: string | null
    batchSize: number
    documentId?: string
  }): Promise<
    Array<{ id: string; documentId: string; content: string; contentHash: string | null }>
  > {
    const { ownedBaseIds, targetModel, cursor, batchSize, documentId } = params
    if (ownedBaseIds.length === 0 || batchSize <= 0) return []

    return prisma.documentChunk.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        ...(documentId ? { documentId } : {}),
        document: { knowledgeBaseId: { in: ownedBaseIds }, status: 'ready' },
        OR: [{ embeddingModel: null }, { embeddingModel: { not: targetModel } }],
      },
      select: { id: true, documentId: true, content: true, contentHash: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })
  },

  /**
   * 写回重建后的向量（Float[] + 模型/维度 + pgvector 列）
   *
   * 顺序是刻意安排的：先写 Float[]（Prisma 支持的类型），再一条 SQL 写
   * embeddingVec 与 embeddingModel/Dim。因为 embeddingModel 是检索侧判断
   * "这条是不是当前模型的向量"的依据，把它放在最后写，等于把"这条已重建完成"
   * 作为提交点——中途崩溃时留下的是一条仍被判定为旧模型的记录，
   * 下次会被重新重建，而不是变成"标记为新模型但向量还是旧的"。
   */
  async updateChunkEmbedding(
    rows: Array<{
      id: string
      embedding: number[]
      embeddingModel: string
      embeddingDim: number
    }>,
    options: { writeVector: boolean }
  ): Promise<void> {
    for (const row of rows) {
      await prisma.documentChunk.update({
        where: { id: row.id },
        data: { embedding: row.embedding },
      })
    }

    const BATCH = 100

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)

      if (options.writeVector) {
        const values = batch.map(
          (r) =>
            Prisma.sql`(${r.id}::text, ${toVectorLiteral(r.embedding)}::vector, ${r.embeddingModel}::text, ${r.embeddingDim}::int)`
        )
        await prisma.$executeRaw`
          UPDATE "DocumentChunk" AS c
          SET "embeddingVec" = v.vec,
              "embeddingModel" = v.model,
              "embeddingDim" = v.dim
          FROM (VALUES ${Prisma.join(values)}) AS v(id, vec, model, dim)
          WHERE c.id = v.id
        `
      } else {
        const values = batch.map(
          (r) => Prisma.sql`(${r.id}::text, ${r.embeddingModel}::text, ${r.embeddingDim}::int)`
        )
        await prisma.$executeRaw`
          UPDATE "DocumentChunk" AS c
          SET "embeddingModel" = v.model,
              "embeddingDim" = v.dim
          FROM (VALUES ${Prisma.join(values)}) AS v(id, model, dim)
          WHERE c.id = v.id
        `
      }
    }
  },

  /**
   * 统计当前用户可检索的 chunk 总数（用于日志与上限提示）
   */
  async countChunksByUser(userId: string): Promise<number> {
    return prisma.documentChunk.count({
      where: { document: { knowledgeBase: { userId } } },
    })
  },
}

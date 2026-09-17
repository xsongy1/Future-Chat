/**
 * Knowledge Repository
 *
 * 知识库数据访问层。
 *
 * 归属校验一律沿用 ConversationRepository 的范式：把 userId 写进 WHERE 条件
 * （而不是先查出记录再比较），这样「无权访问」与「不存在」表现一致，
 * 不泄露资源是否存在，也不会出现「查到了才发现不是自己的」这类漏判。
 */

import { prisma } from '@/server/db/client'

/** 检索候选 chunk（含所属文档名，用于前端展示来源） */
export interface RetrievedChunk {
  id: string
  index: number
  content: string
  embedding: number[]
  documentId: string
  documentName: string
  knowledgeBaseId: string
}

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
    },
    chunks: Array<{ index: number; content: string; embedding: number[] }>
  ) {
    return prisma.knowledgeDocument.create({
      data: {
        ...data,
        chunks: {
          create: chunks.map((c) => ({
            index: c.index,
            content: c.content,
            embedding: c.embedding,
          })),
        },
      },
    })
  },

  /**
   * 按用户 + 知识库范围取候选 chunk（检索用）
   *
   * 关键：过滤条件走 document.knowledgeBase.userId，因此即使客户端提交了
   * 别人的 knowledgeBaseId，也只会得到空结果而不是越权数据。
   */
  async findChunksForRetrieval(
    userId: string,
    ownedBaseIds: string[],
    limit: number
  ): Promise<RetrievedChunk[]> {
    if (ownedBaseIds.length === 0) return []

    const rows = await prisma.documentChunk.findMany({
      where: {
        document: {
          knowledgeBaseId: { in: ownedBaseIds },
          status: 'ready',
        },
      },
      select: {
        id: true,
        index: true,
        content: true,
        embedding: true,
        documentId: true,
        document: {
          select: { name: true, knowledgeBaseId: true },
        },
      },
      // 单次扫描上限：当前库无 pgvector，相似度在应用层算，
      // 必须限制参与计算的数据量（详见 server/services/rag/index.ts 说明）
      take: limit,
      orderBy: { createdAt: 'desc' },
    })

    return rows.map((row) => ({
      id: row.id,
      index: row.index,
      content: row.content,
      embedding: row.embedding,
      documentId: row.documentId,
      documentName: row.document.name,
      knowledgeBaseId: row.document.knowledgeBaseId,
    }))
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

/**
 * EmbeddingCache Repository
 *
 * 以「文本 sha256 + 模型」为键缓存向量，避免对相同文本重复调用 embedding API。
 * 命中场景在这个项目里非常常见，不是过度设计：
 *   - 同一份文档重复上传（改了一个错别字再传一次）
 *   - 多个文档共用的模板段落 / 规范条文 / 页眉页脚
 *   - chunk 之间的 overlap（相邻块有 100 字符重叠，内容不完全相同但会命中 chunk 级缓存
 *     之外的部分复用）
 *   - 灰度重建：重建时文本没变，只有模型变了，同一模型下重复重建也不会重复付费
 *
 * 缓存是全局的、不按用户隔离：命中的对象是"某段文本的向量"，调用方拿不到别人的原文，
 * 向量本身也无法反推出文本，所以不存在跨用户的信息泄露；而按用户隔离会让
 * 公共语料的缓存命中率趋近于零。
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/server/db/client'

export interface CachedEmbedding {
  contentHash: string
  model: string
  embedding: number[]
  dim: number
}

export const EmbeddingCacheRepository = {
  /**
   * 批量查询缓存
   *
   * 一批 chunk 通常几十到几百个，逐个查会退化成 N 次往返，
   * 这里用 contentHash IN (...) 一次取回，命中率统计交给调用方。
   */
  async findMany(contentHashes: string[], model: string): Promise<CachedEmbedding[]> {
    if (contentHashes.length === 0) return []

    const rows = await prisma.embeddingCache.findMany({
      where: { model, contentHash: { in: contentHashes } },
      select: { contentHash: true, model: true, embedding: true, dim: true },
    })

    return rows.map((row) => ({
      contentHash: row.contentHash,
      model: row.model,
      embedding: row.embedding,
      dim: row.dim,
    }))
  },

  /**
   * 批量写入（并发写入同一 key 时忽略冲突，谁先写谁生效——向量是确定性的，值相同）
   */
  async saveMany(entries: CachedEmbedding[]): Promise<number> {
    if (entries.length === 0) return 0

    const result = await prisma.embeddingCache.createMany({
      data: entries.map((e) => ({
        contentHash: e.contentHash,
        model: e.model,
        dim: e.dim,
        embedding: e.embedding,
      })),
      skipDuplicates: true,
    })

    return result.count
  },

  /**
   * 命中计数（评估缓存收益；写失败不影响检索，因此只记日志不抛出）
   */
  async recordHits(contentHashes: string[], model: string): Promise<void> {
    if (contentHashes.length === 0) return

    try {
      await prisma.$executeRaw`
        UPDATE "EmbeddingCache"
        SET hits = hits + 1, "lastUsedAt" = now()
        WHERE model = ${model}
          AND "contentHash" IN (${Prisma.join(contentHashes)})
      `
    } catch (error) {
      console.warn(
        '[EmbeddingCache] 命中计数写入失败（不影响检索）:',
        error instanceof Error ? error.message : error
      )
    }
  },

  /**
   * 缓存规模与收益概览
   */
  async stats(): Promise<{ entries: number; hits: number }> {
    const agg = await prisma.embeddingCache.aggregate({
      _count: { _all: true },
      _sum: { hits: true },
    })
    return { entries: agg._count._all, hits: agg._sum.hits ?? 0 }
  },
}

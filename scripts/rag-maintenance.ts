/**
 * RAG 运维脚本：存量回填、按模型重建、索引修复、状态自查
 *
 * 用法（在项目根目录）：
 *   pnpm rag:status                        # pgvector/索引/队列/缓存/模型分布 一览
 *   pnpm rag:indexes                       # 补回 HNSW / GIN 索引（迁移后自检）
 *   pnpm rag:backfill                      # 存量数据补齐 tsv/模型标记/embeddingVec
 *   pnpm rag:backfill -- --model=BAAI/bge-m3 --base=<knowledgeBaseId>
 *   pnpm rag:rebuild -- --user=<userId|username> [--base=<id>] [--max-chunks=200]
 *   pnpm rag:reindex-lexical               # 只重建词法索引（换分词策略后用）
 *
 * 为什么需要 backfill：迁移前的 chunk 没有 tsv / embeddingModel / embeddingVec，
 * 它们在检索里既不参与向量通道也不参与词法通道（等于查不到），
 * 迁移后必须跑一次补齐。
 */

import { prisma } from '../server/db/client'
import { UserRepository } from '../server/repositories/user.repository'
import { RagTaskRepository } from '../server/repositories/rag-task.repository'
import { EmbeddingCacheRepository } from '../server/repositories/embedding-cache.repository'
import { KnowledgeRepository } from '../server/repositories/knowledge.repository'
import { resolveEmbeddingModelId } from '../server/services/rag/embedding'
import {
  backfillChunkIndexes,
  backfillContentHashes,
  ensureVectorIndexes,
  rebuildDocumentEmbeddings,
} from '../server/services/rag/maintenance'
import { detectVectorCapability } from '../server/services/rag/vector-store'

/** 解析 `--key=value` 形式的参数 */
function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

async function status(): Promise<void> {
  const capability = await detectVectorCapability(true)
  const indexes = await ensureVectorIndexes()
  const queue = await RagTaskRepository.stats()
  const cache = await EmbeddingCacheRepository.stats()

  const chunkStats = await prisma.$queryRaw<
    Array<{
      total: number
      with_tsv: number
      with_model: number
      with_vec: number
      with_hash: number
    }>
  >`
    SELECT count(*)::int AS total,
           count("tsv")::int AS with_tsv,
           count("embeddingModel")::int AS with_model,
           count("embeddingVec")::int AS with_vec,
           count("contentHash")::int AS with_hash
    FROM "DocumentChunk"
  `

  const models = await prisma.documentChunk.groupBy({
    by: ['embeddingModel', 'embeddingDim'],
    _count: { _all: true },
  })

  let activeModel = '(无法解析)'
  try {
    activeModel = resolveEmbeddingModelId()
  } catch (error) {
    activeModel = error instanceof Error ? error.message : String(error)
  }

  console.log('===== RAG 状态 =====')
  console.log('当前 embedding 模型:', activeModel)
  console.log(
    'pgvector:',
    capability.available ? `可用（${capability.version}，iterative_scan=${capability.iterativeScan}）` : '不可用（将回退到应用层精确扫描）'
  )
  console.log('索引:', {
    created: indexes.created,
    existing: indexes.existing,
    hnsw: indexes.hnsw,
  })
  console.log('chunk 统计:', chunkStats[0])
  console.log(
    '模型分布:',
    models.map((m) => `${m.embeddingModel ?? '(未标注)'}/${m.embeddingDim ?? '-'}维 → ${m._count._all}`)
  )
  const stale = models
    .filter((m) => m.embeddingModel !== activeModel)
    .reduce((sum, m) => sum + m._count._all, 0)
  console.log(`需要重建的 chunk: ${stale}${stale > 0 ? '（执行 pnpm rag:rebuild 灰度重建）' : ''}`)
  console.log('任务队列:', queue)
  console.log('embedding 缓存:', cache)

  const missing = chunkStats[0]
  if (missing && missing.with_tsv < missing.total) {
    console.log(
      `⚠️ 有 ${missing.total - missing.with_tsv} 个 chunk 没有词法索引（tsv），它们查不到；执行 pnpm rag:backfill`
    )
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status'

  switch (command) {
    case 'status': {
      await status()
      break
    }

    case 'indexes': {
      console.log(JSON.stringify(await ensureVectorIndexes(), null, 2))
      break
    }

    case 'backfill': {
      console.log('内容哈希:', await backfillContentHashes())
      const outcome = await backfillChunkIndexes({
        assumedModel: arg('model'),
        knowledgeBaseId: arg('base'),
        userId: arg('user'),
      })
      console.log(JSON.stringify(outcome, null, 2))
      break
    }

    case 'reindex-lexical': {
      // 只重建词法索引：把 tokenCount 归零即可让 backfill 重新挑选出这些 chunk
      await prisma.$executeRaw`UPDATE "DocumentChunk" SET "tsv" = NULL, "tokenCount" = 0`
      const outcome = await backfillChunkIndexes({
        assumedModel: arg('model'),
        knowledgeBaseId: arg('base'),
        userId: arg('user'),
      })
      console.log(JSON.stringify(outcome, null, 2))
      break
    }

    case 'rebuild': {
      const userArg = arg('user')
      if (!userArg) {
        throw new Error('缺少 --user=<userId 或 username>')
      }

      const user =
        (await UserRepository.findById(userArg)) ??
        (await UserRepository.findByUsername(userArg))
      if (!user) throw new Error(`找不到用户：${userArg}`)

      const apiKey = user.apiKey || process.env.SILICONFLOW_API_KEY
      if (!apiKey) throw new Error('没有可用的 API Key（用户未配置，环境变量也没有）')

      const maxChunks = arg('max-chunks') ? Number(arg('max-chunks')) : undefined
      const targetModel = arg('model')

      // 灰度：默认只重建 200 条，先确认新模型效果，再跑全量
      const outcome = await rebuildDocumentEmbeddings({
        userId: user.id,
        apiKey,
        knowledgeBaseId: arg('base'),
        targetModel,
        maxChunks: maxChunks ?? 200,
        onProgress: ({ rebuilt }) => {
          if (rebuilt % 100 === 0) console.log(`  已重建 ${rebuilt} 条…`)
        },
      })
      console.log(JSON.stringify(outcome, null, 2))

      if (outcome.remaining > 0) {
        console.log(
          `\n还有 ${outcome.remaining} 条待重建。确认新模型效果后可用 ` +
            `--max-chunks=100000 跑全量（重建期间新旧模型都参与检索，不会中断服务）。`
        )
      }
      break
    }

    case 'documents': {
      // 列出某知识库下的文档与模型分布（排查"为什么这份文档查不到"）
      const base = arg('base')
      if (!base) throw new Error('缺少 --base=<knowledgeBaseId>')
      const docs = await prisma.knowledgeDocument.findMany({
        where: { knowledgeBaseId: base },
        orderBy: { createdAt: 'desc' },
      })
      for (const doc of docs) {
        // tsv 是 Unsupported 字段，Prisma 的 count/where 里不认识它，只能走原生 SQL
        const stats = await prisma.$queryRaw<Array<{ total: number; indexed: number }>>`
          SELECT count(*)::int AS total, count("tsv")::int AS indexed
          FROM "DocumentChunk" WHERE "documentId" = ${doc.id}
        `
        const { total = 0, indexed = 0 } = stats[0] ?? {}
        console.log(
          `${doc.name}  status=${doc.status}  chunkCount=${doc.chunkCount}  ` +
            `model=${doc.embeddingModel ?? '-'}  实际 chunk=${total}（已建词法索引 ${indexed}）` +
            `${doc.error ? `  error=${doc.error.slice(0, 120)}` : ''}`
        )
      }
      break
    }

    default: {
      console.log(
        '可用命令：status | indexes | backfill | rebuild | reindex-lexical | documents'
      )
      const chunkCount = await KnowledgeRepository.countChunksByUser(
        (await prisma.user.findFirst({ select: { id: true } }))?.id ?? ''
      )
      console.log('（提示）当前首个用户可检索 chunk 数:', chunkCount)
    }
  }
}

main()
  .catch((error) => {
    console.error('[rag] 执行失败:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

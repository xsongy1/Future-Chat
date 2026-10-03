/**
 * RAG 数据库集成测试（默认跳过）
 *
 * 跑法（需要真实数据库；会在库里创建临时知识库并在结束时删除）：
 *   RAG_DB_TEST=1 pnpm test
 *
 * 为什么这些用例必须落到数据库上：它们验证的正是"应用层逻辑无法自证"的部分——
 * 分页游标有没有漏数据、pgvector 的 `<=>` 与 HNSW 召回、BM25 的 SQL 打分、
 * 队列表的 SKIP LOCKED 领取语义。用 mock 测这些等于什么都没测。
 *
 * 回归的核心是第一个用例：旧实现 `take: 2000, orderBy: createdAt desc`
 * 在语料超过 2000 条时会静默漏掉正确答案，这里用一个 2501 条的语料把
 * 「旧查询模式漏、新扫描不漏」这个对比固化成断言。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '@/server/db/client'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { RagTaskRepository } from '@/server/repositories/rag-task.repository'
import { backfillChunkIndexes } from '@/server/services/rag/maintenance'
import { exactScanByVector, detectVectorCapability } from '@/server/services/rag/vector-store'
import { searchByLexical } from '@/server/services/rag/lexical'
import { sha256 } from '@/server/services/rag/embedding'
import { queryTerms, tokenize, toLexemeText } from '@/server/services/rag/tokenizer'

const ENABLED = process.env.RAG_DB_TEST === '1'
const DIM = 1024
const FILLER_COUNT = 2400 // +1 needle = 2401 条，刚好越过 2000 上限
const ACTIVE_MODEL = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
const NEEDLE_TEXT = '关键片段：本项目的内部代号是 ZX-9911，口令是麒麟九号。'

/**
 * e_i：与查询向量 e0 正交的基向量，用于构造"唯一的正确答案"
 *
 * 填充向量刻意从 e1 开始、且只在 1..1023 之间循环（`% (DIM - 1)`）：
 * 若用 `% DIM`，第 1023、2047 条填充会绕回 e0，与 needle 的距离完全相同（score=1），
 * KNN 在并列时的返回顺序是没有保证的——测试会随数据量"偶发失败"。
 */
function basisVector(index: number): number[] {
  const v = new Array(DIM).fill(0)
  v[index] = 1
  return v
}

function fillerVector(i: number): number[] {
  return basisVector(1 + ((i + 1) % (DIM - 1)))
}

const QUERY_VECTOR = basisVector(0)

/**
 * BM25 参考实现（测试专用 oracle）
 *
 * 生产路径的 BM25 打分在 SQL 里（手写聚合，公式容易写错，而且没有数据库跑不了单测）。
 * 所以这里用同一公式在应用层再实现一遍：把数据库里**真实的** tf / df / N / avgdl 喂进去，
 * 断言 SQL 算出来的分数与它逐位一致——公式改写、常量漂移、聚合写错都会被抓住。
 *
 * 这段原本放在 server/services/rag/bm25.ts，但那里只被自己的单测引用，
 * 真正该被验证的 SQL 反而没有验证（24 个用例全绿也不能说明线上的分数是对的）。
 * 搬到测试里之后它才真正承担起"参考答案"的职责。
 */
const BM25_K1 = 1.2
const BM25_B = 0.75

function bm25Idf(df: number, total: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5))
}

function bm25Expected(params: {
  tf: number
  df: number
  total: number
  docLength: number
  avgDocLength: number
}): number {
  const { tf, df, total, docLength, avgDocLength } = params
  const lengthRatio = avgDocLength > 0 ? docLength / avgDocLength : 1
  return (
    (bm25Idf(df, total) * (tf * (BM25_K1 + 1))) /
    (tf + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio))
  )
}

const QUERY = '麒麟九号是什么？'

describe.runIf(ENABLED)('RAG 索引与检索（数据库集成）', () => {
  let userId = ''
  let baseId = ''
  let documentId = ''
  let needleId = ''

  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('数据库里没有用户，无法建立测试归属')
    userId = user.id

    const base = await KnowledgeRepository.createBase(userId, '__RAG_INTEGRATION_TEST__')
    baseId = base.id

    const document = await prisma.knowledgeDocument.create({
      data: {
        knowledgeBaseId: baseId,
        name: 'needle.md',
        type: 'md',
        size: NEEDLE_TEXT.length,
        status: 'ready',
        chunkCount: FILLER_COUNT + 1,
        embeddingModel: ACTIVE_MODEL,
        embeddingDim: DIM,
      },
    })
    documentId = document.id

    // needle 先插入 → createdAt 最早，正好是旧实现会丢掉的那一条
    const needle = await prisma.documentChunk.create({
      data: {
        documentId,
        index: 0,
        content: NEEDLE_TEXT,
        contentHash: sha256(NEEDLE_TEXT),
        embedding: basisVector(0),
        embeddingModel: ACTIVE_MODEL,
        embeddingDim: DIM,
        tokenCount: tokenize(NEEDLE_TEXT).length,
      },
    })
    needleId = needle.id

    const filler = Array.from({ length: FILLER_COUNT }, (_, i) => {
      const content = `填充段落 ${i}：这是一段与目标问题完全无关的占位文本。`
      return {
        documentId,
        index: i + 1,
        content,
        contentHash: sha256(`${content}#${i}`),
        embedding: fillerVector(i),
        embeddingModel: ACTIVE_MODEL,
        embeddingDim: DIM,
        tokenCount: tokenize(content).length,
      }
    })

    for (let i = 0; i < filler.length; i += 500) {
      await prisma.documentChunk.createMany({ data: filler.slice(i, i + 500) })
    }

    // 复用生产回填代码补 tsv / embeddingVec：顺带验证回填本身可用
    const outcome = await backfillChunkIndexes({ knowledgeBaseId: baseId })
    expect(outcome.lexicallyIndexed).toBe(FILLER_COUNT + 1)
  }, 180_000)

  afterAll(async () => {
    if (baseId) await prisma.knowledgeBase.deleteMany({ where: { id: baseId } })
    await prisma.$disconnect()
  })

  it('旧实现（take 2000 + createdAt desc）确实会漏掉正确答案', async () => {
    const candidates = await prisma.documentChunk.findMany({
      where: { document: { knowledgeBaseId: { in: [baseId] }, status: 'ready' } },
      select: { id: true },
      take: 2000,
      orderBy: { createdAt: 'desc' },
    })

    expect(candidates).toHaveLength(2000)
    expect(candidates.some((c) => c.id === needleId)).toBe(false)
  }, 30_000)

  it('分页精确扫描覆盖全部 chunk，并把 needle 排第一', async () => {
    const result = await exactScanByVector({
      ownedBaseIds: [baseId],
      queryVector: QUERY_VECTOR,
      embeddingModel: ACTIVE_MODEL,
      limit: 5,
    })

    expect(result.scanned).toBe(FILLER_COUNT + 1)
    expect(result.truncated).toBe(false)
    expect(result.hits[0]?.chunk.id).toBe(needleId)
    expect(result.hits[0]?.score).toBeCloseTo(1, 5)
    // 显式超时：这一步要把 2401×1024 维向量分页取回应用层算余弦，
    // 容器里跨网络读库时会超过 vitest 默认的 5 秒（实测本机 2.7s、容器内 >5s）。
    // 这是回退路径的固有成本，也正是"有 pgvector 时走 SQL"的意义所在。
  }, 60_000)

  it('pgvector KNN 命中 needle（有扩展时）', async () => {
    const capability = await detectVectorCapability(true)
    if (!capability.available) {
      console.warn('[RAG 集成测试] 无 pgvector，跳过 KNN 用例')
      return
    }

    const hits = await KnowledgeRepository.searchChunksByVector({
      ownedBaseIds: [baseId],
      embeddingModel: ACTIVE_MODEL,
      queryVector: QUERY_VECTOR,
      limit: 5,
      efSearch: 100,
      iterativeScan: capability.iterativeScan ? 'relaxed_order' : null,
    })

    expect(hits[0]?.chunk.id).toBe(needleId)
    expect(hits[0]?.score).toBeCloseTo(1, 5)
  }, 30_000)

  it('BM25 在 2000+ 无关语料中把唯一字面命中的片段排第一', async () => {
    const result = await searchByLexical({
      ownedBaseIds: [baseId],
      query: QUERY,
      limit: 5,
    })

    expect(result.enabled).toBe(true)
    expect(result.terms).toContain('麒麟')
    expect(result.hits[0]?.chunk.id).toBe(needleId)
    expect(result.hits[0]?.score).toBeGreaterThan(0)
  }, 30_000)

  it('BM25 分数与参考实现逐位一致（数值交叉验证，而不只是排序）', async () => {
    // 取出 SQL 打分用到的全部输入：命中词项的 tf、词项的 df、语料 N 与 avgdl、文档长度 dl
    const rows = await prisma.$queryRaw<
      Array<{ term: string; tf: number; df: number; n: number; avgdl: number; dl: number }>
    >`
      WITH scoped AS (
        SELECT c.id, c."tokenCount", c."tsv"
        FROM "DocumentChunk" c
        JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE d."knowledgeBaseId" = ${baseId}
          AND d.status = 'ready'
          AND c."tsv" IS NOT NULL
      ),
      corpus AS (
        SELECT COUNT(*)::float8 AS n, COALESCE(AVG("tokenCount"), 0)::float8 AS avgdl
        FROM scoped
      ),
      term_df AS (
        SELECT l.lexeme AS term, COUNT(*)::float8 AS df
        FROM scoped s, LATERAL unnest(s."tsv") AS l
        WHERE l.lexeme IN (${Prisma.join(queryTerms(QUERY))})
        GROUP BY l.lexeme
      ),
      needle_tf AS (
        SELECT l.lexeme AS term, cardinality(l.positions)::float8 AS tf
        FROM scoped s, LATERAL unnest(s."tsv") AS l
        WHERE s.id = ${needleId}
          AND l.lexeme IN (${Prisma.join(queryTerms(QUERY))})
      )
      SELECT tf.term, tf.tf, df.df, c.n, c.avgdl, s."tokenCount"::float8 AS dl
      FROM needle_tf tf
      JOIN term_df df ON df.term = tf.term
      CROSS JOIN corpus c
      JOIN scoped s ON s.id = ${needleId}
    `

    expect(rows.length).toBeGreaterThan(0)

    const expected = rows.reduce(
      (sum, row) =>
        sum +
        bm25Expected({
          tf: row.tf,
          df: row.df,
          total: row.n,
          docLength: row.dl,
          avgDocLength: row.avgdl,
        }),
      0
    )

    const result = await searchByLexical({
      ownedBaseIds: [baseId],
      query: QUERY,
      limit: 5,
    })
    const actual = result.hits.find((hit) => hit.chunk.id === needleId)?.score ?? 0

    // 1e-9 相对容差：SQL 与应用层都是 float8/double，公式一致就应当逐位吻合
    expect(actual).toBeGreaterThan(0)
    expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-9)

    // 反向保险：换一个 k1 再算一遍，结果必须与线上分数**不**一致——
    // 否则"相等"可能只是公式对常量不敏感造成的假绿，常量漂移照样能溜过去
    const wrongK1 = 3
    const withWrongK1 = rows.reduce((sum, row) => {
      const lengthRatio = row.avgdl > 0 ? row.dl / row.avgdl : 1
      return (
        sum +
        (bm25Idf(row.df, row.n) * (row.tf * (wrongK1 + 1))) /
          (row.tf + wrongK1 * (1 - BM25_B + BM25_B * lengthRatio))
      )
    }, 0)
    expect(Math.abs(actual - withWrongK1) / withWrongK1).toBeGreaterThan(0.01)
  }, 30_000)

  it('tsv 里存的是 CJK 二元组（中文能被检索到）', async () => {
    const rows = await prisma.$queryRaw<Array<{ has_cjk: boolean }>>`
      SELECT ("tsv"::text LIKE '%麒麟%') AS has_cjk
      FROM "DocumentChunk" WHERE id = ${needleId}
    `
    expect(rows[0]?.has_cjk).toBe(true)
  }, 30_000)

  it('词项切分在两侧一致：toLexemeText 的词项等于 tokenize 的结果', () => {
    const lexemes = toLexemeText(NEEDLE_TEXT).split(' ').filter(Boolean)
    expect(new Set(lexemes)).toEqual(new Set(queryTerms(NEEDLE_TEXT)))
  })

  it('范围外（别人的知识库 id）检索不到任何片段', async () => {
    const result = await exactScanByVector({
      ownedBaseIds: ['kb-does-not-exist'],
      queryVector: QUERY_VECTOR,
      embeddingModel: ACTIVE_MODEL,
      limit: 5,
    })
    expect(result.hits).toHaveLength(0)
    expect(result.scanned).toBe(0)
  }, 30_000)
})

describe.runIf(ENABLED)('RagTask 队列（数据库集成）', () => {
  let userId = ''
  let baseId = ''
  const created: string[] = []

  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('数据库里没有用户')
    userId = user.id
    const base = await KnowledgeRepository.createBase(userId, '__RAG_QUEUE_TEST__')
    baseId = base.id
  })

  afterAll(async () => {
    await prisma.ragTask.deleteMany({ where: { id: { in: created } } })
    if (baseId) await prisma.knowledgeBase.deleteMany({ where: { id: baseId } })
    await prisma.$disconnect()
  })

  it('领取后任务变为 running、attempts 自增，重复领取不会再拿到同一条', async () => {
    const task = await RagTaskRepository.enqueue({
      type: 'ingest',
      userId,
      knowledgeBaseId: baseId,
      payload: { hello: 'world' },
    })
    created.push(task.id)

    const claimed = await RagTaskRepository.claimNext('worker-test-1')
    expect(claimed?.id).toBe(task.id)
    expect(claimed?.status).toBe('running')
    expect(claimed?.attempts).toBe(1)

    // 已被领取的任务不会被第二个 worker 再领到（SKIP LOCKED + status 过滤）
    const second = await RagTaskRepository.claimNext('worker-test-2')
    expect(second?.id).not.toBe(task.id)

    await RagTaskRepository.complete(task.id, 'worker-test-1')
    const done = await prisma.ragTask.findUnique({ where: { id: task.id } })
    expect(done?.status).toBe('succeeded')
    expect(done?.progress).toBe(100)

    // 已被领取的任务不会被第二个 worker 再领到（SKIP LOCKED + status 过滤）
    const stale = await RagTaskRepository.complete(task.id, 'worker-test-2')
    expect(stale.applied).toBe(false)
  })

  it('失败时按尝试次数决定重试还是终态（走真实领取顺序）', async () => {
    const task = await RagTaskRepository.enqueue({
      type: 'ingest',
      userId,
      knowledgeBaseId: baseId,
      payload: {},
      maxAttempts: 2,
    })
    created.push(task.id)

    const first = await RagTaskRepository.claimNext('worker-test-3')
    expect(first?.id).toBe(task.id)
    expect(first?.attempts).toBe(1)

    // 第 1 次失败：还有重试次数 → 退避重排，并释放 workerId（这样别的 worker 才能接手）
    const attempt1 = await RagTaskRepository.fail(task.id, 'worker-test-3', '上游 503', {
      attempts: 1,
      maxAttempts: 2,
    })
    expect(attempt1).toEqual({ applied: true, willRetry: true })

    const requeued = await prisma.ragTask.findUnique({ where: { id: task.id } })
    expect(requeued?.status).toBe('queued')
    expect(requeued?.workerId).toBeNull()
    expect(requeued?.runAfter.getTime()).toBeGreaterThan(Date.now() + 1000)

    // runAfter 未到时不该被领取（退避真的生效）
    const notYet = await RagTaskRepository.claimNext('worker-test-4')
    expect(notYet?.id).not.toBe(task.id)

    // 已经在排队的任务不应被"旧 worker"再改一次状态
    const staleWrite = await RagTaskRepository.fail(task.id, 'worker-test-3', '迟到的失败', {
      attempts: 1,
      maxAttempts: 2,
    })
    expect(staleWrite.applied).toBe(false)

    // 退避时间到 → 第二次领取 → 用尽次数 → failed
    await prisma.ragTask.update({
      where: { id: task.id },
      data: { runAfter: new Date(Date.now() - 1000) },
    })
    const second = await RagTaskRepository.claimNext('worker-test-5')
    expect(second?.id).toBe(task.id)
    expect(second?.attempts).toBe(2)

    const attempt2 = await RagTaskRepository.fail(task.id, 'worker-test-5', '仍然失败', {
      attempts: 2,
      maxAttempts: 2,
    })
    expect(attempt2).toEqual({ applied: true, willRetry: false })

    const failed = await prisma.ragTask.findUnique({ where: { id: task.id } })
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('仍然失败')
  })

  it('僵死任务会被回收重排', async () => {
    const task = await RagTaskRepository.enqueue({
      type: 'rebuild',
      userId,
      knowledgeBaseId: baseId,
      payload: {},
    })
    created.push(task.id)

    await RagTaskRepository.claimNext('worker-dead')
    // 把锁时间改到很久以前，模拟 worker 被杀
    await prisma.ragTask.update({
      where: { id: task.id },
      data: { lockedAt: new Date(Date.now() - 10 * 60 * 1000) },
    })

    const recovered = await RagTaskRepository.recoverStale(60_000)
    expect(recovered).toBeGreaterThanOrEqual(1)

    const row = await prisma.ragTask.findUnique({ where: { id: task.id } })
    expect(row?.status).toBe('queued')
    expect(row?.workerId).toBeNull()
  })
})

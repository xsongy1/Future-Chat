/**
 * RagTask Repository —— 入库/重建任务队列
 *
 * 用 PostgreSQL 表当队列，靠 `FOR UPDATE SKIP LOCKED` 保证多实例下不重复消费。
 * 之所以不引入 Redis/BullMQ：任务粒度是"一次上传/一次重建"，量级远达不到
 * 需要独立中间件的程度，而 SKIP LOCKED 已经能提供需要的原子领取语义，
 * 少一个有状态组件就少一套部署与运维成本。
 */

import { prisma } from '@/server/db/client'

export type RagTaskType = 'ingest' | 'rebuild'
export type RagTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** 队列里的一条任务（$queryRaw 返回的原始行） */
export interface RagTaskRow {
  id: string
  type: string
  status: string
  userId: string
  knowledgeBaseId: string | null
  documentId: string | null
  payload: unknown
  priority: number
  attempts: number
  maxAttempts: number
  progress: number
  error: string | null
  workerId: string | null
  runAfter: Date
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 失败重试的退避上限（秒）：上游 embedding 限流通常几十秒内恢复，退避再长只是让用户干等 */
const MAX_BACKOFF_SECONDS = 300

export const RagTaskRepository = {
  /**
   * 入队
   */
  async enqueue(data: {
    type: RagTaskType
    userId: string
    knowledgeBaseId?: string | null
    documentId?: string | null
    payload: Record<string, unknown>
    priority?: number
    maxAttempts?: number
  }) {
    return prisma.ragTask.create({
      data: {
        type: data.type,
        userId: data.userId,
        knowledgeBaseId: data.knowledgeBaseId ?? null,
        documentId: data.documentId ?? null,
        payload: data.payload as object,
        priority: data.priority ?? 0,
        maxAttempts: data.maxAttempts ?? 3,
      },
    })
  },

  /**
   * 原子领取一条待执行任务
   *
   * `FOR UPDATE SKIP LOCKED` 让并发 worker 各自领到不同的行而不是互相阻塞：
   * 被别的事务锁住的行直接跳过，因此不需要额外的分布式锁，
   * 也不会出现两个 worker 同时处理同一条任务（重复向量化 = 重复付费）。
   *
   * attempts 在这里就 +1（而不是失败时才加）：任务在 running 期间崩溃时，
   * 靠 attempts 已经自增来避免死循环重试。
   */
  async claimNext(workerId: string): Promise<RagTaskRow | null> {
    const rows = await prisma.$queryRaw<RagTaskRow[]>`
      UPDATE "RagTask"
      SET status = 'running',
          "workerId" = ${workerId},
          "lockedAt" = now(),
          "startedAt" = COALESCE("startedAt", now()),
          attempts = attempts + 1,
          "updatedAt" = now()
      WHERE id = (
        SELECT id FROM "RagTask"
        WHERE status = 'queued' AND "runAfter" <= now()
        ORDER BY priority DESC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `
    return rows[0] ?? null
  },

  /**
   * 心跳：长任务（大文档向量化可达数十秒）定期续锁
   *
   * @returns applied=false 表示这条任务已经不在本 worker 名下：
   *          要么被用户连知识库一起删了（级联删任务行），要么被回收重排给了别的 worker。
   *          两种情况都意味着"不该继续做、也不该再花钱"，调用方据此提前中止
   *          （见 server/services/rag/errors.ts 里的 RagTaskAbortedError）。
   */
  async heartbeat(
    id: string,
    workerId: string,
    progress?: number
  ): Promise<{ applied: boolean }> {
    const result = await prisma.ragTask.updateMany({
      // status 也纳入条件：已被回收重排（回到 queued）的任务不该被旧 worker 续锁
      where: { id, workerId, status: 'running' },
      data: {
        lockedAt: new Date(),
        ...(progress === undefined ? {} : { progress }),
      },
    })
    return { applied: result.count > 0 }
  },

  /**
   * 任务成功
   *
   * @returns applied=false 表示这条任务已经不在本 worker 名下
   *          （被回收重排 / 已被别的 worker 接手），本次写入是空操作。
   *          调用方需要知道这件事，否则"乐观地认为写成功了"会掩盖并发问题。
   */
  async complete(id: string, workerId: string): Promise<{ applied: boolean }> {
    const result = await prisma.ragTask.updateMany({
      // status 也纳入条件：已被回收重排（status 回到 queued）的任务不该被旧 worker 改写成成功
      where: { id, workerId, status: 'running' },
      data: {
        status: 'succeeded',
        progress: 100,
        finishedAt: new Date(),
        lockedAt: null,
        error: null,
      },
    })
    return { applied: result.count > 0 }
  },

  /**
   * 任务失败：还有重试次数就退避重排，否则置为 failed
   *
   * 重排时会清空 workerId/lockedAt（让任务能被重新领取）。因此这个函数
   * 只对"当前仍由该 worker 持有"的任务生效——第二次调用同一任务的
   * fail 会因为 workerId 已清空而不再匹配，从而不会把一个已经重新排队的任务
   * 误改成 failed。调用方通过 applied 判断是否真的写入了。
   *
   * @returns applied 是否真的写入了状态；willRetry 是否还会重试
   */
  async fail(
    id: string,
    workerId: string,
    error: string,
    options: { attempts: number; maxAttempts: number }
  ): Promise<{ applied: boolean; willRetry: boolean }> {
    const willRetry = options.attempts < options.maxAttempts
    const backoffSeconds = Math.min(
      MAX_BACKOFF_SECONDS,
      2 ** Math.max(0, options.attempts - 1) * 5
    )

    const result = await prisma.ragTask.updateMany({
      where: { id, workerId, status: 'running' },
      data: willRetry
        ? {
            status: 'queued',
            runAfter: new Date(Date.now() + backoffSeconds * 1000),
            lockedAt: null,
            workerId: null,
            error,
          }
        : {
            status: 'failed',
            finishedAt: new Date(),
            lockedAt: null,
            error,
          },
    })

    return { applied: result.count > 0, willRetry: result.count > 0 && willRetry }
  },

  /**
   * 回收僵死任务（worker 进程被杀、部署重启时留下的 running）
   *
   * 判定依据是 lockedAt 超时而不是 status=running：正常长任务会持续 heartbeat，
   * 因此"锁很久没续"才等于"worker 真的没了"。
   *
   * @returns 被回收的任务数
   */
  async recoverStale(lockTimeoutMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - lockTimeoutMs)
    const result = await prisma.ragTask.updateMany({
      where: { status: 'running', OR: [{ lockedAt: { lt: cutoff } }, { lockedAt: null }] },
      data: { status: 'queued', workerId: null, lockedAt: null, runAfter: new Date() },
    })
    return result.count
  },

  /**
   * 某文档的最近任务（前端轮询展示进度用）
   */
  async findLatestByDocument(documentId: string): Promise<RagTaskRow | null> {
    const rows = await prisma.$queryRaw<RagTaskRow[]>`
      SELECT * FROM "RagTask"
      WHERE "documentId" = ${documentId}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `
    return rows[0] ?? null
  },

  /**
   * 队列概览（健康检查 / 运维观察）
   */
  async stats(): Promise<Record<string, number>> {
    const rows = await prisma.ragTask.groupBy({
      by: ['status'],
      _count: { _all: true },
    })
    return Object.fromEntries(rows.map((r) => [r.status, r._count._all]))
  },
}

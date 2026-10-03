/**
 * RAG 任务 worker（入库 / 重建）
 *
 * 常驻轮询而不是"每条任务起一个进程"：任务是 IO 密集型（等 embedding API），
 * 轮询开销可以忽略，而少一个进程模型就少一堆僵尸进程、重复消费、优雅退出的问题。
 *
 * ## 启动方式（一个都不依赖）
 * 1. 入队即拉起：上传/重建接口入队后调 kickRagWorker()，立刻执行，不等轮询周期
 * 2. 轮询接口保活：文档列表接口也会 kick，用户在看进度时队列一定是活的
 * 3. 独立进程：`pnpm rag:worker` 起一个只跑队列的进程，适合多实例部署
 *    （进程内 worker 与独立 worker 用 FOR UPDATE SKIP LOCKED 抢任务，不会重复消费）
 *
 * ## 为什么不用 instrumentation.ts 自动启动
 * instrumentation.ts 会被 Next 同时编译进 edge 层（项目里有 middleware.ts），
 * 而 worker 依赖 prisma / node:crypto，一旦进入 edge 的依赖图就是构建期报错
 * （实测：UnhandledSchemeError 'node:crypto' / Can't resolve 'crypto'），
 * 用 NEXT_RUNTIME 常量分支也摇不掉动态 import。所以改成"入队即拉起 + 独立进程"
 * 两条路，不赌打包器的 tree-shaking 行为。
 *
 * 单实例内的并发由 running 标志保证为 1：embedding 的上游限流是主要瓶颈，
 * 本地并发只会把限流触发得更频繁。
 */

import { RagTaskRepository, type RagTaskRow } from '@/server/repositories/rag-task.repository'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { UserRepository } from '@/server/repositories/user.repository'
import { ingestDocument } from './ingest'
import { rebuildDocumentEmbeddings } from './maintenance'

/** 轮询间隔：入库通常几十秒内完成，2s 的延迟用户感知不到，也不会打满数据库 */
const DEFAULT_POLL_MS = 2000

/** 锁超时：超过这个时间没有心跳的任务视为 worker 已死，重新入队 */
const DEFAULT_LOCK_TIMEOUT_MS = 120_000

/** 心跳间隔：必须显著小于锁超时，否则正常长任务会被自己人回收 */
const HEARTBEAT_MS = 15_000

interface WorkerState {
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  started: boolean
  workerId: string
  processed: number
  lastError: string | null
}

// 用 globalThis 存状态：Next.js 开发模式热重载会重新执行模块，
// 状态放在模块级变量上会变成"多个 worker 同时轮询"（领取是原子的，不会重复消费，
// 但会出现无意义的并发与日志噪声）。
const globalForWorker = globalThis as unknown as { __ragWorker?: WorkerState }

function state(): WorkerState {
  if (!globalForWorker.__ragWorker) {
    globalForWorker.__ragWorker = {
      timer: null,
      running: false,
      started: false,
      workerId: `rag-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      processed: 0,
      lastError: null,
    }
  }
  return globalForWorker.__ragWorker
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return defaultValue
  return !['0', 'false', 'off', 'no'].includes(raw)
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 取任务执行所需的 API Key
 *
 * 在**执行时**按 userId 取，而不是入队时快照：用户在排队期间换了 Key 也应该用新的；
 * 用户没配自己的 Key 时回退到服务端 Key，与上传接口的解析顺序保持一致。
 */
async function resolveApiKey(userId: string): Promise<string | null> {
  const user = await UserRepository.findById(userId)
  return user?.apiKey || process.env.SILICONFLOW_API_KEY || null
}

/**
 * 执行一条任务
 *
 * @returns 是否成功（失败时任务已按重试策略处理）
 */
export async function executeTask(task: RagTaskRow): Promise<boolean> {
  const workerId = task.workerId ?? state().workerId
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      void RagTaskRepository.heartbeat(task.id, workerId).catch(() => {
        // 心跳失败（例如数据库短暂不可用）不应中断正在进行的向量化
      })
    }, HEARTBEAT_MS)
  }

  try {
    const apiKey = await resolveApiKey(task.userId)
    if (!apiKey) {
      throw new Error('未配置 API Key，无法对文档做向量化')
    }

    if (task.type === 'ingest') {
      const payload = (task.payload ?? {}) as {
        name?: string
        type?: 'txt' | 'md'
        size?: number
        content?: string
        contentHash?: string
      }

      if (!payload.content || !task.knowledgeBaseId) {
        throw new Error('入库任务缺少正文或知识库 ID（payload 不完整）')
      }

      startHeartbeat()

      await ingestDocument({
        userId: task.userId,
        knowledgeBaseId: task.knowledgeBaseId,
        documentId: task.documentId ?? undefined,
        name: payload.name ?? '未命名文档',
        type: payload.type ?? 'txt',
        size: payload.size ?? payload.content.length,
        content: payload.content,
        contentHash: payload.contentHash,
        apiKey,
        // 失败状态由 worker 统一落：任务还有重试次数时不能先把文档标成 failed，
        // 否则用户会看到"失败 → 重试中 → 成功"的状态来回跳
        deferFailure: true,
        onProgress: async ({ processed, total }) => {
          const progress = total > 0 ? Math.round((processed / total) * 100) : 0
          await Promise.all([
            RagTaskRepository.heartbeat(task.id, workerId, progress),
            task.documentId
              ? KnowledgeRepository.updateDocumentProgress(task.documentId, {
                  processedChunks: processed,
                  status: 'processing',
                })
              : Promise.resolve(),
          ])
        },
      })
    } else if (task.type === 'rebuild') {
      const payload = (task.payload ?? {}) as {
        documentId?: string
        targetModel?: string
        batchSize?: number
        maxChunks?: number
      }

      startHeartbeat()

      await rebuildDocumentEmbeddings({
        userId: task.userId,
        apiKey,
        knowledgeBaseId: task.knowledgeBaseId ?? undefined,
        documentId: payload.documentId ?? task.documentId ?? undefined,
        targetModel: payload.targetModel,
        batchSize: payload.batchSize,
        maxChunks: payload.maxChunks,
        onProgress: ({ rebuilt }) => {
          void RagTaskRepository.heartbeat(task.id, workerId, rebuilt).catch(() => {})
        },
      })
    } else {
      throw new Error(`未知任务类型：${task.type}`)
    }

    const { applied } = await RagTaskRepository.complete(task.id, workerId)
    if (!applied) {
      console.warn(
        `[RAG] 任务 ${task.id} 已不在本 worker 名下（可能已被回收重排），跳过"成功"状态写入`
      )
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state().lastError = message

    const { applied, willRetry } = await RagTaskRepository.fail(
      task.id,
      workerId,
      message,
      {
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
      }
    )

    if (!applied) {
      console.warn(
        `[RAG] 任务 ${task.id} 已不在本 worker 名下，跳过"失败"状态写入（不会被误判为终态）`
      )
      return false
    }

    console.error(
      `[RAG] 任务失败 ${task.id}（${task.type}，第 ${task.attempts}/${task.maxAttempts} 次）: ${message}` +
        (willRetry ? ' —— 稍后重试' : ' —— 不再重试')
    )

    // 只有彻底放弃时才把文档标成 failed：重试期间保持 processing，
    // 否则用户看到"失败"之后又变成"成功"，会怀疑数据到底进没进去
    if (!willRetry && task.documentId && task.type === 'ingest') {
      await KnowledgeRepository.markDocumentFailed(task.documentId, message)
    }

    return false
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  }
}

/**
 * 领取并执行一条任务
 *
 * @returns 是否领取到了任务（false 表示队列为空）
 */
export async function runTaskOnce(workerId?: string): Promise<boolean> {
  const s = state()
  const id = workerId ?? s.workerId

  // 先回收僵死任务：worker 被杀（部署重启 / OOM）时留下的 running 不会有人再接
  await RagTaskRepository.recoverStale(envInt('RAG_WORKER_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS))

  const task = await RagTaskRepository.claimNext(id)
  if (!task) return false

  s.processed += 1
  await executeTask({ ...task, workerId: id })
  return true
}

/**
 * 启动常驻轮询（幂等）
 */
export function startRagWorker(): void {
  if (!envFlag('RAG_WORKER_ENABLED', true)) {
    console.log('[RAG] worker 未启动：RAG_WORKER_ENABLED 已关闭')
    return
  }

  const s = state()
  if (s.started) return
  s.started = true

  const pollMs = envInt('RAG_WORKER_POLL_MS', DEFAULT_POLL_MS)

  const loop = async () => {
    if (s.running) return
    s.running = true
    try {
      // 一次 tick 内把队列排空（有上限，避免一条 tick 无限占用）
      for (let i = 0; i < 5; i++) {
        const claimed = await runTaskOnce()
        if (!claimed) break
      }
    } catch (error) {
      s.lastError = error instanceof Error ? error.message : String(error)
      console.error('[RAG] worker 轮询异常:', s.lastError)
    } finally {
      s.running = false
      if (s.started) {
        s.timer = setTimeout(() => void loop(), pollMs)
        // 不要让定时器阻止进程退出（next build / 脚本场景）
        s.timer.unref?.()
      }
    }
  }

  console.log(
    `[RAG] worker 已启动: ${s.workerId}（轮询 ${pollMs}ms，并发 1）`
  )
  void loop()
}

/**
 * 停止轮询（测试/优雅退出用）
 */
export function stopRagWorker(): void {
  const s = state()
  s.started = false
  if (s.timer) {
    clearTimeout(s.timer)
    s.timer = null
  }
}

/**
 * 催促一次（入队后调用，省掉一个轮询周期的等待）
 *
 * 不 await：接口不应该等任务执行，只负责把它踢醒。
 * 与轮询循环并发是安全的——领取走 FOR UPDATE SKIP LOCKED，两个调用只会领到不同的任务。
 */
export function kickRagWorker(): void {
  if (!state().started) startRagWorker()
  void runTaskOnce().catch((error) => {
    console.error('[RAG] worker kick 失败:', error instanceof Error ? error.message : error)
  })
}

/** worker 运行状态（健康检查/诊断用） */
export function getWorkerState(): {
  started: boolean
  running: boolean
  workerId: string
  processed: number
  lastError: string | null
} {
  const s = state()
  return {
    started: s.started,
    running: s.running,
    workerId: s.workerId,
    processed: s.processed,
    lastError: s.lastError,
  }
}

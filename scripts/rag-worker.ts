/**
 * 独立的 RAG 任务 worker 进程
 *
 * 用途：多实例/容器化部署时，把队列消费从 Web 进程里拆出来单独跑，
 * 避免"Web 进程重启导致排队任务无人消费"这类问题。
 *
 *   pnpm rag:worker
 *
 * 与 Web 进程内的 worker 可以同时存在：领取任务走 FOR UPDATE SKIP LOCKED，
 * 两个消费者只会领到不同的任务，不会重复向量化（不会重复付费）。
 *
 * 环境变量：
 *   RAG_WORKER_POLL_MS          轮询间隔（默认 2000）
 *   RAG_WORKER_LOCK_TIMEOUT_MS  锁超时，超过则视为 worker 已死并回收（默认 120000）
 *   RAG_WORKER_ONCE=1           只把当前队列跑空后退出（适合 cron / 一次性补跑）
 */

import { getWorkerState, runTaskOnce, startRagWorker, stopRagWorker } from '../server/services/rag/worker'
import { RagTaskRepository } from '../server/repositories/rag-task.repository'
import { prisma } from '../server/db/client'

async function main(): Promise<void> {
  const once = process.env.RAG_WORKER_ONCE === '1'
  console.log(`[RAG worker] 启动（${once ? '一次性模式：跑空队列后退出' : '常驻模式'}）`)
  console.log('[RAG worker] 队列现状:', await RagTaskRepository.stats())

  if (once) {
    let processed = 0
    for (;;) {
      const claimed = await runTaskOnce()
      if (!claimed) break
      processed += 1
    }
    console.log(`[RAG worker] 队列已跑空，本次处理 ${processed} 个任务`)
    return
  }

  startRagWorker()

  // 优雅退出：把定时器停掉再断开数据库，避免退出瞬间正在执行的任务被硬杀
  const shutdown = async (signal: string) => {
    console.log(`\n[RAG worker] 收到 ${signal}，停止轮询并等待当前任务结束…`)
    stopRagWorker()
    const state = getWorkerState()
    console.log(
      `[RAG worker] 本次共处理 ${state.processed} 个任务，最后错误：${state.lastError ?? '无'}`
    )
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(async (error) => {
  console.error('[RAG worker] 异常退出:', error)
  await prisma.$disconnect()
  process.exitCode = 1
})

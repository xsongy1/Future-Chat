/**
 * 监控事件上报 API
 *
 * 接收前端 future-monitor-sdk 上报的埋点事件（单条或批量），
 * 解析 context 中的维度字段（appId/sessionId/traceId）落库，
 * 便于按维度聚合查询。
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/server/db/client'
import { checkMonitorIngestRate, createMonitorRetention } from '@/server/utils/monitor-ingest'

/** 单批事件条数上限：超限直接 413，避免一次请求写入过多行 */
const MAX_BATCH_SIZE = 500

/** 请求体字节上限：content-length 超限时不解析直接 413 */
const MAX_BODY_BYTES = 1_000_000

/**
 * 保留期清理：超过保留期的遥测事件直接删除（本表只写无读，过期即垃圾）
 *
 * 节流到每小时最多一次，且不 await——清理耗时不该计入上报响应；
 * 失败只记日志，下个周期再试（next start 常驻进程，未 await 的 Promise 仍会跑完）
 */
const pruneOldEvents = createMonitorRetention({
  deleteOlderThan: async (cutoff) => {
    const { count } = await prisma.monitorEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    })
    return count
  },
})

/** 事件结构（与 SDK 事件信封对齐） */
interface MonitorEventPayload {
  id: string
  type: string
  timestamp: number
  data: Record<string, unknown>
  context: {
    appId?: string
    sessionId?: string
    traceId?: string
    [key: string]: unknown
  }
}

/**
 * 验证事件结构
 *
 * 注意两个容易漏掉的坑：
 * - `typeof null === 'object'`：data/context 为 null 必须判掉，否则会在 Prisma 层抛错
 * - `typeof NaN === 'number'`：timestamp 必须是有限数，NaN 会让 new Date() 变成 Invalid Date
 * - timestamp 还要落在 Date 可表示范围内：1e20 能过 isFinite，但同样是 Invalid Date，
 *   而 createMany 是一次调用，一条坏数据会让同批合法事件一起丢
 */
function validateEvent(event: unknown): event is MonitorEventPayload {
  if (!event || typeof event !== 'object') return false
  const e = event as Record<string, unknown>
  const timestamp = e.timestamp
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.type === 'string' &&
    e.type.length > 0 &&
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    timestamp > 0 &&
    timestamp < 8.64e15 &&
    !!e.data &&
    typeof e.data === 'object' &&
    !!e.context &&
    typeof e.context === 'object'
  )
}

/**
 * POST /api/monitor
 * 接收单个事件或事件数组，批量写入数据库（按 id 去重）
 */
export async function POST(request: NextRequest) {
  try {
    // 限流放在最前面：写入速率先封顶，再谈解析与落库（解析本身就是成本）
    const rate = checkMonitorIngestRate(request)
    if (!rate.allowed) {
      return NextResponse.json(
        { success: false, error: '请求过于频繁' },
        { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } }
      )
    }

    // 先按 content-length 做粗粒度拦截：超大请求体不解析、不落库
    const contentLength = Number(request.headers.get('content-length') ?? NaN)
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return NextResponse.json(
        { success: false, error: '请求体过大', maxBytes: MAX_BODY_BYTES },
        { status: 413 }
      )
    }

    // 解析失败是客户端问题，必须回 400：
    // 回 500 会被 BrowserTransport 当成发送失败 → TransportPlugin 退避重试 → 静默丢弃，
    // 与真正的服务端故障无法区分
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { success: false, error: '请求体不是合法 JSON' },
        { status: 400 }
      )
    }

    // 支持单个事件或数组
    const events: unknown[] = Array.isArray(body) ? body : [body]

    // 单批条数上限：超限直接拒绝，不写任何数据
    if (events.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { success: false, error: '单批事件数超过上限', maxBatchSize: MAX_BATCH_SIZE },
        { status: 413 }
      )
    }

    if (events.length === 0) {
      return NextResponse.json(
        { success: false, error: '没有事件数据' },
        { status: 400 }
      )
    }

    // 逐条校验：非法事件单独丢弃并计数，不牵连整批。
    // 否则一条毒事件会让整批被 400 拒绝 → SDK 重试耗尽 → 同批合法事件一起丢。
    const validEvents: MonitorEventPayload[] = []
    let invalid = 0
    for (const event of events) {
      if (validateEvent(event)) {
        validEvents.push(event)
      } else {
        invalid += 1
      }
    }

    if (validEvents.length === 0) {
      return NextResponse.json(
        { success: false, error: '事件格式无效', invalid },
        { status: 400 }
      )
    }

    // 批量写入数据库：维度字段从 context 解析出来作为独立列
    // count 是真正插入的行数（skipDuplicates 跳过的不计入），可用作落地核对
    const { count } = await prisma.monitorEvent.createMany({
      data: validEvents.map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: new Date(e.timestamp),
        data: e.data as object,
        context: e.context as object,
        appId: typeof e.context.appId === 'string' ? e.context.appId : null,
        sessionId: typeof e.context.sessionId === 'string' ? e.context.sessionId : null,
        traceId: typeof e.context.traceId === 'string' ? e.context.traceId : null,
      })),
      skipDuplicates: true, // 跳过重复 ID（SDK 端离线补发场景）
    })

    // 借用这次成功写入顺带清理过期数据：没有常驻定时任务，清理必须挂在流量上，
    // 否则永远不会执行（表不再增长时也就没有清理的必要）
    void pruneOldEvents().catch((error) => {
      console.error('[Monitor API] 保留期清理失败:', error)
    })

    return NextResponse.json({
      success: true,
      count,
      received: validEvents.length,
      duplicates: validEvents.length - count,
      invalid,
    })
  } catch (error) {
    console.error('[Monitor API] 写入失败:', error)
    return NextResponse.json(
      { success: false, error: '服务器错误' },
      { status: 500 }
    )
  }
}

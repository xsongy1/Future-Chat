/**
 * 监控上报的接入策略：限流 + 保留期
 *
 * 这两件事要放在一起看：`/api/monitor` 是**只写无读**的遥测入口（全仓仅此一处写
 * MonitorEvent，没有任何读取方），所以它的风险不是"数据被人看到"，而是**磁盘被写爆**。
 * 限流封住写入速率，保留期封住总量。
 *
 * 复用既有能力，不另起炉灶：
 * - 限流：server/middleware/rate-limit（内存固定窗口，单实例自托管够用）
 * - IP 提取：server/utils/ip.ts（只在声明了 TRUST_PROXY 时才信任转发头）
 */

import { getClientIp } from './ip'
import { consumeRateLimit, type RateLimitResult } from '../middleware/rate-limit'

/** 每 IP 每分钟配额：SDK 常规约 12 req/min（flushInterval 5s），留 5 倍余量 */
const MAX_REQUESTS_PER_IP_PER_MIN = 60

/**
 * 拿不到可信 IP 时的**全局**兜底配额
 *
 * 不能沿用每 IP 的 60：TRUST_PROXY 未配置时所有客户端共用一个桶，60/min 会让几个
 * 并发用户互相误伤（埋点静默丢失）。600/min 约等于 50 个活跃客户端，既能挡住单脚本
 * 灌数据，也不误伤自托管下的正常流量。
 * 想精确到 IP：放到反向代理后面并配置 TRUST_PROXY（见 server/utils/ip.ts）。
 */
const MAX_REQUESTS_UNTRUSTED_PER_MIN = 600

const RATE_WINDOW_MS = 60 * 1000

/** 无可信 IP 时所有请求共用的兜底桶 */
const UNTRUSTED_BUCKET_KEY = 'monitor-ingest:untrusted'

/** 保留期（天）：只写无读的遥测数据，过期即为垃圾；5 天足够定位线上问题 */
export const MONITOR_EVENT_RETENTION_DAYS = 5

/** 默认清理间隔：同一实例每小时最多一次（多实例各自触发也无妨，deleteMany 幂等） */
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** 选择限流桶：可信 IP 独占桶，拿不到可信 IP 则退化为全局兜底桶 */
export function monitorIngestBucket(ip: string | undefined): { key: string; limit: number } {
  return ip
    ? { key: `monitor-ingest:${ip}`, limit: MAX_REQUESTS_PER_IP_PER_MIN }
    : { key: UNTRUSTED_BUCKET_KEY, limit: MAX_REQUESTS_UNTRUSTED_PER_MIN }
}

/** 消费一次上报配额 */
export function checkMonitorIngestRate(request: Request): RateLimitResult {
  const { key, limit } = monitorIngestBucket(getClientIp(request))
  return consumeRateLimit(key, limit, RATE_WINDOW_MS)
}

/** 保留期清理器：按保留期删除过期事件（带节流） */
export type MonitorRetention = (now?: number) => Promise<boolean>

/**
 * 创建保留期清理器
 *
 * deleteOlderThan 用注入而不是直接 import prisma：cutoff 算错就等于删错数据，
 * 这段逻辑必须有单测兜住（见 server/utils/__tests__/monitor-ingest.test.ts）。
 *
 * @returns 执行清理并返回是否真的删了（被节流跳过时为 false）
 */
export function createMonitorRetention(options: {
  deleteOlderThan: (cutoff: Date) => Promise<number>
  retentionDays?: number
  intervalMs?: number
}): MonitorRetention {
  const retentionDays = options.retentionDays ?? MONITOR_EVENT_RETENTION_DAYS
  const intervalMs = options.intervalMs ?? DEFAULT_PRUNE_INTERVAL_MS
  let lastPruneAt = 0

  return async function prune(now: number = Date.now()): Promise<boolean> {
    // 先记时间再删：删除失败（DB 抖动）也不该在下一个周期前被反复重试打爆
    if (now - lastPruneAt < intervalMs) return false
    lastPruneAt = now
    await options.deleteOlderThan(new Date(now - retentionDays * DAY_MS))
    return true
  }
}

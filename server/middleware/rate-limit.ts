/**
 * 轻量内存限流器（固定窗口）
 *
 * 适用于单实例自托管部署（docker-compose 等）。
 * 多实例/Serverless 部署下各实例独立计数，仅能降低暴力破解速率，
 * 如需严格限流请改用 Redis 等共享存储。
 *
 * 每个窗口过期后自动清理，避免 Map 无限增长。
 */

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

const SWEEP_INTERVAL_MS = 60_000
let lastSweepAt = 0

function sweep(now: number): void {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export interface RateLimitResult {
  allowed: boolean
  /** 需要等待的秒数（被限流时才有意义） */
  retryAfterSeconds: number
}

/**
 * 消费一次配额。每次调用计数 +1，超过 limit 后拒绝。
 */
export function consumeRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  sweep(now)

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  bucket.count += 1
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

/**
 * 重置某个 key 的计数（例如登录成功后释放配额）
 */
export function resetRateLimit(key: string): void {
  buckets.delete(key)
}

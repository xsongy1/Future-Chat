/**
 * 监控上报接入策略单测
 *
 * 重点覆盖两处"算错就有后果"的逻辑：
 * - 限流桶选择：拿不到可信 IP 时必须退化为全局桶，且绝不能沿用每 IP 的窄配额
 * - 保留期 cutoff：算错就是删错数据
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  MONITOR_EVENT_RETENTION_DAYS,
  checkMonitorIngestRate,
  createMonitorRetention,
  monitorIngestBucket,
} from '../monitor-ingest'
import { resetRateLimit } from '../../middleware/rate-limit'

const DAY_MS = 24 * 60 * 60 * 1000

function requestFrom(ip?: string): Request {
  return new Request('http://localhost/api/monitor', {
    method: 'POST',
    headers: ip ? { 'x-forwarded-for': ip } : {},
  })
}

afterEach(() => {
  // 限流器是模块级状态：清掉本次用例碰过的桶，避免影响其它用例
  resetRateLimit(monitorIngestBucket(undefined).key)
  delete process.env.TRUST_PROXY
})

describe('monitorIngestBucket', () => {
  it('有可信 IP 时用独占桶 + 每 IP 配额', () => {
    expect(monitorIngestBucket('203.0.113.7')).toEqual({
      key: 'monitor-ingest:203.0.113.7',
      limit: 60,
    })
  })

  it('无可信 IP 时退化为全局桶，且配额远大于每 IP 配额', () => {
    const fallback = monitorIngestBucket(undefined)

    expect(fallback.key).toBe('monitor-ingest:untrusted')
    // 关键：不能等于每 IP 配额，否则多个客户端共享一个桶会互相误伤
    expect(fallback.limit).toBeGreaterThan(monitorIngestBucket('203.0.113.7').limit)
  })
})

describe('checkMonitorIngestRate', () => {
  it('未配置 TRUST_PROXY 时不信任转发头：伪造不同 IP 仍共用全局桶', () => {
    delete process.env.TRUST_PROXY

    // 若转发头被信任，每个伪造 IP 都会拿到全新的 60 配额、永远不会被拒
    const limit = monitorIngestBucket(undefined).limit
    for (let i = 0; i <= limit; i += 1) {
      const result = checkMonitorIngestRate(requestFrom(`198.51.100.${i % 250}`))
      if (i < limit) {
        expect(result.allowed).toBe(true)
      } else {
        expect(result.allowed).toBe(false)
        expect(result.retryAfterSeconds).toBeGreaterThan(0)
      }
    }
  })

  it('配置 TRUST_PROXY 后按 IP 隔离：一个 IP 被限流不影响另一个', () => {
    process.env.TRUST_PROXY = 'true'
    const ip = '203.0.113.9'
    resetRateLimit(monitorIngestBucket(ip).key)

    const limit = monitorIngestBucket(ip).limit
    for (let i = 0; i < limit; i += 1) {
      expect(checkMonitorIngestRate(requestFrom(ip)).allowed).toBe(true)
    }
    expect(checkMonitorIngestRate(requestFrom(ip)).allowed).toBe(false)
    // 另一个 IP 不受影响
    expect(checkMonitorIngestRate(requestFrom('203.0.113.10')).allowed).toBe(true)

    resetRateLimit(monitorIngestBucket('203.0.113.10').key)
  })
})

describe('createMonitorRetention', () => {
  it('按保留期计算 cutoff 并执行删除', async () => {
    const cutoffs: Date[] = []
    const now = Date.UTC(2026, 0, 10, 12, 0, 0)
    const prune = createMonitorRetention({
      deleteOlderThan: async (cutoff) => {
        cutoffs.push(cutoff)
        return 3
      },
    })

    await expect(prune(now)).resolves.toBe(true)

    expect(cutoffs).toHaveLength(1)
    expect(cutoffs[0]).toBeInstanceOf(Date)
    expect(cutoffs[0].getTime()).toBe(now - MONITOR_EVENT_RETENTION_DAYS * DAY_MS)
  })

  it('保留期可通过参数覆盖（默认 5 天）', async () => {
    const cutoffs: Date[] = []
    const now = Date.UTC(2026, 0, 10)
    const prune = createMonitorRetention({
      retentionDays: 1,
      deleteOlderThan: async (cutoff) => {
        cutoffs.push(cutoff)
        return 0
      },
    })

    await prune(now)
    expect(cutoffs[0].getTime()).toBe(now - DAY_MS)
  })

  it('节流：间隔内重复调用直接跳过，不重复删库', async () => {
    let calls = 0
    const now = Date.UTC(2026, 0, 10)
    const prune = createMonitorRetention({
      intervalMs: 60 * 60 * 1000,
      deleteOlderThan: async () => {
        calls += 1
        return 0
      },
    })

    expect(await prune(now)).toBe(true)
    expect(await prune(now + 60 * 1000)).toBe(false)
    expect(calls).toBe(1)

    // 间隔已过 → 再删一次
    expect(await prune(now + 60 * 60 * 1000)).toBe(true)
    expect(calls).toBe(2)
  })

  it('删除失败会抛出，但节流时间已占用：不会在下一周期前反复重试', async () => {
    let calls = 0
    const now = Date.UTC(2026, 0, 10)
    const prune = createMonitorRetention({
      intervalMs: 60 * 60 * 1000,
      deleteOlderThan: async () => {
        calls += 1
        throw new Error('db down')
      },
    })

    await expect(prune(now)).rejects.toThrow('db down')
    // 关键：失败也不能立刻重试，否则 DB 抖动时会被每个请求打爆
    expect(await prune(now + 1000)).toBe(false)
    expect(calls).toBe(1)
  })
})

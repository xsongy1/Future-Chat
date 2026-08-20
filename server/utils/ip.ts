/**
 * 客户端 IP 提取（可信代理感知）
 *
 * `x-forwarded-for` / `x-real-ip` 都是客户端可伪造的请求头。
 * 只有当部署明确声明了可信反向代理（TRUST_PROXY）时，才信任这些转发头，
 * 否则一律不采用，防止审计日志与限流被伪造 IP 污染/绕过。
 *
 * TRUST_PROXY 取值：
 * - 不设置：不信任任何转发头，getClientIp 返回 undefined
 * - `true` / `1` / `yes`：信任所有代理（x-forwarded-for 最左为原始客户端）
 * - 逗号分隔的 IP / IPv4 CIDR 列表（如 `127.0.0.1,10.0.0.0/8`）：
 *   从右向左剥离可信代理跳，第一个不可信 IP 视为客户端
 */

import { isIP } from 'node:net'

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null
  }
  return ((((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0)
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr)
  if (!base || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  const ipInt = ipv4ToInt(ip)
  const baseInt = ipv4ToInt(base)
  if (ipInt === null || baseInt === null) return false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

function isTrustedProxy(ip: string, trusted: string[]): boolean {
  return trusted.some((t) => {
    if (t === ip) return true
    if (t.includes('/')) {
      // IPv4 CIDR 匹配；IPv6 CIDR 暂不支持（IPv6 仅精确匹配）
      if (isIP(ip) === 4 && isIP(t.split('/')[0]) === 4) return ipv4InCidr(ip, t)
      return false
    }
    return false
  })
}

/** 解析 TRUST_PROXY 环境变量，返回 null（不信任）| true（信任全部）| 可信 IP/CIDR 列表 */
function parseTrustConfig(env: string | undefined): null | true | string[] {
  const raw = env?.trim()
  if (!raw) return null
  const lowered = raw.toLowerCase()
  if (lowered === 'true' || lowered === '1' || lowered === 'yes') return true
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length > 0 ? list : null
}

/**
 * 从请求中提取可信的客户端 IP
 *
 * @returns 客户端 IP 字符串；无可信来源时返回 undefined
 */
export function getClientIp(request: Request): string | undefined {
  const trust = parseTrustConfig(process.env.TRUST_PROXY)
  if (!trust) return undefined

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter((s) => isIP(s) !== 0)

    if (chain.length > 0) {
      if (trust === true) {
        // 全部代理可信：最左（链首）为原始客户端
        return chain[0]
      }
      // 从右向左剥离可信代理跳
      for (let i = chain.length - 1; i >= 0; i--) {
        if (!isTrustedProxy(chain[i], trust)) return chain[i]
      }
      // 整条链都在可信列表内，退化为取最左
      return chain[0]
    }
  }

  const realIp = request.headers.get('x-real-ip')?.trim()
  if (realIp && isIP(realIp) !== 0) return realIp

  return undefined
}

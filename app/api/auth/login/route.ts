/**
 * 登录 API
 * POST /api/auth/login
 *
 * 安全说明：
 * - 内置内存限流（按 IP / 用户名 / IP+用户名），防暴力破解与撞库。
 *   多实例部署下各实例独立计数，如需严格限流请改用 Redis。
 * - IP 提取依赖 TRUST_PROXY 配置（见 server/utils/ip.ts），
 *   未声明可信代理时不启用基于 IP 的限流（避免伪造 IP 绕过或误伤全局）。
 */

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { UserRepository } from '@/server/repositories/user.repository'
import { verifyPassword } from '@/server/auth/password'
import { signJWT } from '@/server/auth/jwt'
import { getClientIp } from '@/server/utils/ip'
import { consumeRateLimit, resetRateLimit } from '@/server/middleware/rate-limit'
import { z } from 'zod'

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
})

const RATE_WINDOW_MS = 15 * 60 * 1000 // 15 分钟窗口
const MAX_ATTEMPTS_PER_IP = 60
const MAX_ATTEMPTS_PER_USER = 10
const MAX_ATTEMPTS_PER_IP_USER = 5

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { username, password } = loginSchema.parse(body)

    const ip = getClientIp(req)
    const normalizedUsername = username.toLowerCase()

    // 限流检查（先于凭据校验，保护 bcrypt 计算成本）
    const ipKey = ip ? `login:ip:${ip}` : null
    const userKey = `login:user:${normalizedUsername}`
    const ipUserKey = ip ? `login:ip-user:${ip}:${normalizedUsername}` : null

    const checks: Array<{ key: string | null; limit: number }> = [
      { key: ipKey, limit: MAX_ATTEMPTS_PER_IP },
      { key: userKey, limit: MAX_ATTEMPTS_PER_USER },
      { key: ipUserKey, limit: MAX_ATTEMPTS_PER_IP_USER },
    ]

    for (const check of checks) {
      if (!check.key) continue
      const result = consumeRateLimit(check.key, check.limit, RATE_WINDOW_MS)
      if (!result.allowed) {
        return NextResponse.json(
          { error: 'Too many login attempts. Please try again later.' },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } }
        )
      }
    }

    const user = await UserRepository.findByUsername(username)
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      )
    }

    const isValid = await verifyPassword(password, user.password as string)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      )
    }

    // 登录成功：释放配额，避免正常用户被误伤
    for (const key of [ipKey, userKey, ipUserKey]) {
      if (key) resetRateLimit(key)
    }

    const token = await signJWT({ userId: user.id })
    const cookieStore = await cookies()

    cookieStore.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0].message },
        { status: 400 }
      )
    }

    console.error('Login error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

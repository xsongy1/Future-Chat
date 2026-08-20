/**
 * JWT 签名和验证
 * 
 * 使用 jose 库（Next.js 推荐）
 * 
 * 密钥策略（安全要求：禁止使用公开默认密钥）：
 * - 生产环境（NODE_ENV=production）：必须配置 JWT_SECRET 且长度 >= 32 字符，
 *   否则在首次使用时抛出明确错误（fail-fast），避免使用弱密钥。
 * - 开发环境：优先使用已配置的 JWT_SECRET（过短时告警）；
 *   未配置时每次启动随机生成一个密钥（重启后旧 auth-token 全部失效）。
 */

import * as jose from 'jose'
import { randomBytes } from 'crypto'

/** 生产环境 JWT_SECRET 最小长度（字节） */
const MIN_SECRET_LENGTH = 32

let cachedSecret: Uint8Array | null = null
let warnedDevFallback = false

/**
 * 获取签名密钥（惰性求值，避免模块加载时因环境变量缺失影响构建）
 */
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret

  const configured = process.env.JWT_SECRET
  const isProduction = process.env.NODE_ENV === 'production'

  let value: string

  if (configured) {
    value = configured
    if (isProduction && value.length < MIN_SECRET_LENGTH) {
      const message =
        `JWT_SECRET 太短（${value.length} 字符），生产环境至少需要 ${MIN_SECRET_LENGTH} 字符。` +
        `请生成强随机密钥，例如：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      console.error(`[jwt] ${message}`)
      throw new Error(message)
    }
    if (value.length < MIN_SECRET_LENGTH) {
      console.warn(
        `[jwt] JWT_SECRET 仅 ${value.length} 字符，建议使用至少 ${MIN_SECRET_LENGTH} 字符的强随机密钥`
      )
    }
  } else if (isProduction) {
    const message =
      '生产环境必须配置 JWT_SECRET 环境变量（至少 32 字符），' +
      '否则任何人都无法伪造/验证 token。生成方式：' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    console.error(`[jwt] ${message}`)
    throw new Error(message)
  } else {
    // 开发环境兜底：随机密钥，每次启动不同，绝不使用可猜测的固定默认值
    value = randomBytes(32).toString('hex')
    if (!warnedDevFallback) {
      warnedDevFallback = true
      console.warn(
        '[jwt] 未配置 JWT_SECRET，已生成随机临时密钥（仅本次进程有效）。' +
          '重启后旧 auth-token 将失效；生产环境请务必配置 JWT_SECRET。'
      )
    }
  }

  cachedSecret = new TextEncoder().encode(value)
  return cachedSecret
}

export interface JWTPayload {
  userId: string
}

/**
 * 签发 JWT Token
 */
export async function signJWT(payload: JWTPayload): Promise<string> {
  return await new jose.SignJWT({ userId: payload.userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(getSecret())
}

/**
 * 验证 JWT Token
 */
export async function verifyJWT(token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jose.jwtVerify(token, getSecret())
    return { userId: payload.userId as string }
  } catch {
    throw new Error('Invalid token')
  }
}

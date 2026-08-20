import { AuditLogRepository, type AuditAction } from '@/server/repositories/audit-log.repository'
import type { Prisma } from '@prisma/client'
import { getClientIp } from '@/server/utils/ip'

interface AuditParams {
  userId: string
  action: AuditAction
  resourceId?: string
  metadata?: Prisma.InputJsonValue
  request?: Request
}

export async function audit(params: AuditParams) {
  const { userId, action, resourceId, metadata, request } = params

  let ipAddress: string | undefined
  let userAgent: string | undefined

  if (request) {
    // 只信任已声明可信代理（TRUST_PROXY）的转发头，详见 server/utils/ip.ts
    ipAddress = getClientIp(request)
    userAgent = request.headers.get('user-agent') || undefined
  }

  await AuditLogRepository.create({
    userId,
    action,
    resourceId,
    metadata,
    ipAddress,
    userAgent,
  })
}

export function createAuditMiddleware(action: AuditAction) {
  return async (userId: string, resourceId?: string, request?: Request) => {
    await audit({
      userId,
      action,
      resourceId,
      request,
    })
  }
}


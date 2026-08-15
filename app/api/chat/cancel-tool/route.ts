/**
 * Cancel Tool API Route
 *
 * 取消正在执行的工具（按 toolCallId 定位）。
 * 工具执行时会在 server/services/tools/cancellation.ts 的全局注册表中登记，
 * 本路由找到对应执行并触发其 AbortSignal，中断 API 调用与下载。
 *
 * 请求体: { toolCallId: string }
 * 响应:   { success: boolean, cancelled: boolean }
 *   - cancelled: true  = 找到了正在执行的工具并已触发取消
 *   - cancelled: false = 该工具已结束或不存在（前端不应再标记为已取消）
 */

import { getCurrentUserId } from '@/server/auth/utils'
import { cancelRunningTool } from '@/server/services/tools/cancellation'

export async function POST(req: Request) {
  // 1. 认证校验
  let userId: string
  try {
    userId = await getCurrentUserId()
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. 解析请求体
  let body: { toolCallId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const toolCallId = body?.toolCallId
  if (typeof toolCallId !== 'string' || !toolCallId.trim()) {
    return Response.json({ error: 'toolCallId is required' }, { status: 400 })
  }

  // 3. 取消工具执行
  const cancelled = cancelRunningTool(toolCallId)
  console.log(`[CancelTool] userId=${userId} toolCallId=${toolCallId} cancelled=${cancelled}`)

  return Response.json({ success: true, cancelled })
}

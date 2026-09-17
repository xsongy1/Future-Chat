/**
 * ID 生成工具
 *
 * 优先使用 crypto.randomUUID（安全、无碰撞），降级到随机字符串。
 */

/** 生成事件 ID */
export function generateEventId(): string {
  return `evt_${randomId()}`
}

/** 生成 Trace ID */
export function generateTraceId(): string {
  return `trc_${randomId()}`
}

/** 生成 Session ID */
export function generateSessionId(): string {
  return `ses_${randomId()}`
}

/** 生成 Tool 调用 ID */
export function generateToolCallId(): string {
  return `tool_${randomId()}`
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  }
  // 降级：时间戳 + 随机数
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 14)
}

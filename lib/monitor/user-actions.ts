/**
 * 用户行为事件辅助模块
 *
 * 埋点 UI 层用户行为（copy / regenerate / stop / retry / edit），
 * 用于计算完成率、中途放弃率、重新生成率、重试率等产品体验指标。
 * 所有方法安全：Monitor 未初始化时静默返回。
 */

'use client'

import { getMonitor } from './index'

/**
 * 记录用户行为事件
 * @param action - 行为名：send_message / stop_generation / retry / edit_message / copy ...
 * @param detail - 附加信息（如 messageId、是否成功）
 */
export function trackUserAction(
  action: string,
  detail?: Record<string, unknown>
): void {
  try {
    const monitor = getMonitor()
    if (!monitor) return
    monitor.track('user_action', { action, ...detail })
  } catch {
    // 静默失败
  }
}

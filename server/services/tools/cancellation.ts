/**
 * 工具执行取消注册表
 *
 * 全局跟踪正在执行的工具，支持通过 /api/chat/cancel-tool 按 toolCallId 取消。
 *
 * 注意：Next.js 会为每个 Route Handler 单独打包，直接使用模块级 Map 可能导致
 * chat 路由与 cancel-tool 路由持有不同的实例，取消永远找不到目标。
 * 因此这里把注册表挂到 globalThis 上，保证同一进程内所有路由共享同一份数据。
 */

interface RunningTool {
  toolCallId: string
  name: string
  controller: AbortController
  startedAt: number
  parentSignal?: AbortSignal
  onParentAbort?: () => void
}

type RunningToolsRegistry = Map<string, RunningTool>

const GLOBAL_KEY = '__skyChatRunningTools__'

function getRegistry(): RunningToolsRegistry {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY] || !(g[GLOBAL_KEY] instanceof Map)) {
    g[GLOBAL_KEY] = new Map<string, RunningTool>()
  }
  return g[GLOBAL_KEY] as RunningToolsRegistry
}

/**
 * 注册一个正在执行的工具
 *
 * @param toolCallId - 工具调用 ID
 * @param name - 工具名称
 * @param parentSignal - 可选：所属流的中断信号（如客户端断开），触发时一并取消该工具
 * @returns 该工具对应的 AbortSignal，工具实现应监听它来中断执行
 */
export function registerRunningTool(
  toolCallId: string,
  name: string,
  parentSignal?: AbortSignal
): AbortSignal {
  // 同名 ID 重复注册时先清理旧的（理论上不会发生）
  unregisterRunningTool(toolCallId)

  const controller = new AbortController()
  let onParentAbort: (() => void) | undefined

  if (parentSignal) {
    if (parentSignal.aborted) {
      // 父信号已中断：立即取消
      controller.abort()
    } else {
      onParentAbort = () => controller.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  getRegistry().set(toolCallId, {
    toolCallId,
    name,
    controller,
    startedAt: Date.now(),
    parentSignal,
    onParentAbort,
  })

  return controller.signal
}

/**
 * 注销工具（工具执行结束或失败时调用）
 */
export function unregisterRunningTool(toolCallId: string): void {
  const registry = getRegistry()
  const running = registry.get(toolCallId)
  if (running) {
    if (running.parentSignal && running.onParentAbort) {
      running.parentSignal.removeEventListener('abort', running.onParentAbort)
    }
    registry.delete(toolCallId)
  }
}

/**
 * 取消一个正在执行的工具
 *
 * @param toolCallId - 工具调用 ID
 * @returns 是否找到了正在执行的工具并触发了取消
 */
export function cancelRunningTool(toolCallId: string): boolean {
  const running = getRegistry().get(toolCallId)
  if (!running) return false
  running.controller.abort()
  return true
}

/**
 * 当前正在执行的工具数量（调试用）
 */
export function getRunningToolCount(): number {
  return getRegistry().size
}

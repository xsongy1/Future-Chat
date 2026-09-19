/**
 * 时间基准与浏览器网络时序读数
 *
 * 流式指标（TTFB / First Chunk Latency / TTFT / TTLB）必须落在同一个时间基准上，
 * 否则彼此不可比。本模块统一这个基准：
 *
 * - **T0 = 请求真正发出的时刻**（宿主在 fetch 前调用 trace.markRequestStart()）
 * - **所有指标 = 事件时刻 - T0**，单位为毫秒，向下取整前的原始浮点值
 *
 * 时钟选择：优先 performance.now()（单调、高精度、不受系统对时影响），
 * 不可用时退回 Date.now()。两者都只用于求差，因此不会与墙钟混用。
 *
 * Resource Timing 用于把 TTFB 从"主线程观测到的响应头时刻"校准为
 * "浏览器网络层记录的 responseStart"：因为 responseStart 与 entry.startTime
 * 都相对 timeOrigin，它们相减得到的时延与宿主的时钟域无关，可以安全使用。
 */

/** 时间源：返回毫秒 */
export type Clock = () => number

/** 当前环境是否具备高精度单调时钟（Resource Timing 校准的前提） */
export function hasHighResClock(): boolean {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
}

/** 默认时间源：performance.now 优先，回退 Date.now */
export const defaultClock: Clock = () =>
  hasHighResClock() ? performance.now() : Date.now()

/** Resource Timing 条目中我们需要的字段 */
export interface ResourceTimingSample {
  /** 资源 URL（绝对地址） */
  name: string
  /** 请求开始（相对 timeOrigin） */
  startTime: number
  /** 首个响应字节（相对 timeOrigin） */
  responseStart: number
}

/** 条目来源：默认读 performance.getEntriesByType('resource')，测试可注入 */
export type ResourceEntrySource = () => ResourceTimingSample[]

export interface ResourceTtfbOptions {
  /** T0（与 Resource Timing 同一时基时才用于过滤出本次请求的条目） */
  requestStart?: number
  /** 条目来源（默认浏览器 Resource Timing） */
  source?: ResourceEntrySource
}

/** 默认条目来源：浏览器 Resource Timing（Node / 旧环境返回空数组） */
export const browserResourceEntries: ResourceEntrySource = () => {
  if (
    typeof performance === 'undefined' ||
    typeof performance.getEntriesByType !== 'function'
  ) {
    return []
  }
  return performance.getEntriesByType('resource') as unknown as ResourceTimingSample[]
}

/**
 * 读取"浏览器测得的 TTFB"（请求发出 → 首个响应字节）
 *
 * 与宿主的时钟域无关：返回值来自条目内部的 responseStart - startTime。
 *
 * @returns 毫秒；无法确定时返回 null（无 API / 无匹配条目 / 跨域被 TAO 屏蔽 / 条目来自别的请求）
 */
export function readResourceTtfb(
  url: string,
  options: ResourceTtfbOptions = {}
): number | null {
  const { requestStart, source = browserResourceEntries } = options

  let entries: ResourceTimingSample[]
  try {
    entries = source()
  } catch {
    return null
  }
  if (!entries || entries.length === 0) return null

  const target = resourcePath(url)
  let best: ResourceTimingSample | null = null

  for (const entry of entries) {
    if (!entry) continue
    const { name, startTime, responseStart } = entry
    if (typeof startTime !== 'number' || typeof responseStart !== 'number') continue
    if (resourcePath(name) !== target) continue
    // responseStart 为 0 表示跨域且未带 Timing-Allow-Origin，读数不可用
    if (!(responseStart > 0) || responseStart < startTime) continue
    // 同一 URL 可能有多条（重试 / 多轮工具调用）：必须晚于本次 T0，取最近的一条
    if (requestStart !== undefined && startTime < requestStart - 1) continue

    if (!best || startTime > best.startTime) best = entry
  }

  if (!best) return null
  return best.responseStart - best.startTime
}

/**
 * 取出 URL 的路径部分，用于把相对路径与 Resource Timing 的绝对地址对齐
 * （`/api/chat?v=1` 与 `http://host/api/chat` 视为同一个资源）
 */
export function resourcePath(url: string): string {
  if (!url) return ''
  try {
    return new URL(url, resolveBase()).pathname
  } catch {
    return url.split(/[?#]/)[0]
  }
}

function resolveBase(): string {
  if (typeof location !== 'undefined' && location.href) return location.href
  // Node / 无 location 环境：相对路径直接按路径解析
  return 'http://localhost/'
}

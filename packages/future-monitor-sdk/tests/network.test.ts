/**
 * NetworkPlugin 单测：URL 过滤（含 g flag 正则的 lastIndex 状态问题）
 */

import { describe, it, expect } from 'vitest'
import { NetworkPlugin } from '../src/plugins/network'

type ShouldCapture = (url: string) => boolean

function getShouldCapture(options: ConstructorParameters<typeof NetworkPlugin>[0]): ShouldCapture {
  const plugin = new NetworkPlugin(options)
  return (plugin as unknown as { shouldCapture: ShouldCapture }).shouldCapture.bind(plugin)
}

describe('NetworkPlugin URL 过滤', () => {
  it('excludeUrls 排除匹配的 URL', () => {
    const shouldCapture = getShouldCapture({ excludeUrls: [/\/api\/monitor/, /\/api\/chat/] })

    expect(shouldCapture('/api/monitor')).toBe(false)
    expect(shouldCapture('/api/chat')).toBe(false)
    expect(shouldCapture('/api/other')).toBe(true)
  })

  it('includeUrls 只放行匹配的 URL', () => {
    const shouldCapture = getShouldCapture({ includeUrls: [/\/api\//] })

    expect(shouldCapture('/api/chat')).toBe(true)
    expect(shouldCapture('/static/app.js')).toBe(false)
  })

  it('带 g flag 的正则不会因 lastIndex 状态残留而间歇性失效', () => {
    const shouldCapture = getShouldCapture({ includeUrls: [/\/api\//g], excludeUrls: [/\/health/g] })

    // 连续多次调用结果必须稳定（经典 lastIndex bug：第二次调用返回 false）
    expect(shouldCapture('/api/chat')).toBe(true)
    expect(shouldCapture('/api/chat')).toBe(true)
    expect(shouldCapture('/api/chat')).toBe(true)
    expect(shouldCapture('/api/health')).toBe(false)
    expect(shouldCapture('/api/health')).toBe(false)
  })
})

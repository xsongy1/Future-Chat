/**
 * 平台抽象层单测：BrowserStorage（localStorage）与 BrowserTransport（fetch）
 *
 * 这两个是 IStorage / ITransport 的浏览器实现，此前只被测过「替身」
 * （transport.test.ts 用的是 MemoryStorage / MockTransport），实现本身没有覆盖。
 * 这里注入最小浏览器替身，验证真正决定上报可靠性的边界：
 * 隐私模式 / 配额超限时能否静默失败、非 2xx 与网络异常是否被判定为失败（而非抛错）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrowserStorage, BrowserTransport } from '../src/core/storage'
import type { MonitorEvent } from '../src/core/types'

function makeEvent(id: string, type = 'js_error'): MonitorEvent {
  return { id, type, timestamp: 1_700_000_000_000, data: {}, context: { appId: 'test-app' } }
}

/** 最小 localStorage 替身，可编程抛错（隐私模式 / 配额超限） */
class FakeLocalStorage {
  private map = new Map<string, string>()
  failMode: 'none' | 'read' | 'write' = 'none'

  private guard(op: 'read' | 'write'): void {
    if (this.failMode === op) {
      throw new Error(op === 'read' ? 'SecurityError' : 'QuotaExceededError')
    }
  }

  getItem(key: string): string | null {
    this.guard('read')
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.guard('write')
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.guard('write')
    this.map.delete(key)
  }
}

let fakeStorage: FakeLocalStorage
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage
const originalFetch = (globalThis as { fetch?: unknown }).fetch
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fakeStorage = new FakeLocalStorage()
  ;(globalThis as { localStorage?: unknown }).localStorage = fakeStorage
  fetchMock = vi.fn()
  ;(globalThis as { fetch?: unknown }).fetch = fetchMock
})

afterEach(() => {
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: unknown }).localStorage
  } else {
    ;(globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage
  }
  ;(globalThis as { fetch?: unknown }).fetch = originalFetch
  vi.restoreAllMocks()
})

describe('BrowserStorage', () => {
  it('读写与删除往返正常', () => {
    const storage = new BrowserStorage()

    expect(storage.get('missing')).toBeNull()

    storage.set('future-monitor-sdk:test', '{"ok":true}')
    expect(storage.get('future-monitor-sdk:test')).toBe('{"ok":true}')

    storage.remove('future-monitor-sdk:test')
    expect(storage.get('future-monitor-sdk:test')).toBeNull()
  })

  it('隐私模式读取抛错时静默返回 null（不向上抛）', () => {
    const storage = new BrowserStorage()
    fakeStorage.failMode = 'read'

    expect(() => storage.get('any')).not.toThrow()
    expect(storage.get('any')).toBeNull()
  })

  it('配额超限写入抛错时静默失败（不向上抛）', () => {
    const storage = new BrowserStorage()
    fakeStorage.failMode = 'write'

    expect(() => storage.set('any', 'value')).not.toThrow()
    expect(storage.get('any')).toBeNull()
  })

  it('删除抛错时静默失败（不向上抛）', () => {
    const storage = new BrowserStorage()
    storage.set('any', 'value')
    fakeStorage.failMode = 'write'

    expect(() => storage.remove('any')).not.toThrow()
  })
})

describe('BrowserTransport', () => {
  it('批量上报：POST + JSON body + keepalive + 默认 Content-Type', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const transport = new BrowserTransport({ endpoint: '/api/monitor' })

    const ok = await transport.send([makeEvent('evt_1'), makeEvent('evt_2')])

    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/monitor')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true) // 页面卸载时也能发出
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body).map((e: MonitorEvent) => e.id)).toEqual(['evt_1', 'evt_2'])
  })

  it('非 2xx 响应判定为失败（返回 false，不抛错）', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const transport = new BrowserTransport({ endpoint: '/api/monitor' })

    await expect(transport.send([makeEvent('evt_1')])).resolves.toBe(false)
  })

  it('网络异常（fetch reject）判定为失败（返回 false，不抛错）', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const transport = new BrowserTransport({ endpoint: '/api/monitor' })

    await expect(transport.send([makeEvent('evt_1')])).resolves.toBe(false)
  })

  it('自定义 headers 与默认头合并', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const transport = new BrowserTransport({
      endpoint: '/api/monitor',
      headers: { 'X-App-Id': 'future-chat' },
    })

    await transport.send([makeEvent('evt_1')])

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-App-Id': 'future-chat',
    })
  })
})

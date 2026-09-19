/**
 * ErrorPlugin 单测：四类错误采集 / 忽略规则 / 窗口内快速去重 / console 劫持与还原
 *
 * ErrorPlugin.setup() 只在浏览器环境挂监听（typeof window === 'undefined' 直接 return），
 * 所以这里注入一个最小 window 替身：既能记录监听器、又能精确派发事件，
 * 比 jsdom 更可控（可以显式构造 ErrorEvent / 资源 target / defaultPrevented，并区分
 * 「冒泡」与「不冒泡的捕获阶段」两种派发方式）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Monitor } from '../src/core/monitor'
import { ErrorPlugin } from '../src/plugins/error'
import type { Plugin, MonitorEvent } from '../src/core/types'

/** 收集事件的测试插件 */
class CollectorPlugin implements Plugin {
  name = 'collector'
  priority = -1
  events: MonitorEvent[] = []

  processEvent(event: MonitorEvent): MonitorEvent | null {
    this.events.push(event)
    return event
  }
}

type Listener = (event: unknown) => void
type ListenerOptions = boolean | { capture?: boolean } | undefined

function isCapture(options: ListenerOptions): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true
}

/**
 * 最小 window 替身
 *
 * 关键点：真实浏览器里资源错误「不冒泡」，只有捕获阶段监听器能收到；
 * 而 window 自身作为 target 的错误，捕获与非捕获监听器都会触发。
 * 两种派发方式分开建模，才能验证 ErrorPlugin 的 `event.target === window` 守卫。
 */
class FakeWindow {
  location = { href: 'https://future-chat.test/chat' }
  private listeners: Array<{ type: string; listener: Listener; capture: boolean }> = []

  addEventListener(type: string, listener: Listener, options?: ListenerOptions): void {
    this.listeners.push({ type, listener, capture: isCapture(options) })
  }

  removeEventListener(type: string, listener: Listener, options?: ListenerOptions): void {
    const capture = isCapture(options)
    const index = this.listeners.findIndex(
      (l) => l.type === type && l.listener === listener && l.capture === capture
    )
    if (index >= 0) this.listeners.splice(index, 1)
  }

  /** window 自身作为 target：捕获与非捕获监听器都触发 */
  dispatchAtTarget(type: string, event: unknown): void {
    for (const l of [...this.listeners]) {
      if (l.type === type) l.listener(event)
    }
  }

  /** 元素上的不冒泡事件：只有捕获阶段监听器收得到 */
  dispatchNonBubbling(type: string, event: unknown): void {
    for (const l of [...this.listeners]) {
      if (l.type === type && l.capture) l.listener(event)
    }
  }

  listenerCount(type: string): number {
    return this.listeners.filter((l) => l.type === type).length
  }
}

let fakeWindow: FakeWindow
const originalWindow = (globalThis as { window?: unknown }).window

function windowErrorEvent(message: string, overrides: Record<string, unknown> = {}) {
  return {
    defaultPrevented: false,
    message,
    filename: 'https://future-chat.test/app.js',
    lineno: 10,
    colno: 5,
    error: new Error(message),
    target: fakeWindow,
    ...overrides,
  }
}

function setup(options: ConstructorParameters<typeof ErrorPlugin>[0] = {}) {
  const monitor = new Monitor({ appId: 'test-app' })
  const collector = new CollectorPlugin()
  const plugin = new ErrorPlugin(options)
  monitor.use(plugin)
  monitor.use(collector)
  return { monitor, collector, plugin }
}

beforeEach(() => {
  vi.useFakeTimers()
  fakeWindow = new FakeWindow()
  ;(globalThis as { window?: unknown }).window = fakeWindow
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window
  } else {
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

describe('ErrorPlugin 自动采集', () => {
  it('window error 采集为 js_error，含 message/filename/行列号/stack/页面 url', () => {
    const { collector } = setup()

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('Cannot read properties of undefined'))

    expect(collector.events).toHaveLength(1)
    const event = collector.events[0]
    expect(event.type).toBe('js_error')
    expect(event.data).toMatchObject({
      message: 'Cannot read properties of undefined',
      filename: 'https://future-chat.test/app.js',
      lineno: 10,
      colno: 5,
      url: 'https://future-chat.test/chat',
    })
    expect(String(event.data.stack)).toContain('Cannot read properties of undefined')
  })

  it('defaultPrevented 的错误不采集（尊重宿主已有的处理）', () => {
    const { collector } = setup()

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('handled', { defaultPrevented: true }))

    expect(collector.events).toHaveLength(0)
  })

  it('unhandledrejection 采集为 promise_error（Error 与字符串 reason 都支持）', () => {
    const { collector } = setup()

    fakeWindow.dispatchAtTarget('unhandledrejection', { reason: new Error('fetch failed') })
    fakeWindow.dispatchAtTarget('unhandledrejection', { reason: 'plain rejection' })

    expect(collector.events.map((e) => e.type)).toEqual(['promise_error', 'promise_error'])
    expect(collector.events[0].data.message).toBe('fetch failed')
    expect(String(collector.events[0].data.stack)).toContain('fetch failed')
    expect(collector.events[1].data.message).toBe('plain rejection')
    expect(collector.events[1].data.stack).toBeUndefined()
  })

  it('资源加载失败采集为 resource_error（不冒泡，仅捕获监听器收到）', () => {
    const { collector } = setup()

    fakeWindow.dispatchNonBubbling('error', {
      target: { tagName: 'IMG', src: 'https://cdn.test/hero.png' },
    })

    expect(collector.events).toHaveLength(1)
    expect(collector.events[0].type).toBe('resource_error')
    expect(collector.events[0].data).toMatchObject({
      tag: 'img',
      url: 'https://cdn.test/hero.png',
      message: '资源加载失败: img https://cdn.test/hero.png',
    })
  })

  it('窗口级运行时错误不会被资源处理器重复上报（target === window 守卫）', () => {
    const { collector } = setup()

    // 同一次派发会同时进入 handleError 与 handleResourceError：
    // 后者必须被守卫拦下，否则同一错误会产生 js_error + resource_error 两条
    fakeWindow.dispatchAtTarget('error', windowErrorEvent('boom'))

    expect(collector.events).toHaveLength(1)
    expect(collector.events[0].type).toBe('js_error')
  })
})

describe('ErrorPlugin 忽略规则', () => {
  it('ignoreErrors 命中的错误不上报，未命中的照常上报', () => {
    const { collector } = setup({ ignoreErrors: [/ResizeObserver/] })

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('ResizeObserver loop limit exceeded'))
    fakeWindow.dispatchAtTarget('error', windowErrorEvent('real bug'))

    expect(collector.events).toHaveLength(1)
    expect(collector.events[0].data.message).toBe('real bug')
  })

  it('ignoreUrls 命中的来源不上报（按 filename 匹配）', () => {
    const { collector } = setup({ ignoreUrls: [/^chrome-extension:\/\//] })

    fakeWindow.dispatchAtTarget(
      'error',
      windowErrorEvent('noise', { filename: 'chrome-extension://abc/inject.js' })
    )

    expect(collector.events).toHaveLength(0)
  })
})

describe('ErrorPlugin 窗口内快速去重', () => {
  it('窗口内相同错误只上报第一条，不同错误不受影响', () => {
    const { collector } = setup({ dedupeWindow: 2000 })

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('boom'))
    fakeWindow.dispatchAtTarget('error', windowErrorEvent('boom'))
    fakeWindow.dispatchAtTarget('error', windowErrorEvent('other'))

    expect(collector.events.map((e) => e.data.message)).toEqual(['boom', 'other'])
  })

  it('窗口过期后相同错误可再次上报', async () => {
    const { collector } = setup({ dedupeWindow: 2000 })

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('boom'))
    await vi.advanceTimersByTimeAsync(2000)
    fakeWindow.dispatchAtTarget('error', windowErrorEvent('boom'))

    expect(collector.events).toHaveLength(2)
  })

  it('不同类型但 message 相同的错误不会互相去重（key 含 type）', () => {
    const { collector } = setup({ dedupeWindow: 2000 })

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('same text'))
    fakeWindow.dispatchAtTarget('unhandledrejection', { reason: new Error('same text') })

    expect(collector.events.map((e) => e.type)).toEqual(['js_error', 'promise_error'])
  })
})

describe('ErrorPlugin console 采集与生命周期', () => {
  it('captureConsoleError 开启时劫持 console.error 上报并透传原始输出', () => {
    const original = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { collector } = setup({ captureConsoleError: true })

    console.error('db down', 500)

    expect(original).toHaveBeenCalledWith('db down', 500)
    const events = collector.events.filter((e) => e.type === 'console_error')
    expect(events).toHaveLength(1)
    expect(events[0].data.message).toBe('db down 500')
    expect(typeof events[0].data.stack).toBe('string')
  })

  it('默认不采集 console.error', () => {
    const original = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { collector } = setup()

    console.error('noise')

    expect(original).toHaveBeenCalled()
    expect(collector.events).toHaveLength(0)
  })

  it('reset() 卸载全部监听器并还原 console.error', () => {
    const original = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { collector, plugin } = setup({ captureConsoleError: true })

    expect(fakeWindow.listenerCount('error')).toBe(2) // 冒泡 + 捕获
    expect(fakeWindow.listenerCount('unhandledrejection')).toBe(1)

    plugin.reset()

    expect(fakeWindow.listenerCount('error')).toBe(0)
    expect(fakeWindow.listenerCount('unhandledrejection')).toBe(0)
    expect(console.error).toBe(original) // 已还原为被劫持前的实现

    fakeWindow.dispatchAtTarget('error', windowErrorEvent('after reset'))
    console.error('after reset')
    expect(collector.events).toHaveLength(0)
  })

  it('非浏览器环境下 setup 安全早退（不挂监听、不抛错）', () => {
    delete (globalThis as { window?: unknown }).window
    const monitor = new Monitor({ appId: 'test-app' })
    const collector = new CollectorPlugin()

    expect(() => {
      monitor.use(new ErrorPlugin())
      monitor.use(collector)
    }).not.toThrow()
    expect(collector.events).toHaveLength(0)
  })
})

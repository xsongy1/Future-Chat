/**
 * 埋点辅助模块单测
 *
 * 这里只测与 SDK 无关的纯逻辑（错误分类）。其余函数都是 Monitor 的薄封装，
 * 未初始化时静默返回，行为由 SDK 的测试覆盖。
 */

import { describe, it, expect } from 'vitest'
import { classifyStreamError } from '../trace-helper'

describe('classifyStreamError', () => {
  it('fetch 网络失败（TypeError 且无 status）→ NETWORK_ERROR 且可重试', () => {
    const error = new TypeError('Failed to fetch')

    expect(classifyStreamError(error)).toEqual({
      code: 'NETWORK_ERROR',
      message: 'Failed to fetch',
      statusCode: undefined,
      retryable: true,
    })
  })

  it('HTTP 状态码保留下来，交给 Trace 按码分类', () => {
    const error = Object.assign(new Error('API error: 429'), { status: 429 })

    expect(classifyStreamError(error)).toMatchObject({
      code: undefined,
      statusCode: 429,
      retryable: true,
    })
  })

  it('503 可重试，400 不可重试', () => {
    expect(
      classifyStreamError(Object.assign(new Error('unavailable'), { status: 503 })).retryable
    ).toBe(true)
    expect(
      classifyStreamError(Object.assign(new Error('bad request'), { status: 400 })).retryable
    ).toBe(false)
  })

  it('普通错误（无 status、非 TypeError）不可重试，也不硬编码错误码', () => {
    const result = classifyStreamError(new Error('No reader'))

    expect(result.code).toBeUndefined()
    expect(result.statusCode).toBeUndefined()
    expect(result.retryable).toBe(false)
    expect(result.message).toBe('No reader')
  })

  it('非 Error 输入不抛错（message 兜底）', () => {
    expect(classifyStreamError(undefined)).toMatchObject({
      message: 'Unknown error',
      retryable: false,
    })
    expect(classifyStreamError('boom')).toMatchObject({ message: 'Unknown error' })
  })
})

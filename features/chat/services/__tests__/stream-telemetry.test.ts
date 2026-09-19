/**
 * StreamTelemetry 单测
 *
 * 覆盖"协议帧 → 指标打点"的映射，以及本次改动里最容易出错的两处：
 * 1. 结束流程的幂等：complete 事件 + 解析器兜底回调 + 流关闭三者只结束一次 Trace
 * 2. 结束时机：收到 complete 帧只收尾阶段，Trace 要等流真正关闭才结束（TTLB = 末字节）
 *
 * trace-helper 被打桩，所以这里只验证"在什么时刻调了什么方法"，不重复验证 SDK 的公式
 * （公式由 packages/future-monitor-sdk/tests/trace.test.ts 覆盖）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const helper = vi.hoisted(() => ({
  recordChunk: vi.fn(),
  recordRawChunk: vi.fn(),
  recordFirstToken: vi.fn(),
  startPhase: vi.fn(),
  endPhase: vi.fn(),
  endTrace: vi.fn(),
  startToolWithId: vi.fn(),
  endTool: vi.fn(),
  setTraceUsage: vi.fn(),
}))

vi.mock('@/lib/monitor/trace-helper', () => helper)

import { StreamTelemetry } from '../stream-telemetry'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StreamTelemetry 打点映射', () => {
  it('数据块 → First Chunk Latency，SSE 事件 → 事件计数（两条路径分开）', () => {
    const telemetry = new StreamTelemetry()

    telemetry.onRawChunk(64)
    telemetry.onRawChunk(128)
    telemetry.onChunk()
    telemetry.onChunk()
    telemetry.onChunk()

    expect(helper.recordRawChunk).toHaveBeenCalledTimes(2)
    expect(helper.recordRawChunk).toHaveBeenNthCalledWith(1, 64)
    expect(helper.recordRawChunk).toHaveBeenNthCalledWith(2, 128)
    expect(helper.recordChunk).toHaveBeenCalledTimes(3)
  })

  it('带内容的增量帧 → TTFT（阶段透传下去，由 Trace 决定 TTFA）', () => {
    const telemetry = new StreamTelemetry()

    telemetry.onToken('thinking')
    telemetry.onToken('answer')

    expect(helper.recordFirstToken).toHaveBeenNthCalledWith(1, 'thinking')
    expect(helper.recordFirstToken).toHaveBeenNthCalledWith(2, 'answer')
  })

  it('阶段切换：只结束上一个阶段，不重复结束同一个阶段', () => {
    const telemetry = new StreamTelemetry()

    telemetry.onPhaseChange('thinking')
    telemetry.onPhaseChange('thinking') // 同阶段：不结束
    telemetry.onPhaseChange('answer') // 切换：结束 thinking

    expect(helper.startPhase).toHaveBeenCalledTimes(3)
    expect(helper.endPhase).toHaveBeenCalledTimes(1)
    expect(helper.endPhase).toHaveBeenCalledWith('thinking')

    telemetry.onStreamEnd()
    expect(helper.endPhase).toHaveBeenCalledTimes(2)
    expect(helper.endPhase).toHaveBeenLastCalledWith('answer')
  })
})

describe('StreamTelemetry 结束流程', () => {
  it('收到 complete 帧只收尾阶段，不结束 Trace（TTLB 要等末字节）', () => {
    const telemetry = new StreamTelemetry()
    telemetry.onPhaseChange('answer')

    telemetry.onStreamEnd()

    expect(helper.endPhase).toHaveBeenCalledWith('answer')
    expect(helper.endTrace).not.toHaveBeenCalled()
  })

  it('流关闭时结束 Trace，且只结束一次', () => {
    const telemetry = new StreamTelemetry()

    telemetry.onStreamClosed()
    telemetry.onStreamClosed()

    expect(helper.endTrace).toHaveBeenCalledTimes(1)
    expect(helper.endTrace).toHaveBeenCalledWith('complete', undefined)
  })

  it('complete 帧 + 兜底回调 + 流关闭三者叠加也只结束一次', () => {
    const telemetry = new StreamTelemetry()

    telemetry.onStreamEnd() // complete 帧
    telemetry.onStreamEnd() // 解析器兜底回调
    telemetry.onStreamClosed() // 流真正关闭

    expect(helper.endTrace).toHaveBeenCalledTimes(1)
    expect(helper.endTrace).toHaveBeenCalledWith('complete', undefined)
  })

  it('出错之后不再补发 complete', () => {
    const telemetry = new StreamTelemetry()

    telemetry.finish('error', 'stream broke')
    telemetry.onStreamClosed()

    expect(helper.endTrace).toHaveBeenCalledTimes(1)
    expect(helper.endTrace).toHaveBeenCalledWith('error', 'stream broke')
  })

  it('结构化错误原样传给 endTrace（中途出错不丢 statusCode / retryable）', () => {
    const telemetry = new StreamTelemetry()

    telemetry.finish('error', {
      code: 'NETWORK_ERROR',
      message: 'network error',
      retryable: true,
    })

    expect(helper.endTrace).toHaveBeenCalledWith('error', {
      code: 'NETWORK_ERROR',
      message: 'network error',
      retryable: true,
    })
  })

  it('中断（AbortError 通道）以 abort 结束，不记成正常完成', () => {
    const telemetry = new StreamTelemetry()
    telemetry.onPhaseChange('answer')

    telemetry.finish('abort', 'stream_aborted')
    telemetry.onStreamClosed()

    expect(helper.endPhase).toHaveBeenCalledWith('answer')
    expect(helper.endTrace).toHaveBeenCalledTimes(1)
    expect(helper.endTrace).toHaveBeenCalledWith('abort', 'stream_aborted')
  })

  it('用户中止（外部已结束 Trace）时不会补发 complete', () => {
    const telemetry = new StreamTelemetry()

    telemetry.finish('abort', 'user_cancel')
    telemetry.onStreamClosed()

    expect(helper.endTrace).toHaveBeenCalledTimes(1)
    expect(helper.endTrace).toHaveBeenCalledWith('abort', 'user_cancel')
  })
})

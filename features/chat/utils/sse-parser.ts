/**
 * SSE 消息解析器
 *
 * 职责：
 * 1. 解析 SSE 流
 * 2. 区分 thinking / answer / tool_calls
 * 3. 返回标准化的数据
 */

import type { SSEData } from '@/features/chat/types/chat'
import { parseSSELine, splitSSEBuffer } from '@/shared/utils/sse'

export interface SSECallbacks {
  onData: (data: SSEData) => void
  /**
   * 网络层数据块到达（每次 read() 拿到字节调用一次，早于解码与解析）
   *
   * 用于记录 First Chunk Latency：这是"第一个数据块到达"的最早可观测时刻，
   * 比"第一个 SSE 事件解析完成"更接近真实到达时间（首个数据块可能只含半条 SSE 帧）。
   */
  onChunk?: (bytes: number) => void
  /**
   * 流被中断（AbortError：用户点停止 / 浏览器取消请求）
   *
   * 单独开一条通道是因为"中断"与"正常读完"是两种结局：
   * 都由 onComplete 收尾的话，Trace 会把用户中止记成正常完成。
   * 未提供时回退到 onComplete，保持向后兼容。
   */
  onAbort?: () => void
  onError?: (error: Error) => void
  onComplete?: () => void
}

export class SSEParser {
  /**
   * 解析单行 SSE 数据
   */
  static parseLine(line: string): SSEData | null {
    if (line.startsWith('data: ') && line.slice(6).trim() === '[DONE]') {
      return { type: 'complete' }
    }

    const data = parseSSELine(line)
    if (!data) return null

    try {
      return JSON.parse(data) as SSEData
    } catch (error) {
      console.error('[SSEParser] Failed to parse SSE data:', data, error)
      return null
    }
  }

  /**
   * 处理 SSE 流，使用回调函数
   */
  static async parseStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: SSECallbacks
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          if (buffer.trim()) {
            const { lines } = splitSSEBuffer(buffer + '\n')
            for (const line of lines) {
              const parsed = SSEParser.parseLine(line)
              if (parsed) callbacks.onData(parsed)
            }
          }
          callbacks.onComplete?.()
          return
        }

        // 数据块到达：先记时延（First Chunk Latency），再做解码/解析
        callbacks.onChunk?.(value.byteLength)

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk

        const { lines, remaining } = splitSSEBuffer(buffer)
        buffer = remaining

        for (const line of lines) {
          const parsed = SSEParser.parseLine(line)
          if (parsed) callbacks.onData(parsed)
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        // 中断：交给 onAbort（未提供时回退 onComplete，保持旧行为）
        if (callbacks.onAbort) callbacks.onAbort()
        else callbacks.onComplete?.()
        return
      }
      callbacks.onError?.(error as Error)
      throw error
    }
  }
}

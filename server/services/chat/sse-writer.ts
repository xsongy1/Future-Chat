/**
 * SSE 事件写入器
 */

import type { ToolCall } from '@/server/services/tools'

/**
 * SSE 事件写入器
 */
export class SSEWriter {
  private _controller: ReadableStreamDefaultController
  private _encoder: TextEncoder
  private _sessionId: string
  private _closed = false

  constructor(controller: ReadableStreamDefaultController, encoder: TextEncoder, sessionId: string) {
    this._controller = controller
    this._encoder = encoder
    this._sessionId = sessionId
  }

  private _send(data: Record<string, unknown>): void {
    if (this._closed) return
    try {
      this._controller.enqueue(this._encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
    } catch {
      this._closed = true
    }
  }

  sendThinking(content: string): void {
    this._send({ type: 'thinking', content, sessionId: this._sessionId })
  }

  sendAnswer(content: string): void {
    this._send({ type: 'answer', content, sessionId: this._sessionId })
  }

  sendToolCall(tc: ToolCall): void {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(tc.function.arguments) } catch { /* ignore */ }

    const event: Record<string, unknown> = {
      type: 'tool_call',
      toolCallId: tc.id,
      name: tc.function.name,
      sessionId: this._sessionId,
    }

    // 复用同一个 query 字段：web_search 与 knowledge_search 都有一个自然语言 query，
    // 前端「搜索中…」/「正在查询知识库…」都读它
    if (tc.function.name === 'web_search' || tc.function.name === 'knowledge_search') {
      event.query = args.query
    }
    if (tc.function.name === 'generate_image') event.prompt = args.prompt

    this._send(event)
  }

  sendToolProgress(toolCallId: string, progress: number): void {
    this._send({ type: 'tool_progress', toolCallId, progress, sessionId: this._sessionId })
  }

  sendToolResult(result: { toolCallId: string; name: string; success: boolean; content: string; cancelled?: boolean }): void {
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(result.content) } catch { /* ignore */ }

    const event: Record<string, unknown> = {
      type: 'tool_result',
      toolCallId: result.toolCallId,
      name: result.name,
      success: result.success,
      sessionId: this._sessionId,
    }

    if (result.cancelled) event.cancelled = true

    if (result.name === 'web_search') {
      event.resultCount = parsed.resultCount || 0
      event.sources = parsed.sources || []
    }
    // 知识库来源是「文件」而不是 URL，单列一个字段，避免前端按 URL 解析报错
    if (result.name === 'knowledge_search') {
      event.resultCount = parsed.resultCount || 0
      event.knowledgeSources = parsed.sources || []
      // 检索状态透传：前端据此区分"知识库里没有证据"与"检索失败"，
      // 此前两者在事件里都是 resultCount=0，界面只能说一句含糊的"未找到相关内容"
      event.status = parsed.status
    }
    if (result.name === 'generate_image') {
      event.imageUrl = parsed.url
      event.width = parsed.width
      event.height = parsed.height
    }

    this._send(event)
  }

  sendComplete(): void {
    if (this._closed) return
    this._send({ type: 'complete', sessionId: this._sessionId })
    try { this._controller.enqueue(this._encoder.encode('data: [DONE]\n\n')) } catch { /* ignore */ }
  }

  /** Token 用量透传（来自上游 AI 响应的 usage 字段，供前端监控成本/吞吐） */
  sendUsage(usage: { inputTokens: number; outputTokens: number; totalTokens: number }): void {
    this._send({ type: 'usage', usage, sessionId: this._sessionId })
  }

  close(): void {
    if (this._closed) return
    this._closed = true
    try { this._controller.close() } catch { /* ignore */ }
  }

  error(err: unknown): void {
    if (this._closed) return
    this._closed = true
    try { this._controller.error(err) } catch { /* ignore */ }
  }
}

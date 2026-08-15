/**
 * 工具结果格式化
 *
 * 将工具执行结果转换为发送给 AI 的 tool 消息。
 * （工具调用解析与并行执行已内联到 stream.handler.ts，这里只保留流处理实际使用的格式化逻辑）
 */

import type { ToolCallResult, ToolMessage } from './types'

/**
 * 格式化工具结果为消息
 */
export function formatToolMessage(result: ToolCallResult): ToolMessage {
  let content = result.content

  // 搜索结果：提取 content 字段给 AI
  if (result.name === 'web_search') {
    try {
      const parsed = JSON.parse(result.content)
      content = parsed.content || parsed.error || result.content
    } catch {
      // 不是 JSON，保持原样
    }
  }

  // 图片生成结果：只给 AI 简短消息
  if (result.name === 'generate_image') {
    try {
      const parsed = JSON.parse(result.content)
      if (parsed.error) {
        content = parsed.error
      } else if (parsed.url) {
        content = '图片已生成完成。'
      }
    } catch {
      // 不是 JSON，保持原样
    }
  }

  return {
    role: 'tool',
    tool_call_id: result.toolCallId,
    content,
  }
}

/**
 * 将工具调用结果转换为消息数组
 */
export function formatToolMessages(results: ToolCallResult[]): ToolMessage[] {
  return results.map(formatToolMessage)
}

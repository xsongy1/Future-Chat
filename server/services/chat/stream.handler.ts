/**
 * SSE 流处理器
 *
 * 单一职责：
 * - consumeAIResponse：消费一次上游 AI 响应（decoder/buffer/事件循环），
 *   供基础流与工具流共用，避免两套重复的解析逻辑。
 * - createSSEStream：无工具的基础流（单轮，读完即持久化）。
 * - createSSEStreamWithTools：工具流（多轮：读响应 → 并行执行工具 → 携带工具结果
 *   发起下一轮请求，直至无工具调用或达到轮次上限）。
 */

import { parseSSELine, splitSSEBuffer } from '@/shared/utils/sse'
import { createChatCompletion } from '@/server/services/ai/siliconflow'
import { toolRegistry, type ToolCall } from '@/server/services/tools'
import { formatToolMessages } from '@/server/services/tools/handler'
import { executeImageGeneration } from '@/server/services/tools/image-generation'
import { registerRunningTool, unregisterRunningTool } from '@/server/services/tools/cancellation'
import { SSEWriter } from './sse-writer'
import { persistMessage, processImageResults } from './message-persister'

export interface StreamContext {
  messageId: string
  conversationId: string
  userId: string
  sessionId: string
  /** 客户端断开/取消信号（来自 route handler 的 request.signal） */
  cancelSignal?: AbortSignal
}

type ChatMessage = { role: string; content: string | null; tool_calls?: ToolCall[] }

export interface StreamContextWithTools extends StreamContext {
  apiKey: string
  model: string
  contextMessages: ChatMessage[]
  enableThinking: boolean
  thinkingBudget: number
}

/** 工具执行结果 */
interface ToolExecutionResult {
  toolCallId: string
  name: string
  success: boolean
  cancelled?: boolean
  content: string
}

/** 单次 AI 响应的消费结果 */
interface AIResponseResult {
  thinkingContent: string
  answerContent: string
  toolCalls: ToolCall[]
  toolPromises: Promise<ToolExecutionResult>[]
}

const MAX_TOOL_ROUNDS = 5

/**
 * 消费一次上游 AI 响应流（thinking/answer 事件 + 可选 tool_calls 收集）
 *
 * 基础流（collectTools=false）与工具流（collectTools=true）共用的
 * decoder / buffer / 事件循环核心。
 */
async function consumeAIResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: SSEWriter,
  cancelSignal: AbortSignal | undefined,
  collectTools: boolean
): Promise<AIResponseResult> {
  const decoder = new TextDecoder()
  let buffer = ''
  let thinkingContent = ''
  let answerContent = ''
  const toolCallsChunks: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> = []
  const toolPromises: Promise<ToolExecutionResult>[] = []
  const startedTools = new Set<string>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const { lines, remaining } = splitSSEBuffer(buffer)
    buffer = remaining

    for (const line of lines) {
      const data = parseSSELine(line)
      if (!data) continue

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta

        // thinking
        if (delta?.reasoning_content) {
          thinkingContent += delta.reasoning_content
          writer.sendThinking(delta.reasoning_content)
        }

        // answer
        if (delta?.content) {
          answerContent += delta.content
          writer.sendAnswer(delta.content)
        }

        // tool_calls（流式收集；仅工具流需要）
        if (collectTools && delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            if (!toolCallsChunks[idx]) toolCallsChunks[idx] = { index: idx }
            if (tc.id) toolCallsChunks[idx].id = tc.id
            if (tc.function) {
              if (!toolCallsChunks[idx].function) toolCallsChunks[idx].function = {}
              if (tc.function.name) toolCallsChunks[idx].function!.name = tc.function.name
              if (tc.function.arguments) {
                toolCallsChunks[idx].function!.arguments =
                  (toolCallsChunks[idx].function!.arguments || '') + tc.function.arguments
              }
            }

            // 检查是否可以启动工具（有完整的 id、name 和有效的 JSON arguments）
            const chunk = toolCallsChunks[idx]
            if (chunk.id && chunk.function?.name && !startedTools.has(chunk.id)) {
              // 尝试解析 arguments，如果是完整的 JSON 就启动
              const args = chunk.function.arguments || ''
              if (isCompleteJSON(args)) {
                startedTools.add(chunk.id)
                const toolCall: ToolCall = {
                  id: chunk.id,
                  type: 'function',
                  function: { name: chunk.function.name, arguments: args },
                }
                writer.sendToolCall(toolCall)
                console.log(`[Stream] 启动工具: ${chunk.function.name}, args: ${args}`)
                toolPromises.push(startToolExecution(toolCall, writer, cancelSignal))
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 构建完整的 toolCalls
  const toolCalls: ToolCall[] = toolCallsChunks
    .filter(tc => tc.id && tc.function?.name)
    .map(tc => ({
      id: tc.id!,
      type: 'function' as const,
      function: { name: tc.function!.name!, arguments: tc.function!.arguments || '{}' },
    }))

  // 流结束后，启动还没启动的工具（以防 JSON 在最后才完整）
  if (collectTools) {
    for (const tc of toolCalls) {
      if (!startedTools.has(tc.id)) {
        writer.sendToolCall(tc)
        console.log(`[Stream] 延迟启动工具: ${tc.function.name}, args: ${tc.function.arguments}`)
        toolPromises.push(startToolExecution(tc, writer, cancelSignal))
      }
    }
  }

  return { thinkingContent, answerContent, toolCalls, toolPromises }
}

/**
 * 启动工具执行（异步，带进度回调，支持取消）
 */
async function startToolExecution(
  toolCall: ToolCall,
  writer: SSEWriter,
  cancelSignal?: AbortSignal
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(toolCall.function.arguments)
  } catch { /* ignore */ }

  // 注册到取消注册表，/api/chat/cancel-tool 可通过 toolCallId 取消本次执行
  const signal = registerRunningTool(toolCall.id, name, cancelSignal)

  try {
    if (name === 'generate_image') {
      // 图片生成：带进度回调
      const result = await executeImageGeneration(args, (progress) => {
        writer.sendToolProgress(toolCall.id, progress)
      }, signal)

      // 工具在完成前被取消（实现未抛出 AbortError 的情况）
      if (signal.aborted) {
        return {
          toolCallId: toolCall.id,
          name,
          success: false,
          cancelled: true,
          content: JSON.stringify({ error: '工具已取消', cancelled: true }),
        }
      }
      return { toolCallId: toolCall.id, name, success: true, content: JSON.stringify(result) }
    } else {
      // 其他工具：直接执行
      const content = await toolRegistry.executeByName(name, args, signal)

      if (signal.aborted) {
        return {
          toolCallId: toolCall.id,
          name,
          success: false,
          cancelled: true,
          content: JSON.stringify({ error: '工具已取消', cancelled: true }),
        }
      }
      return { toolCallId: toolCall.id, name, success: true, content }
    }
  } catch (error) {
    // 用户取消：不当作失败，标记为 cancelled
    const isCancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError')
    if (isCancelled) {
      console.log(`[Stream] 工具 ${name} 已取消: ${toolCall.id}`)
      return {
        toolCallId: toolCall.id,
        name,
        success: false,
        cancelled: true,
        content: JSON.stringify({ error: '工具已取消', cancelled: true }),
      }
    }
    const msg = error instanceof Error ? error.message : '未知错误'
    console.error(`[Stream] 工具 ${name} 失败:`, msg)
    return { toolCallId: toolCall.id, name, success: false, content: JSON.stringify({ error: msg }) }
  } finally {
    unregisterRunningTool(toolCall.id)
  }
}

function parseJSON(str: string): Record<string, unknown> {
  try { return JSON.parse(str) } catch { return {} }
}

/**
 * 检查字符串是否是完整的 JSON
 */
function isCompleteJSON(str: string): boolean {
  if (!str || str.trim() === '') return false
  try {
    JSON.parse(str)
    return true
  } catch {
    return false
  }
}

/**
 * 创建基础 SSE 流（无工具）
 */
export function createSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  context: StreamContext
): ReadableStream {
  const { messageId, conversationId, userId, sessionId, cancelSignal } = context
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      const writer = new SSEWriter(controller, encoder, sessionId)

      try {
        const { thinkingContent, answerContent } = await consumeAIResponse(reader, writer, cancelSignal, false)

        await persistMessage(messageId, conversationId, userId, { thinkingContent, answerContent, toolCallsData: null })
        writer.sendComplete()
        writer.close()
      } catch (error) {
        // 用户取消导致的 AbortError：静默结束（客户端已断开，前端自行保存了部分内容）
        if (cancelSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          console.log('[Stream] 流被取消（AbortError）')
          return
        }
        writer.error(error)
      }
    },
  })
}

/**
 * 创建支持工具调用的 SSE 流（并行执行）
 */
export function createSSEStreamWithTools(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  context: StreamContextWithTools
): ReadableStream {
  const { messageId, conversationId, userId, sessionId, apiKey, model, contextMessages, enableThinking, thinkingBudget, cancelSignal } = context
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      const writer = new SSEWriter(controller, encoder, sessionId)

      try {
        let thinkingContent = ''
        let finalAnswerContent = ''
        const allToolCalls: ToolCall[] = []
        const allToolResults: Array<{ toolCallId: string; name: string; result: Record<string, unknown> }> = []

        let currentMessages = [...contextMessages]
        let currentReader = reader
        let round = 0

        while (round < MAX_TOOL_ROUNDS) {
          // 客户端已断开/取消：停止继续消费上游流和调用 AI
          if (cancelSignal?.aborted) {
            console.log('[Stream] 用户已取消，终止工具循环')
            break
          }

          round++
          console.log(`[Stream] === 第 ${round} 轮 ===`)

          // 读取 AI 响应，同时启动工具执行
          const { thinkingContent: roundThinking, answerContent: roundAnswer, toolCalls: roundToolCalls, toolPromises } =
            await consumeAIResponse(currentReader, writer, cancelSignal, true)

          thinkingContent += roundThinking
          console.log(`[Stream] AI 返回: answer=${roundAnswer.length}字, tools=${roundToolCalls.length}个`)

          // 没有工具调用，结束
          if (roundToolCalls.length === 0) {
            finalAnswerContent = roundAnswer
            break
          }

          allToolCalls.push(...roundToolCalls)

          // 等待所有工具完成
          console.log('[Stream] 等待工具完成...')
          const toolResults = await Promise.all(toolPromises)
          console.log('[Stream] 工具全部完成')

          // 发送工具结果
          for (const result of toolResults) {
            writer.sendToolResult(result)
            allToolResults.push({
              toolCallId: result.toolCallId,
              name: result.name,
              result: { success: result.success, cancelled: result.cancelled, ...parseJSON(result.content) },
            })
          }

          // 构建下一轮消息
          const toolMessages = formatToolMessages(toolResults)
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: roundAnswer || null, tool_calls: roundToolCalls },
            ...(toolMessages as ChatMessage[]),
          ]

          // 发起下一轮 AI 请求
          console.log('[Stream] 发起下一轮 AI 请求')
          const { reader: nextReader } = await createChatCompletion(apiKey, {
            model,
            messages: currentMessages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
            enableThinking,
            thinkingBudget,
            tools: toolRegistry.getToolDefinitions(),
            signal: cancelSignal,
          })
          currentReader = nextReader
        }

        // 用户取消：不持久化、不发送 complete，直接静默关闭
        if (cancelSignal?.aborted) {
          console.log('[Stream] 用户取消，流结束')
          writer.close()
          return
        }

        // 处理图片结果
        const contentWithImages = processImageResults(finalAnswerContent, allToolCalls, allToolResults)

        // 保存消息
        await persistMessage(messageId, conversationId, userId, {
          thinkingContent,
          answerContent: contentWithImages,
          toolCallsData: allToolCalls.length > 0 ? allToolCalls : null,
          toolResultsData: allToolResults.length > 0 ? allToolResults : null,
        })

        writer.sendComplete()
        writer.close()
        console.log('[Stream] 完成')
      } catch (error) {
        // 用户取消导致的 AbortError：静默结束（客户端已断开，前端自行保存了部分内容）
        if (cancelSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          console.log('[Stream] 流被取消（AbortError）')
          return
        }
        console.error('[Stream] 错误:', error)
        writer.error(error)
      }
    },
  })
}

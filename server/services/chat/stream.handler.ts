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
import { compareEstimatedToActual } from '@/server/services/chat/context'
import {
  toolRegistry,
  type Tool,
  type ToolCall,
  type OpenAIToolDefinition,
  type ToolExecutionContext,
} from '@/server/services/tools'
import { formatToolMessages } from '@/server/services/tools/handler'
import { executeImageGeneration } from '@/server/services/tools/image-generation'
import {
  registerRunningTool,
  unregisterRunningTool,
} from '@/server/services/tools/cancellation'
import { SSEWriter } from './sse-writer'
import { persistMessage, processImageResults } from './message-persister'
import { pickPersistedAnswer } from './round-answer'

export interface StreamContext {
  messageId: string
  conversationId: string
  userId: string
  sessionId: string
  /** 客户端断开/取消信号（来自 route handler 的 request.signal） */
  cancelSignal?: AbortSignal
  /**
   * 构建上下文时的估算输入 token（来自 ContextManager）
   *
   * 只用于把估算值与上游返回的真实 `prompt_tokens` 对照着记一条日志：
   * 估算器是否真的"偏保守"必须用真实数据验证，不能只靠注释声明。
   */
  estimatedInputTokens?: number
}

type ChatMessage = {
  role: string
  content: string | null
  tool_calls?: ToolCall[]
}

export interface StreamContextWithTools extends StreamContext {
  apiKey: string
  model: string
  contextMessages: ChatMessage[]
  enableThinking: boolean
  thinkingBudget: number
  /**
   * 本次请求允许使用的工具（来自 ChatService 依据用户开关算出的 enabledTools）。
   *
   * 这是修复「关闭知识库后仍可能执行 knowledge_search」的关键：
   * 多轮循环里每一轮都用它（而不是整个 ToolRegistry）下发工具，
   * 并在真正执行前再用 allowedToolNames 校验一次工具名。
   */
  allowedTools: Tool[]
  /** 用户选择的知识库 ID（透传给 knowledge_search 收敛检索范围） */
  knowledgeBaseId?: string
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
  /** 上游响应的 Token 用量（OpenAI 兼容 usage 字段） */
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
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
  collectTools: boolean,
  toolContext?: ToolExecutionContext,
  allowedToolNames?: Set<string>
): Promise<AIResponseResult> {
  const decoder = new TextDecoder()
  let buffer = ''
  let thinkingContent = ''
  let answerContent = ''
  let usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null = null
  const toolCallsChunks: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }> = []
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

        // Token 用量（OpenAI 兼容流式响应在末尾 chunk 携带 usage）
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            totalTokens: parsed.usage.total_tokens ?? 0,
          }
        }

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
              if (!toolCallsChunks[idx].function)
                toolCallsChunks[idx].function = {}
              if (tc.function.name)
                toolCallsChunks[idx].function!.name = tc.function.name
              if (tc.function.arguments) {
                toolCallsChunks[idx].function!.arguments =
                  (toolCallsChunks[idx].function!.arguments || '') +
                  tc.function.arguments
              }
            }

            // 检查是否可以启动工具（有完整的 id、name 和有效的 JSON arguments）
            const chunk = toolCallsChunks[idx]
            if (
              chunk.id &&
              chunk.function?.name &&
              !startedTools.has(chunk.id)
            ) {
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
                console.log(
                  `[Stream] 启动工具: ${chunk.function.name}, args: ${args}`
                )
                toolPromises.push(
                  startToolExecution(
                    toolCall,
                    writer,
                    cancelSignal,
                    toolContext,
                    allowedToolNames
                  )
                )
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 构建完整的 toolCalls
  const toolCalls: ToolCall[] = toolCallsChunks
    .filter((tc) => tc.id && tc.function?.name)
    .map((tc) => ({
      id: tc.id!,
      type: 'function' as const,
      function: {
        name: tc.function!.name!,
        arguments: tc.function!.arguments || '{}',
      },
    }))

  // 流结束后，启动还没启动的工具（以防 JSON 在最后才完整）
  if (collectTools) {
    for (const tc of toolCalls) {
      if (!startedTools.has(tc.id)) {
        writer.sendToolCall(tc)
        console.log(
          `[Stream] 延迟启动工具: ${tc.function.name}, args: ${tc.function.arguments}`
        )
        toolPromises.push(
          startToolExecution(
            tc,
            writer,
            cancelSignal,
            toolContext,
            allowedToolNames
          )
        )
      }
    }
  }

  return { thinkingContent, answerContent, toolCalls, toolPromises, usage }
}

/**
 * 启动工具执行（异步，带进度回调，支持取消）
 *
 * @param toolContext - 执行上下文（当前用户 / API Key / 选择的知识库），透传给工具用于归属校验，
 *                      不作为工具参数从模型侧传入
 * @param allowedToolNames - 本次请求允许执行的工具名集合（来自用户开关）。
 *                      模型可能点名一个本轮没下发的工具，这里必须拒绝，
 *                      否则「关闭私有知识库」这类开关会被绕过。
 */
async function startToolExecution(
  toolCall: ToolCall,
  writer: SSEWriter,
  cancelSignal?: AbortSignal,
  toolContext?: ToolExecutionContext,
  allowedToolNames?: Set<string>
): Promise<ToolExecutionResult> {
  const name = toolCall.function.name
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(toolCall.function.arguments)
  } catch {
    /* ignore */
  }

  // 白名单校验（第一道：用户开关的最终裁决权）
  // 仍返回一条 tool 结果，保证 assistant(tool_calls) 与 tool 消息成对出现，
  // 否则下一轮请求会因消息不完整被上游拒绝。
  if (allowedToolNames && !allowedToolNames.has(name)) {
    console.warn(`[Stream] 拒绝执行未在本次请求中启用的工具: ${name}`)
    return {
      toolCallId: toolCall.id,
      name,
      success: false,
      content: JSON.stringify({
        error: `工具 ${name} 未在本次请求中启用，已拒绝执行`,
      }),
    }
  }

  // 注册到取消注册表，/api/chat/cancel-tool 可通过 toolCallId 取消本次执行
  const signal = registerRunningTool(toolCall.id, name, cancelSignal)

  try {
    if (name === 'generate_image') {
      // 图片生成：带进度回调
      const result = await executeImageGeneration(
        args,
        (progress) => {
          writer.sendToolProgress(toolCall.id, progress)
        },
        signal
      )

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
      return {
        toolCallId: toolCall.id,
        name,
        success: true,
        content: JSON.stringify(result),
      }
    } else {
      // 其他工具：直接执行（透传执行上下文，供需要归属校验的工具使用）
      const content = await toolRegistry.executeByName(
        name,
        args,
        signal,
        toolContext
      )

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
    const isCancelled =
      signal.aborted || (error instanceof Error && error.name === 'AbortError')
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
    return {
      toolCallId: toolCall.id,
      name,
      success: false,
      content: JSON.stringify({ error: msg }),
    }
  } finally {
    unregisterRunningTool(toolCall.id)
  }
}

function parseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
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
 * 记录"估算输入 token"与上游真实 prompt_tokens 的对照
 *
 * 抽成一个函数是因为两条流路径（有工具 / 无工具）都要记：
 * 只在大流里记，会让大部分请求拿不到校准依据，估算器的系数就永远没有数据可校。
 *
 * **只在偏差超出容忍范围时才输出**：这是给"估算器是否漂了"用的告警，
 * 不是每轮都要打一行噪音。偏差在容差内就完全不输出。
 *
 * 方向性：estimationErrorRatio > 0 表示估算**偏低**（危险方向，需要收紧系数），
 * < 0 表示估算偏高（安全方向，只会让我们提前压缩）。
 */
const ESTIMATION_DRIFT_TOLERANCE = 0.25

function logEstimationComparison(
  estimatedInputTokens: number | undefined,
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  } | null
): void {
  if (!estimatedInputTokens || !usage || usage.totalTokens <= 0) return

  const comparison = compareEstimatedToActual(
    estimatedInputTokens,
    usage.inputTokens
  )
  if (comparison.estimationErrorRatio === null) return
  if (Math.abs(comparison.estimationErrorRatio) <= ESTIMATION_DRIFT_TOLERANCE)
    return

  // warn 而不是 log：生产构建会删掉 console.log（见 context/metrics.ts 的说明）
  console.warn(`[Context] 估算偏差超出容忍: ${JSON.stringify(comparison)}`)
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
        const { thinkingContent, answerContent, usage } =
          await consumeAIResponse(reader, writer, cancelSignal, false)

        await persistMessage(messageId, conversationId, userId, {
          thinkingContent,
          answerContent,
          toolCallsData: null,
        })

        // Token 用量透传给前端（监控成本/吞吐）
        if (usage && usage.totalTokens > 0) writer.sendUsage(usage)

        // 估算 vs 实测：无工具这条路径同样要记录，否则大部分请求都拿不到校准依据
        logEstimationComparison(context.estimatedInputTokens, usage)

        writer.sendComplete()
        writer.close()
      } catch (error) {
        // 用户取消导致的 AbortError：静默结束（客户端已断开，前端自行保存了部分内容）
        if (
          cancelSignal?.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
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
  const {
    messageId,
    conversationId,
    userId,
    sessionId,
    apiKey,
    model,
    contextMessages,
    enableThinking,
    thinkingBudget,
    cancelSignal,
    allowedTools,
    knowledgeBaseId,
    estimatedInputTokens,
  } = context
  const encoder = new TextEncoder()

  // 工具执行上下文：把服务端认证得到的 userId、本次请求解析出的 apiKey、
  // 以及用户选择的知识库 ID 透传给工具。
  // knowledge_search 依赖它做知识库归属校验（绝不能从模型参数或客户端请求体取 userId）。
  const toolContext: ToolExecutionContext = {
    userId,
    conversationId,
    apiKey,
    knowledgeBaseId,
  }

  // 本次请求允许的工具：定义（下发给模型）与名字（执行前校验）都从它派生。
  // 关键点：多轮循环里每一轮都用这一份，而不是 toolRegistry.getToolDefinitions()。
  const toolDefinitions: OpenAIToolDefinition[] = allowedTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const allowedToolNames = new Set(allowedTools.map((tool) => tool.name))

  return new ReadableStream({
    async start(controller) {
      const writer = new SSEWriter(controller, encoder, sessionId)

      try {
        let thinkingContent = ''
        let finalAnswerContent = ''
        let totalUsage: {
          inputTokens: number
          outputTokens: number
          totalTokens: number
        } | null = null
        const allToolCalls: ToolCall[] = []
        const allToolResults: Array<{
          toolCallId: string
          name: string
          result: Record<string, unknown>
        }> = []

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
          const {
            thinkingContent: roundThinking,
            answerContent: roundAnswer,
            toolCalls: roundToolCalls,
            toolPromises,
            usage: roundUsage,
          } = await consumeAIResponse(
            currentReader,
            writer,
            cancelSignal,
            true,
            toolContext,
            allowedToolNames
          )

          // 多轮 Token 用量累加（每轮请求都会产生 usage）
          if (roundUsage && roundUsage.totalTokens > 0) {
            totalUsage ??= { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
            totalUsage.inputTokens += roundUsage.inputTokens
            totalUsage.outputTokens += roundUsage.outputTokens
            totalUsage.totalTokens += roundUsage.totalTokens
          }

          thinkingContent += roundThinking
          // 每轮都记最后一个有内容的回答：这样"轮次跑满上限退出"时也不会落库空内容
          // （只有无工具调用那条分支赋值的话，跑满 5 轮会把已经流给前端的正文丢掉）
          finalAnswerContent = pickPersistedAnswer(
            finalAnswerContent,
            roundAnswer
          )
          console.log(
            `[Stream] AI 返回: answer=${roundAnswer.length}字, tools=${roundToolCalls.length}个`
          )

          // 没有工具调用，结束
          if (roundToolCalls.length === 0) {
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
              result: {
                success: result.success,
                cancelled: result.cancelled,
                ...parseJSON(result.content),
              },
            })
          }

          // 构建下一轮消息
          const toolMessages = formatToolMessages(toolResults)
          currentMessages = [
            ...currentMessages,
            {
              role: 'assistant',
              content: roundAnswer || null,
              tool_calls: roundToolCalls,
            },
            ...(toolMessages as ChatMessage[]),
          ]

          // 发起下一轮 AI 请求
          // 注意：这里必须继续用本次请求允许的 tools，不能换成 toolRegistry.getToolDefinitions()，
          // 否则关闭「私有知识库」的用户在第 2 轮又会被重新暴露 knowledge_search。
          console.log('[Stream] 发起下一轮 AI 请求')
          const { reader: nextReader } = await createChatCompletion(apiKey, {
            model,
            messages: currentMessages as Array<{
              role: 'system' | 'user' | 'assistant'
              content: string
            }>,
            enableThinking,
            thinkingBudget,
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
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

        // 轮次跑满 MAX_TOOL_ROUNDS 时走这里：没有"最后一轮无工具调用"的收尾，
        // 但 finalAnswerContent 已在每轮更新，落库的仍是最后一轮正文（不会为空）
        if (round >= MAX_TOOL_ROUNDS) {
          console.warn(
            `[Stream] 工具调用达到上限 ${MAX_TOOL_ROUNDS} 轮，按最后一轮回答收尾（不再继续调用工具）`
          )
        }

        // 处理图片结果
        const contentWithImages = processImageResults(
          finalAnswerContent,
          allToolCalls,
          allToolResults
        )

        // 保存消息
        await persistMessage(messageId, conversationId, userId, {
          thinkingContent,
          answerContent: contentWithImages,
          toolCallsData: allToolCalls.length > 0 ? allToolCalls : null,
          toolResultsData: allToolResults.length > 0 ? allToolResults : null,
        })

        // Token 用量透传给前端（多轮累加）
        if (totalUsage && totalUsage.totalTokens > 0)
          writer.sendUsage(totalUsage)

        // 估算值 vs 实测值：多轮时实测值是每轮累加的，故只比首轮的输入量没有意义，
        // 这里记录"估算 vs 实测输入合计"，用于事后校准估算器的系数。
        logEstimationComparison(estimatedInputTokens, totalUsage)

        writer.sendComplete()
        writer.close()
        console.log('[Stream] 完成')
      } catch (error) {
        // 用户取消导致的 AbortError：静默结束（客户端已断开，前端自行保存了部分内容）
        if (
          cancelSignal?.aborted ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          console.log('[Stream] 流被取消（AbortError）')
          return
        }
        console.error('[Stream] 错误:', error)
        writer.error(error)
      }
    },
  })
}

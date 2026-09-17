/**
 * Chat Service - 聊天核心业务逻辑
 * 
 * 负责：
 * - 会话管理
 * - 消息创建
 * - 调用 AI API
 * - 工具调用处理
 * - 返回流式响应
 */

import { nanoid } from 'nanoid'
import { prisma } from '@/server/db/client'
import { ConversationRepository } from '@/server/repositories/conversation.repository'
import { MessageRepository } from '@/server/repositories/message.repository'
import { createChatCompletion } from '@/server/services/ai/siliconflow'
import { getDefaultModel } from '@/shared/constants/models'
import { buildContextMessages, appendAttachments } from './prompt.builder'
import { createSSEStream, createSSEStreamWithTools } from './stream.handler'
import { toolRegistry, ensureToolsReady, type Tool } from '@/server/services/tools'


export interface ChatRequest {
  content: string
  conversationId?: string
  model?: string
  enableThinking?: boolean
  thinkingBudget?: number
  enableWebSearch?: boolean
  /** 是否启用私有知识库检索（knowledge_search 工具） */
  enableKnowledgeBase?: boolean
  /** 用户在输入框选择的知识库 ID；不传则检索该用户全部知识库 */
  knowledgeBaseId?: string
  enableImageGeneration?: boolean
  imageConfig?: { prompt: string; negative_prompt?: string; image_size: string }
  userMessageId?: string
  aiMessageId?: string
  attachments?: Array<{ name: string; content: string; type: string; size: number }>
}

export interface ChatResponse {
  stream: ReadableStream
  sessionId: string
  conversationId: string
  conversationTitle: string
}

/**
 * 处理聊天请求
 *
 * @param userId - 用户 ID
 * @param apiKey - API Key
 * @param request - 聊天请求体
 * @param signal - 可选：客户端连接取消信号（request.signal），用于中断上游 AI 请求和工具执行
 */
export async function handleChatRequest(
  userId: string,
  apiKey: string,
  request: ChatRequest,
  signal?: AbortSignal
): Promise<ChatResponse> {
  // 确保工具初始化完成
  await ensureToolsReady()

  const {
    content,
    conversationId,
    // 默认模型跟随共享白名单（shared/constants/models.ts 中 default: true 的模型），避免配置漂移
    model = getDefaultModel().id,
    enableThinking = false,
    thinkingBudget = 4096,
    enableWebSearch = false,
    enableKnowledgeBase = false,
    knowledgeBaseId,
    enableImageGeneration: _enableImageGeneration = false,
    userMessageId,
    aiMessageId,
    attachments,
  } = request

  // 1. 获取或创建会话
  const conversation = await getOrCreateConversation(conversationId, userId)

  // 2. 创建消息记录（ID 优先取客户端生成的 nanoid，兜底同样用 nanoid，避免两套 ID 格式）
  const messageId = aiMessageId || nanoid()
  await createMessages(conversation.id, content, userMessageId, messageId, attachments)

  // 3. 更新会话标题（如果是第一条消息）
  const updatedTitle = await updateConversationTitle(conversation, content)

  // 4. 准备工具定义
  // - web_search: 需要用户手动开启
  // - knowledge_search: 需要用户手动开启（与 web_search 同一模式）
  // - generate_image: 始终可用（AI 自动判断何时调用）
  //
  // enabledTools 同时承担两个职责，且必须贯穿整个多轮 Tool Calling：
  //   1) 每轮请求给模型看的 tools（不是只有第一轮）
  //   2) 工具执行前的白名单校验（防止模型点名一个本轮未启用的工具）
  const enabledTools: Tool[] = []
  if (enableWebSearch && toolRegistry.has('web_search')) {
    enabledTools.push(toolRegistry.get('web_search')!)
  }
  if (enableKnowledgeBase && toolRegistry.has('knowledge_search')) {
    enabledTools.push(toolRegistry.get('knowledge_search')!)
  }
  // 生图工具始终可用，让 AI 自己判断何时调用
  const imageAvailable = toolRegistry.has('generate_image')
  if (imageAvailable) {
    enabledTools.push(toolRegistry.get('generate_image')!)
  }
  const tools = enabledTools.length > 0
    ? enabledTools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
    : undefined

  // 调试日志
  console.log('[ChatService] Enabled tools:', enabledTools.map(t => t.name))
  if (!imageAvailable) {
    console.log('[ChatService] Image generation unavailable, AI will be notified')
  }

  // 5. 获取历史消息并构建上下文（传递图片可用状态）
  const historyMessages = await MessageRepository.findByConversationId(conversation.id)
  const currentUserMessage = appendAttachments(content, attachments)
  const contextMessages = buildContextMessages(historyMessages, currentUserMessage, imageAvailable)

  // 6. 调用 AI API
  const { reader } = await createChatCompletion(apiKey, {
    model,
    messages: contextMessages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    enableThinking,
    thinkingBudget,
    tools,
    signal,
  })

  // 7. 创建 SSE 流
  const sessionId = Date.now().toString()
  
  // 如果有可用工具，使用支持工具调用的流处理器
  const hasTools = enabledTools.length > 0
  const stream = hasTools
    ? createSSEStreamWithTools(reader, {
        messageId,
        conversationId: conversation.id,
        userId,
        sessionId,
        apiKey,
        model,
        contextMessages: contextMessages as Array<{ role: string; content: string }>,
        enableThinking,
        thinkingBudget,
        cancelSignal: signal,
        // 本次请求允许的工具集合：多轮循环里每轮都用它下发，并在执行前做白名单校验
        allowedTools: enabledTools,
        knowledgeBaseId,
      })
    : createSSEStream(reader, {
        messageId,
        conversationId: conversation.id,
        userId,
        sessionId,
        cancelSignal: signal,
      })

  return {
    stream,
    sessionId,
    conversationId: conversation.id,
    conversationTitle: updatedTitle,
  }
}

/**
 * 获取或创建会话
 */
async function getOrCreateConversation(
  conversationId: string | undefined,
  userId: string
) {
  if (conversationId) {
    const conversation = await ConversationRepository.findById(conversationId, userId)
    if (!conversation) {
      throw new NotFoundError('Conversation not found')
    }
    return conversation
  }
  return ConversationRepository.create(userId)
}

/**
 * 创建消息记录
 */
async function createMessages(
  conversationId: string,
  content: string,
  userMessageId: string | undefined,
  aiMessageId: string,
  attachments?: Array<{ name: string; content: string; type: string; size: number }>
): Promise<void> {
  const now = new Date()
  const userMessageTime = now
  const assistantMessageTime = new Date(now.getTime() + 1)

  if (userMessageId) {
    await prisma.$transaction([
      prisma.message.create({
        data: {
          id: userMessageId,
          conversationId,
          role: 'user',
          content,
          attachments: attachments || undefined,
          createdAt: userMessageTime,
        },
      }),
      prisma.message.create({
        data: {
          id: aiMessageId,
          conversationId,
          role: 'assistant',
          content: '',
          createdAt: assistantMessageTime,
        },
      }),
    ])
  } else {//一般对应 “重试”这一操作
    await prisma.message.create({
      data: {
        id: aiMessageId,
        conversationId,
        role: 'assistant',
        content: '',
        createdAt: assistantMessageTime,
      },
    })
  }
}

/**
 * 更新会话标题
 */
async function updateConversationTitle(
  conversation: { id: string; title: string },
  content: string
): Promise<string> {
  const messageCount = await prisma.message.count({
    where: { conversationId: conversation.id },
  })

  if (messageCount === 2 && conversation.title === '新对话') {
    const newTitle = content.trim().substring(0, 20) + (content.length > 20 ? '...' : '')
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { title: newTitle },
    })
    return newTitle
  }

  return conversation.title
}

/**
 * 自定义错误类
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

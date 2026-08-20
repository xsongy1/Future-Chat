/**
 * Chat Service - 业务编排
 *
 * 只负责消息发送、加载、重试、取消等流程的编排。
 * 以下职责已拆分到独立模块：
 * - SSE 流消费/分发：StreamHandler（stream-handler.ts）
 * - 埋点：StreamTelemetry（stream-telemetry.ts）
 * - 工具轮内容管理：RoundContentTracker（round-content-tracker.ts）
 * - 标题同步：syncConversationTitle（title-sync.ts）
 * - 工具进度/状态写入：store（单一事实来源 messages[].toolInvocations）
 */

import { nanoid } from 'nanoid'
import { useChatStore } from '@/features/chat/store/chat.store'
import { ConversationAPI } from '@/features/chat/services/conversation-api'
import { StreamHandler } from '@/features/chat/services/stream-handler'
import { syncConversationTitle } from '@/features/chat/services/title-sync'
import type { Message, FileAttachment } from '@/features/chat/types/chat'
import {
  startTrace,
  endTrace,
  getCurrentTraceId,
} from '@/lib/monitor/trace-helper'
import { getMonitor } from '@/lib/monitor'
import { trackUserAction } from '@/lib/monitor/user-actions'

/**
 * 通知后端取消正在执行的工具（/api/chat/cancel-tool）
 *
 * @returns 解析后的响应体（{ success, cancelled }）；请求失败返回 null
 */
async function requestToolCancellation(
  toolCallId: string
): Promise<{ success: boolean; cancelled?: boolean } | null> {
  try {
    const response = await fetch('/api/chat/cancel-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolCallId }),
    })

    // 非 2xx：记录日志，不把 UI 标记为已取消（避免"假取消"）
    if (!response.ok) {
      console.warn('[ChatService] cancelTool HTTP error:', response.status)
      return null
    }

    return (await response.json().catch(() => null)) as {
      success: boolean
      cancelled?: boolean
    } | null
  } catch (e) {
    console.error('[ChatService] cancelTool failed:', e)
    return null
  }
}

export const ChatService = {
  /**
   * 中断当前流式请求
   */
  abortStream(): void {
    // ========== 埋点：用户行为（停止生成）==========
    trackUserAction('stop_generation')

    // ========== 埋点：先结束 Trace ==========
    endTrace('abort', 'user_cancel')

    const store = useChatStore.getState()
    // 中断控制器由 chat store 管理，随 store 生命周期创建/清理
    store.streamAbortController?.abort()
    store.setStreamAbortController(null)

    const messageId = store.streamingMessageId
    if (!messageId) return

    // 取消所有正在运行的工具（单一事实来源：messages[].toolInvocations）
    const message = store.messages.find((m) => m.id === messageId)
    const runningTools =
      message?.toolInvocations?.filter((t) => t.state === 'running') ?? []
    for (const tool of runningTools) {
      store.cancelTool(messageId, tool.toolCallId)
      // 通知后端取消工具（fire-and-forget）
      requestToolCancellation(tool.toolCallId)
    }

    // 消息回到 idle（阶段由 selectors 从消息数据派生）
    store.updateMessage(messageId, { displayState: 'idle' })

    // 保存已接收的内容到数据库
    const msg = store.messages.find((m) => m.id === messageId)
    if (msg) {
      fetch(`/api/message/${messageId}/save-partial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: msg.content || '',
          thinking: msg.thinking || '',
          toolInvocations: msg.toolInvocations || [],
        }),
      }).catch((e) =>
        console.error('[ChatService] Failed to save partial message:', e)
      )
    }
  },

  /**
   * 取消指定工具的执行
   * @param abortStream - 是否同时中断整个流（默认 false）
   */
  async cancelTool(
    messageId: string,
    toolCallId: string,
    abortStream = false
  ): Promise<boolean> {
    const data = await requestToolCancellation(toolCallId)
    if (!data) return false

    // 仅在服务端确认"确实找到了正在执行的工具并触发取消"时才更新 UI 状态
    // （cancelled=false 说明工具已结束，此时不应把已完成的结果覆盖为已取消）
    if (data.success && data.cancelled) {
      useChatStore.getState().cancelTool(messageId, toolCallId)

      // 如果需要中断整个流
      if (abortStream) {
        this.abortStream()
      }
    }

    return !!data.success
  },

  /**
   * 加载会话消息（带缓存，智能 loading）
   * - 第一次进入会话：显示 loading
   * - 切换会话：从缓存立即显示，后台静默加载
   */
  async loadMessages(conversationId: string): Promise<void> {
    const store = useChatStore.getState()

    // 如果正在发送消息，不要加载（避免覆盖刚添加的消息）
    if (store.isSendingMessage) {
      console.log('[ChatService] Skipping loadMessages - sending in progress')
      return
    }

    // 如果正在流式生成，先中断并保存已生成的内容
    if (store.streamingMessageId) {
      this.abortStream()
    }

    // 取消之前的请求
    useChatStore.getState().loadAbortController?.abort()
    useChatStore.getState().setLoadAbortController(new AbortController())

    // 检查是否有缓存
    const cached = store.getCachedMessages(conversationId)
    const hasCache = cached && cached.length > 0

    // 如果没有缓存，显示 loading；有缓存则立即显示
    if (!hasCache) {
      store.setLoadingMessages(true, conversationId)
    } else {
      store.setMessages(cached)
    }

    // 后台加载最新数据
    try {
      const { messages } = await ConversationAPI.getMessages(conversationId)

      // 去重
      const unique = messages.filter(
        (msg, i, arr) => arr.findIndex((m) => m.id === msg.id) === i
      ) as Message[]

      // 更新缓存和显示
      store.cacheMessages(conversationId, unique)
      store.setMessages(unique)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return

      // 404 时跳转到首页
      if ((e as { status?: number }).status === 404) {
        console.warn(
          '[ChatService] Conversation not found, redirecting to home'
        )
        window.location.href = '/'
        return
      }

      // 静默失败，保持缓存数据
      console.error('[ChatService] loadMessages failed:', e)
    } finally {
      useChatStore.getState().setLoadAbortController(null)
      store.setLoadingMessages(false)
    }
  },

  /**
   * 发送消息
   */
  async sendMessage(
    conversationId: string,
    content: string,
    options: {
      createUserMessage?: boolean
      attachments?: FileAttachment[]
      enableImageGeneration?: boolean
      imageConfig?: {
        prompt: string
        negative_prompt?: string
        image_size: string
      }
      previousTraceId?: string
    } = {}
  ): Promise<void> {
    const {
      createUserMessage = true,
      attachments,
      enableImageGeneration,
      imageConfig,
      previousTraceId,
    } = options
    const store = useChatStore.getState()

    console.log('[ChatService] sendMessage called:', {
      content,
      conversationId,
      isSendingMessage: store.isSendingMessage,
    })

    if (store.isSendingMessage) {
      console.log('[ChatService] Already sending, skipping')
      return
    }
    store.setSendingMessage(true)

    const userMessageId = createUserMessage ? nanoid() : undefined
    const aiMessageId = nanoid()

    // ========== 埋点：上下文（会话维度，userId 可在应用入口用 setContext 注入） ==========
    getMonitor()?.setContext({ conversationId })

    // ========== 埋点：用户行为（发送消息） ==========
    trackUserAction('send_message', { conversationId, model: store.selectedModel })

    // ========== 埋点：创建并启动 Trace（携带模型信息） ==========
    startTrace(aiMessageId, previousTraceId, store.selectedModel)

    // 添加用户消息
    if (createUserMessage && userMessageId) {
      console.log('[ChatService] Adding user message:', userMessageId)
      store.addMessage({
        id: userMessageId,
        role: 'user',
        content,
        attachments,
      })
    }

    // 添加 AI 占位消息
    console.log('[ChatService] Adding AI message:', aiMessageId)
    store.addMessage({
      id: aiMessageId,
      role: 'assistant',
      content: '',
      thinking: '',
      displayState: 'waiting',
    })

    console.log(
      '[ChatService] Messages after add:',
      useChatStore.getState().messages.length
    )

    try {
      // 创建 AbortController 用于中断（存入 chat store，随 store 生命周期管理）
      const streamController = new AbortController()
      useChatStore.getState().setStreamAbortController(streamController)

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          conversationId,
          model: store.selectedModel,
          enableThinking: store.enableThinking,
          enableWebSearch: store.enableWebSearch,
          enableImageGeneration,
          imageConfig,
          thinkingBudget: 4096,
          userMessageId,
          aiMessageId,
          attachments,
        }),
        signal: streamController.signal,
      })

      if (!response.ok) {
        // 保留 HTTP 状态码，供埋点做结构化错误分类
        const err = new Error(`API error: ${response.status}`) as Error & {
          status?: number
        }
        err.status = response.status
        throw err
      }

      // 读取响应头中的标题更新，立即同步到前端 store
      await syncConversationTitle(conversationId, response)

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No reader')

      // 消费 SSE 流（解析/缓冲/状态写入/埋点都在 StreamHandler 内部分层处理）
      await new StreamHandler(reader, aiMessageId).run()
    } catch (e) {
      // AbortError 是正常中断，不算错误
      if ((e as Error).name === 'AbortError') {
        store.updateMessage(aiMessageId, { displayState: 'idle' })
        // 注意：AbortError 不在这里埋点，因为 abortStream() 已经埋点了
        return
      }
      console.error('[ChatService] sendMessage failed:', e)
      store.updateMessage(aiMessageId, {
        hasError: true,
        displayState: 'error',
      })
      store.stopStreaming()

      // ========== 埋点：结构化错误结束（statusCode → 自动分类，429 等可重试） ==========
      const err = e as Error & { status?: number }
      const isNetworkError = err.name === 'TypeError' && err.status === undefined
      endTrace('error', {
        code: isNetworkError ? 'NETWORK_ERROR' : undefined,
        message: err.message || 'Unknown error',
        statusCode: err.status,
        retryable: isNetworkError || err.status === 429 || err.status === 503,
      })
    } finally {
      useChatStore.getState().setStreamAbortController(null)
      store.setSendingMessage(false)
      // 更新消息缓存
      const currentMessages = useChatStore.getState().messages
      useChatStore.getState().cacheMessages(conversationId, currentMessages)
    }
  },

  /**
   * 重试消息
   */
  async retryMessage(conversationId: string, messageId: string): Promise<void> {
    const store = useChatStore.getState()

    // ========== 埋点：用户行为（重试） ==========
    trackUserAction('retry', { messageId })

    // ========== 埋点：获取当前 Trace ID ==========
    const previousTraceId = getCurrentTraceId()

    if (store.streamingMessageId) {
      store.stopStreaming('user_retry')
    }

    const index = store.messages.findIndex((m) => m.id === messageId)
    if (index === -1) return

    const message = store.messages[index]
    if (message.role !== 'assistant') return

    // 删除从该消息开始的所有消息
    const removed = store.removeMessagesFrom(index)
    const idsToDelete = removed.map((m) => m.id)

    // 找到最后一条用户消息
    const lastUserMsg = [...store.messages]
      .reverse()
      .find((m) => m.role === 'user')
    if (!lastUserMsg) return

    // 后台删除数据库记录
    if (idsToDelete.length > 0) {
      fetch('/api/messages/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: idsToDelete }),
      }).catch(console.error)
    }

    // ========== 埋点：传入 previousTraceId ==========
    await this.sendMessage(conversationId, lastUserMsg.content, {
      createUserMessage: false,
      previousTraceId,
    })
  },

  /**
   * 编辑并重发
   */
  async editAndResend(
    conversationId: string,
    messageId: string,
    newContent: string
  ): Promise<void> {
    const store = useChatStore.getState()
    const index = store.messages.findIndex((m) => m.id === messageId)

    // ========== 埋点：用户行为（编辑重发） ==========
    trackUserAction('edit_message', { messageId })

    if (index === -1) return
    if (store.messages[index].role !== 'user') return

    // 删除从该消息开始的所有消息
    const removed = store.removeMessagesFrom(index)
    const idsToDelete = removed.map((m) => m.id)

    // 后台删除
    if (idsToDelete.length > 0) {
      fetch('/api/messages/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: idsToDelete }),
      }).catch(console.error)
    }

    // 发送新内容
    await this.sendMessage(conversationId, newContent, {
      createUserMessage: true,
    })
  },
}

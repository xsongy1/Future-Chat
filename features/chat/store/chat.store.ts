/**
 * Chat Store - 纯状态管理
 *
 * 只负责状态存储和简单的 mutations
 * 业务逻辑在 chat.service.ts 中
 *
 * 单一事实来源：工具进度/状态只维护在 messages[].toolInvocations 上，
 * 不再有平行的 messageStates 运行时状态机（已移除）。
 * 消息阶段（thinking/tool_calling/answering/...）由 selectors 从消息数据派生。
 */

import { create } from 'zustand'
import type { Message, AbortReason, StreamingPhase } from '@/features/chat/types/chat'
import { getDefaultModel, getModelById } from '@/features/chat/constants/models'
import { StorageManager, STORAGE_KEYS } from '@/lib/utils/storage'

interface ChatState {
  // 消息（唯一事实来源，包含 toolInvocations / displayState / hasError）
  messages: Message[]

  // 消息缓存（按 conversationId 索引）
  messageCache: Map<string, Message[]>

  // 加载状态
  isLoadingMessages: boolean
  loadingConversationId: string | null
  isSendingMessage: boolean

  // 流式状态
  streamingMessageId: string | null
  streamingPhase: StreamingPhase
  abortReason: AbortReason | null

  // 配置
  selectedModel: string
  enableThinking: boolean
  enableWebSearch: boolean
}

interface ChatActions {
  // 消息操作
  setMessages: (messages: Message[]) => void
  addMessage: (message: Message) => void
  updateMessage: (id: string, updates: Partial<Message>) => void
  appendThinking: (id: string, chunk: string) => void
  appendContent: (id: string, chunk: string) => void
  clearMessages: () => void
  removeMessagesFrom: (index: number) => Message[]

  // 工具调用状态（只写 messages[].toolInvocations，单一事实来源）
  updateToolProgress: (messageId: string, toolCallId: string, progress: number, estimatedTime?: number) => void
  cancelTool: (messageId: string, toolCallId: string) => void

  // 加载状态
  setLoadingMessages: (loading: boolean, conversationId?: string | null) => void
  setSendingMessage: (sending: boolean) => void

  // 消息缓存
  cacheMessages: (conversationId: string, messages: Message[]) => void
  getCachedMessages: (conversationId: string) => Message[] | undefined

  // 流式状态
  startStreaming: (messageId: string, phase: StreamingPhase) => void
  stopStreaming: (reason?: AbortReason) => void

  // 配置
  setModel: (modelId: string) => void
  toggleThinking: (enabled: boolean) => void
  toggleWebSearch: (enabled: boolean) => void

  // 重置
  reset: () => void
}

const getInitialModel = (): string => {
  if (typeof window === 'undefined') return getDefaultModel().id
  try {
    const saved = StorageManager.get<string>(STORAGE_KEYS.USER.SELECTED_MODEL)
    if (saved && getModelById(saved)) return saved
  } catch {}
  return getDefaultModel().id
}

const initialState: ChatState = {
  messages: [],
  messageCache: new Map(),
  isLoadingMessages: false,
  loadingConversationId: null,
  isSendingMessage: false,
  streamingMessageId: null,
  streamingPhase: null,
  abortReason: null,
  selectedModel: getInitialModel(),
  enableThinking: false,
  enableWebSearch: false,
}

export const useChatStore = create<ChatState & ChatActions>()((set, get) => ({
  ...initialState,

  // ===== 消息操作 =====
  setMessages: (messages) => set({ messages }),

  addMessage: (message) => set((s) => {
    if (s.messages.some(m => m.id === message.id)) return s
    return { messages: [...s.messages, message] }
  }),

  updateMessage: (id, updates) => set((s) => ({
    messages: s.messages.map(m => m.id === id ? { ...m, ...updates } : m)
  })),

  appendThinking: (id, chunk) => set((s) => ({
    messages: s.messages.map(m =>
      m.id === id ? { ...m, thinking: (m.thinking || '') + chunk } : m
    )
  })),

  appendContent: (id, chunk) => set((s) => ({
    messages: s.messages.map(m =>
      m.id === id ? { ...m, content: (m.content || '') + chunk } : m
    )
  })),

  clearMessages: () => set({ messages: [] }),

  removeMessagesFrom: (index) => {
    const state = get()
    const removed = state.messages.slice(index)
    set({ messages: state.messages.slice(0, index) })
    return removed
  },

  // ===== 工具调用状态（单一事实来源：messages[].toolInvocations） =====
  // 只更新这一处，UI 渲染与阶段派生都从这里读取，不存在漏改另一份平行状态的问题。

  updateToolProgress: (messageId, toolCallId, progress, estimatedTime) => set((s) => ({
    messages: s.messages.map((msg) => {
      if (msg.id !== messageId) return msg
      return {
        ...msg,
        toolInvocations: msg.toolInvocations?.map((inv) =>
          inv.toolCallId === toolCallId ? { ...inv, progress, estimatedTime } : inv
        ),
      }
    }),
  })),

  cancelTool: (messageId, toolCallId) => set((s) => ({
    messages: s.messages.map((msg) => {
      if (msg.id !== messageId) return msg
      return {
        ...msg,
        toolInvocations: msg.toolInvocations?.map((inv) =>
          inv.toolCallId === toolCallId
            ? { ...inv, state: 'cancelled' as const, result: { success: false, cancelled: true } }
            : inv
        ),
      }
    }),
  })),

  // ===== 加载状态 =====
  setLoadingMessages: (loading, conversationId = null) => set({
    isLoadingMessages: loading,
    loadingConversationId: loading ? conversationId : null,
  }),

  setSendingMessage: (sending) => set({ isSendingMessage: sending }),

  // ===== 消息缓存 =====
  cacheMessages: (conversationId, messages) => set((s) => {
    const newCache = new Map(s.messageCache)
    newCache.set(conversationId, messages)
    return { messageCache: newCache }
  }),

  getCachedMessages: (conversationId) => {
    return get().messageCache.get(conversationId)
  },

  // ===== 流式状态 =====
  startStreaming: (messageId, phase) => set({
    streamingMessageId: messageId,
    streamingPhase: phase,
    abortReason: null,
  }),

  stopStreaming: (reason) => set({
    streamingMessageId: null,
    streamingPhase: null,
    abortReason: reason || null,
  }),

  // ===== 配置 =====
  setModel: (modelId) => {
    try { StorageManager.set(STORAGE_KEYS.USER.SELECTED_MODEL, modelId) } catch {}
    set({ selectedModel: modelId })
  },

  toggleThinking: (enabled) => set({ enableThinking: enabled }),

  toggleWebSearch: (enabled) => set({ enableWebSearch: enabled }),

  // ===== 重置 =====
  reset: () => set(initialState),
}))

// Selectors
export const selectIsStreaming = (s: ChatState) => s.streamingMessageId !== null
export const selectLastMessage = (s: ChatState) => s.messages[s.messages.length - 1]

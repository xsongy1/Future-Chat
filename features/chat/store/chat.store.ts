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
import type {
  Message,
  AbortReason,
  StreamingPhase,
} from '@/features/chat/types/chat'
import { getDefaultModel, getModelById } from '@/shared/constants/models'

/**
 * 把 StreamBuffer 里尚未 flush 的内容同步写入 store 的能力
 *
 * StreamHandler 的两个 buffer 是私有字段，ChatService 拿不到句柄，
 * 而"停止生成"必须在同步块里先 flush 再组 save-partial 请求体，
 * 否则最后一帧（最长一帧的分片）会只显示在 UI、不进数据库。
 * 这里只依赖这个最小接口，store 不需要知道 StreamHandler 的任何细节。
 */
export interface StreamBufferFlusher {
  flushBuffers(): void
}
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

  // 请求中断控制器（运行时状态，不持久化；随 store 生命周期管理，避免模块级单例）
  streamAbortController: AbortController | null
  loadAbortController: AbortController | null

  // 正在消费流的 handler（仅用于中断前同步 flush 缓冲；非持久化运行时状态）
  activeStreamHandler: StreamBufferFlusher | null

  // 配置
  selectedModel: string
  enableThinking: boolean
  enableWebSearch: boolean
  /** 是否启用私有知识库检索（knowledge_search 工具） */
  enableKnowledgeBase: boolean
  /** 当前选中的知识库 ID；null = 检索该用户全部知识库 */
  selectedKnowledgeBaseId: string | null
  /** 当前选中知识库的名称（仅用于输入框展示，避免为了一个标签再去请求列表） */
  selectedKnowledgeBaseName: string | null
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
  updateToolProgress: (
    messageId: string,
    toolCallId: string,
    progress: number,
    estimatedTime?: number
  ) => void
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

  // 请求中断控制器
  setStreamAbortController: (controller: AbortController | null) => void
  setLoadAbortController: (controller: AbortController | null) => void
  /** 登记/注销正在消费流的 handler（停止生成时用于先 flush 再落库） */
  setActiveStreamHandler: (handler: StreamBufferFlusher | null) => void

  // 配置
  setModel: (modelId: string) => void
  toggleThinking: (enabled: boolean) => void
  toggleWebSearch: (enabled: boolean) => void
  toggleKnowledgeBase: (enabled: boolean) => void
  /**
   * 选择要检索的知识库；传 null 表示检索全部知识库。
   * 选中某个知识库时会顺带把「私有知识库」开关打开（用户意图很明确）。
   */
  setSelectedKnowledgeBase: (id: string | null, name?: string | null) => void

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

const getInitialWebSearch = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return StorageManager.get<boolean>(STORAGE_KEYS.USER.ENABLE_WEB_SEARCH) ?? false
  } catch {}
  return false
}

const getInitialKnowledgeBase = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return StorageManager.get<boolean>(STORAGE_KEYS.USER.ENABLE_KNOWLEDGE_BASE) ?? false
  } catch {}
  return false
}

const getInitialKnowledgeBaseId = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return StorageManager.get<string>(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE) ?? null
  } catch {}
  return null
}

const getInitialKnowledgeBaseName = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return StorageManager.get<string>(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE_NAME) ?? null
  } catch {}
  return null
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
  streamAbortController: null,
  loadAbortController: null,
  activeStreamHandler: null,
  selectedModel: getInitialModel(),
  enableThinking: false,
  enableWebSearch: getInitialWebSearch(),
  enableKnowledgeBase: getInitialKnowledgeBase(),
  selectedKnowledgeBaseId: getInitialKnowledgeBaseId(),
  selectedKnowledgeBaseName: getInitialKnowledgeBaseName(),
}

export const useChatStore = create<ChatState & ChatActions>()((set, get) => ({
  ...initialState,

  // ===== 消息操作 =====
  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((s) => {
      if (s.messages.some((m) => m.id === message.id)) return s
      return { messages: [...s.messages, message] }
    }),

  updateMessage: (id, updates) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),

  appendThinking: (id, chunk) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, thinking: (m.thinking || '') + chunk } : m
      ),
    })),

  appendContent: (id, chunk) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, content: (m.content || '') + chunk } : m
      ),
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

  updateToolProgress: (messageId, toolCallId, progress, estimatedTime) =>
    set((s) => ({
      messages: s.messages.map((msg) => {
        if (msg.id !== messageId) return msg
        return {
          ...msg,
          toolInvocations: msg.toolInvocations?.map((inv) =>
            inv.toolCallId === toolCallId
              ? { ...inv, progress, estimatedTime }
              : inv
          ),
        }
      }),
    })),

  cancelTool: (messageId, toolCallId) =>
    set((s) => ({
      messages: s.messages.map((msg) => {
        if (msg.id !== messageId) return msg
        return {
          ...msg,
          toolInvocations: msg.toolInvocations?.map((inv) =>
            inv.toolCallId === toolCallId
              ? {
                  ...inv,
                  state: 'cancelled' as const,
                  result: { success: false, cancelled: true },
                }
              : inv
          ),
        }
      }),
    })),

  // ===== 加载状态 =====
  setLoadingMessages: (loading, conversationId = null) =>
    set({
      isLoadingMessages: loading,
      loadingConversationId: loading ? conversationId : null,
    }),

  setSendingMessage: (sending) => set({ isSendingMessage: sending }),

  // ===== 消息缓存 =====
  cacheMessages: (conversationId, messages) =>
    set((s) => {
      const newCache = new Map(s.messageCache)
      newCache.set(conversationId, messages)
      return { messageCache: newCache }
    }),

  getCachedMessages: (conversationId) => {
    return get().messageCache.get(conversationId)
  },

  // ===== 流式状态 =====
  startStreaming: (messageId, phase) =>
    set({
      streamingMessageId: messageId,
      streamingPhase: phase,
      abortReason: null,
    }),

  stopStreaming: (reason) =>
    set({
      streamingMessageId: null,
      streamingPhase: null,
      abortReason: reason || null,
    }),

  // ===== 请求中断控制器 =====
  setStreamAbortController: (controller) =>
    set({ streamAbortController: controller }),

  setLoadAbortController: (controller) =>
    set({ loadAbortController: controller }),

  setActiveStreamHandler: (handler) => set({ activeStreamHandler: handler }),

  // ===== 配置 =====
  setModel: (modelId) => {
    try {
      StorageManager.set(STORAGE_KEYS.USER.SELECTED_MODEL, modelId)
    } catch {}
    set({ selectedModel: modelId })
  },

  toggleThinking: (enabled) => set({ enableThinking: enabled }),

  toggleWebSearch: (enabled) => {
    try {
      StorageManager.set(STORAGE_KEYS.USER.ENABLE_WEB_SEARCH, enabled)
    } catch {}
    set({ enableWebSearch: enabled })
  },

  toggleKnowledgeBase: (enabled) => {
    try {
      StorageManager.set(STORAGE_KEYS.USER.ENABLE_KNOWLEDGE_BASE, enabled)
    } catch {}
    set({ enableKnowledgeBase: enabled })
  },

  setSelectedKnowledgeBase: (id, name = null) => {
    try {
      if (id) {
        StorageManager.set(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE, id)
        if (name) StorageManager.set(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE_NAME, name)
      } else {
        StorageManager.remove(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE)
        StorageManager.remove(STORAGE_KEYS.USER.SELECTED_KNOWLEDGE_BASE_NAME)
      }
      // 选中具体知识库 = 想用它，顺手打开总开关，避免"选了却没生效"的困惑
      if (id) StorageManager.set(STORAGE_KEYS.USER.ENABLE_KNOWLEDGE_BASE, true)
    } catch {}
    set(
      id
        ? { selectedKnowledgeBaseId: id, selectedKnowledgeBaseName: name, enableKnowledgeBase: true }
        : { selectedKnowledgeBaseId: null, selectedKnowledgeBaseName: null }
    )
  },

  // ===== 重置 =====
  reset: () => set(initialState),
}))

// Selectors
export const selectIsStreaming = (s: ChatState) => s.streamingMessageId !== null
export const selectLastMessage = (s: ChatState) =>
  s.messages[s.messages.length - 1]

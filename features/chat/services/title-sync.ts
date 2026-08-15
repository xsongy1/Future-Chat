/**
 * 会话标题同步
 *
 * 从 /api/chat 响应头读取后端生成的会话标题（X-Conversation-Title），
 * 直接同步到本地 conversation store（后端已更新数据库，无需再调 API）。
 * 从 chat.service.ts 中剥离，降低服务类的职责耦合。
 */

/**
 * 同步响应头中的新标题到本地 conversation store
 * @param conversationId - 会话 ID
 * @param response - /api/chat 的 fetch 响应
 */
export async function syncConversationTitle(
  conversationId: string,
  response: Response
): Promise<void> {
  const newTitle = response.headers.get('X-Conversation-Title')
  if (!newTitle) return

  const decodedTitle = decodeURIComponent(newTitle)

  // 动态导入避免循环依赖
  const { useConversationStore } = await import(
    '@/features/conversation/store/conversation-store'
  )
  useConversationStore.setState((state) => ({
    conversations: state.conversations.map((c) =>
      c.id === conversationId ? { ...c, title: decodedTitle } : c
    ),
    filteredConversations: state.filteredConversations.map((c) =>
      c.id === conversationId ? { ...c, title: decodedTitle } : c
    ),
  }))
}

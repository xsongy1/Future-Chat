/**
 * 知识库检索结果的展示合并
 *
 * 模型在同一条回答里经常连续调用多次 knowledge_search：
 * 第一次问法没命中（resultCount=0），它会换个说法再检索一次，然后才作答。
 * 如果按调用逐条展示，界面就会出现自相矛盾的两块内容——
 * 「知识库中未找到相关内容」紧跟着「已检索 N 个知识片段 + 来源：xxx.md」。
 *
 * 这里把一条消息里的多次检索收敛成一次展示：
 * - 状态：只要还有在跑的就算「检索中」；任何一次成功即算「成功」
 * - 来源：按 `文档名#片段序号` 去重合并（多次检索常命中同一片段）
 * - 片段数：优先用去重后的来源数，拿不到来源时退化为各次 resultCount 之和
 *
 * 纯函数，无副作用，便于单测与复用（运行时 toolInvocations 与历史 toolResults 共用）。
 *
 * @module features/chat/utils/knowledge-invocations
 */

import type { ToolInvocation, KnowledgeSource } from '@/features/chat/types/chat'

/**
 * 合并同一条消息里的多次 knowledge_search 调用
 *
 * @param invocations - 该消息中 name === 'knowledge_search' 的调用（运行时或由 toolResults 还原）
 * @returns 合并后的单条调用；没有调用时返回 null
 */
export function mergeKnowledgeInvocations(
  invocations: ToolInvocation[]
): ToolInvocation | null {
  if (invocations.length === 0) return null
  if (invocations.length === 1) return invocations[0]

  const last = invocations[invocations.length - 1]
  const isRunning = invocations.some(
    (i) => i.state === 'running' || i.state === 'pending'
  )
  const succeeded = invocations.filter(
    (i) => i.state === 'completed' && i.result?.success
  )

  const seen = new Set<string>()
  const mergedSources: KnowledgeSource[] = []
  for (const inv of succeeded) {
    const sources = (inv.result?.knowledgeSources as KnowledgeSource[] | undefined) || []
    for (const source of sources) {
      const key = `${source.documentName}#${source.chunkIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      mergedSources.push(source)
    }
  }

  const summedCount = succeeded.reduce((n, i) => n + (i.result?.resultCount || 0), 0)

  return {
    ...last,
    state: isRunning ? 'running' : succeeded.length > 0 ? 'completed' : last.state,
    result: {
      success: succeeded.length > 0,
      cancelled: invocations.some((i) => i.state === 'cancelled'),
      resultCount: mergedSources.length > 0 ? mergedSources.length : summedCount,
      knowledgeSources: mergedSources,
    },
  }
}

/**
 * 把持久化的 toolResults 还原成 ToolInvocation，供合并与展示复用
 * （历史消息只存了 toolResults，没有运行时的 toolInvocations）
 */
export function toKnowledgeInvocation(result: {
  toolCallId: string
  name: string
  result: { success: boolean; cancelled?: boolean; resultCount?: number; [key: string]: unknown }
}): ToolInvocation {
  return {
    toolCallId: result.toolCallId,
    name: result.name,
    state: result.result.cancelled
      ? 'cancelled'
      : result.result.success
        ? 'completed'
        : 'failed',
    result: result.result,
  }
}

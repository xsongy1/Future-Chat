/**
 * 私有知识库检索工具
 *
 * 与 web_search / generate_image 同层级，注册进同一个 ToolRegistry，
 * 复用现有多轮 Function Calling + SSE 链路：
 *
 *   LLM → tool_call: knowledge_search → RAG 检索 → tool result → LLM → answer
 *
 * 归属校验：
 * 检索范围由 ToolExecutionContext.userId（服务端认证结果）决定，
 * 绝不接受模型/客户端传入的 userId。模型即使编造 knowledge_base_id，
 * 也只会拿到「不存在或无权访问」，不会读到别人的知识库。
 *
 * 检索状态（status）：
 * 返回结果里带机器可读的 status（matched / no_match / empty_knowledge_base /
 * no_access / invalid_query / error），因为对 RAG 来说"没有可信证据"和"检索失败"
 * 是两件必须分开说的事——前者要如实说"知识库里没有"，后者要说"检索暂时不可用"，
 * 而两者都不该让模型拿自己的知识补答。
 */

import type { Tool, ToolExecutionContext } from './types'
import { retrieve } from '@/server/services/rag'
import type { KnowledgeSource, RetrievalStatus } from '@/server/services/rag'

/**
 * 工具返回给上层的结构（写入 tool result，并透传给前端）
 *
 * `status` 是这次检索的机器可读结论，必须带上：
 * - 写进 tool result 后前端能区分"没有证据"与"检索失败"（此前两者都是 `resultCount: 0`）；
 * - 与 `server/services/rag` 的 `RetrievalStatus` 同一套取值，模型侧则由 content 里的
 *   状态词（如 `no_match`）与系统提示词的规则来约束。
 */
interface KnowledgeSearchResponse {
  content: string
  status: RetrievalStatus
  sources: KnowledgeSource[]
  resultCount: number
  error?: string
}

/**
 * 创建私有知识库检索工具
 *
 * @param fallbackApiKey - 兜底 API Key（env 中的 SILICONFLOW_API_KEY）；
 *                         优先使用执行上下文里的用户 Key
 */
export function createKnowledgeSearchTool(fallbackApiKey?: string): Tool {
  return {
    name: 'knowledge_search',
    description:
      '检索用户的私有知识库，获取其上传文档中的原文内容。' +
      '凡是涉及用户自己的文件/资料，或用户所在公司、组织、团队的内部规定、制度、政策、流程、标准、额度、时限等问题，都必须先调用此工具获取原文，严禁凭记忆或常识直接作答。' +
      '如果检索结果不足以回答，要如实说明知识库中没有相关资料。' +
      '返回的 status 字段表示检索状态：matched=取到片段；no_match=检索正常但没有找到足够可信的证据（此时必须如实说明知识库中没有相关资料，禁止编造或用你自己的知识替代）；' +
      'empty_knowledge_base=知识库还没有可检索内容（提示用户先上传文档）；no_access=无权访问该知识库；' +
      'error=检索失败（与“知识库中没有”是两回事，要按“服务暂时不可用”告知用户）。' +
      'no_match / empty_knowledge_base / no_access 三种状态在返回文本里也会写明状态词。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '检索用的自然语言问题或关键词，尽量具体，包含用户问题中的关键实体与限定条件',
        },
        // 沿用现有工具的 snake_case 参数风格（参照 generate_image 的
        // negative_prompt / image_size），不采用 camelCase
        knowledge_base_id: {
          type: 'string',
          description:
            '可选：限定只在该知识库内检索。通常不需要传——用户在输入框已经选定了知识库，系统会自动按该范围检索。',
        },
      },
      required: ['query'],
    },
    execute: async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
      context?: ToolExecutionContext
    ): Promise<string> => {
      const query = args.query as string
      // 检索范围优先级：用户在输入框选择的知识库 > 模型自填的 knowledge_base_id。
      // 前者来自服务端请求体（用户意图），后者只是模型的建议；
      // 两者都会再经过 retrieve() 内的归属校验，伪造他人 ID 只会得到空结果。
      const knowledgeBaseId =
        context?.knowledgeBaseId || (args.knowledge_base_id as string | undefined)

      if (!query || typeof query !== 'string' || !query.trim()) {
        return JSON.stringify({
          content: '检索失败：query 不能为空。',
          status: 'invalid_query',
          sources: [],
          resultCount: 0,
          error: 'query 不能为空',
        } satisfies KnowledgeSearchResponse)
      }

      // 没有上下文就拿不到当前用户，宁可直接失败也不做无归属约束的检索
      if (!context?.userId) {
        console.error('[KnowledgeSearch] 缺少执行上下文 userId，拒绝检索')
        return JSON.stringify({
          content: '检索失败：服务端未提供当前用户上下文。',
          status: 'error',
          sources: [],
          resultCount: 0,
          error: 'missing execution context',
        } satisfies KnowledgeSearchResponse)
      }

      const apiKey = context.apiKey || fallbackApiKey
      if (!apiKey) {
        return JSON.stringify({
          content: '检索失败：未配置 API Key，无法对查询做向量化。',
          status: 'error',
          sources: [],
          resultCount: 0,
          error: 'API Key not configured',
        } satisfies KnowledgeSearchResponse)
      }

      try {
        const outcome = await retrieve({
          userId: context.userId,
          query,
          apiKey,
          knowledgeBaseId,
          signal,
        })

        return JSON.stringify({
          content: outcome.content,
          status: outcome.status,
          sources: outcome.sources,
          resultCount: outcome.resultCount,
        } satisfies KnowledgeSearchResponse)
      } catch (error) {
        // 用户取消：与 web_search 一致，标记 cancelled 而不当作失败
        if (signal?.aborted) {
          console.log('[KnowledgeSearch] 检索被用户取消')
          return JSON.stringify({
            content: '检索已取消。',
            status: 'error',
            sources: [],
            resultCount: 0,
            error: 'cancelled',
          } satisfies KnowledgeSearchResponse)
        }

        const msg = error instanceof Error ? error.message : '未知错误'
        console.error('[KnowledgeSearch] 检索失败:', msg)
        return JSON.stringify({
          content: `检索失败：${msg}`,
          status: 'error',
          sources: [],
          resultCount: 0,
          error: msg,
        } satisfies KnowledgeSearchResponse)
      }
    },
  }
}

/**
 * knowledge_search 工具的返回契约
 *
 * 关键在于**状态必须被透传出去**：对 RAG 来说"知识库里没有可信证据"（no_match）
 * 和"检索失败"（error）是两件事，而在此之前两者在 tool result 里长得一模一样
 * （`success: true` + `resultCount: 0`），前端与埋点都分不出来。
 *
 * 这里不连数据库、不发请求：整个 rag 模块被替换成一个 mock，
 * 验证的是工具的编排（校验、透传、错误分支）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const retrieve = vi.fn()

vi.mock('@/server/services/rag', () => ({
  retrieve: (...args: unknown[]) => retrieve(...args),
}))

const { createKnowledgeSearchTool } = await import('../knowledge-search')

const context = { userId: 'user-a', apiKey: 'key-a' }

/** 调用工具并解析它返回的 JSON（工具约定返回 JSON 字符串） */
async function exec(
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; context?: Record<string, unknown> | null } = {}
) {
  const tool = createKnowledgeSearchTool('fallback-key')
  const raw = await tool.execute(
    args,
    opts.signal,
    opts.context === null ? undefined : { ...context, ...(opts.context ?? {}) }
  )
  return JSON.parse(raw as string) as {
    content: string
    status?: string
    resultCount?: number
    sources?: unknown[]
    error?: string
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('knowledge_search - 状态透传', () => {
  it('matched：把 content / status / sources / resultCount 原样透传', async () => {
    retrieve.mockResolvedValue({
      status: 'matched',
      content: '从私有知识库中检索到 1 个相关片段：…',
      sources: [
        { documentName: 'a.md', chunkIndex: 0, score: 0.9, snippet: 'x' },
      ],
      resultCount: 1,
      debug: {},
    })

    const result = await exec({ query: '内部代号是什么' })

    expect(result.status).toBe('matched')
    expect(result.resultCount).toBe(1)
    expect(result.sources).toHaveLength(1)
    expect(result.content).toContain('检索到 1 个相关片段')
  })

  it('no_match：状态与"没有可信证据"的文案一起返回（不是空数组）', async () => {
    retrieve.mockResolvedValue({
      status: 'no_match',
      content: '知识库检索结果：no_match（未找到足够可信的证据）…',
      sources: [],
      resultCount: 0,
      debug: {},
    })

    const result = await exec({ query: '生产环境部署在东京还是新加坡' })

    expect(result.status).toBe('no_match')
    expect(result.resultCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.content).toContain('no_match')
  })

  it('error：检索失败不能被报成 no_match', async () => {
    retrieve.mockResolvedValue({
      status: 'error',
      content: '检索失败：查询向量化出错（上游 503）。',
      sources: [],
      resultCount: 0,
      debug: {},
    })

    const result = await exec({ query: '内部代号是什么' })

    expect(result.status).toBe('error')
    expect(result.content).toContain('检索失败')
    expect(result.content).not.toContain('no_match')
  })
})

describe('knowledge_search - 前置校验与失败分支', () => {
  it('query 为空 → invalid_query，且不调用检索', async () => {
    const result = await exec({ query: '   ' })

    expect(result.status).toBe('invalid_query')
    expect(result.error).toBe('query 不能为空')
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('缺少执行上下文 userId → error，且不调用检索', async () => {
    const result = await exec({ query: '内部代号' }, { context: null })

    expect(result.status).toBe('error')
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('检索抛错 → error，并把原因带给上层', async () => {
    retrieve.mockRejectedValue(new Error('数据库连接失败'))

    const result = await exec({ query: '内部代号' })

    expect(result.status).toBe('error')
    expect(result.content).toContain('检索失败')
    expect(result.error).toContain('数据库连接失败')
  })

  it('用户取消 → 标记 cancelled，状态按 error 处理（不算"知识库里没有"）', async () => {
    const controller = new AbortController()
    retrieve.mockImplementation(async () => {
      controller.abort()
      throw new Error('aborted')
    })

    const result = await exec(
      { query: '内部代号' },
      { signal: controller.signal }
    )

    expect(result.error).toBe('cancelled')
    expect(result.status).toBe('error')
  })

  it('检索范围优先用用户选定的知识库，模型自填的 id 只是建议', async () => {
    retrieve.mockResolvedValue({
      status: 'matched',
      content: 'ok',
      sources: [],
      resultCount: 0,
      debug: {},
    })

    await exec(
      { query: '内部代号', knowledge_base_id: 'kb-guessed-by-model' },
      { context: { knowledgeBaseId: 'kb-chosen-by-user' } }
    )

    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: 'kb-chosen-by-user',
        userId: 'user-a',
      })
    )
  })
})

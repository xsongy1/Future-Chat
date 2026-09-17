/**
 * RAG 检索单元测试
 *
 * 用 mock 替换掉 Repository 与 embedding 调用，从而在没有数据库、没有网络的情况下
 * 验证 retrieve() 的核心行为——尤其是权限收敛与「检索不到时不编造」这两点。
 *
 * 覆盖：
 * - 指定别人的 knowledgeBaseId → 只返回「不存在或无权访问」
 * - 无任何知识库 → 明确提示
 * - Top-K 排序、相似度阈值过滤
 * - 向量维度不一致的片段被跳过
 * - embedding 失败 / DB 失败 → 明确失败信息而非空结果
 * - 空 query
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock：Repository（不连数据库） ----
const findOwnedBaseIds = vi.fn()
const findChunksForRetrieval = vi.fn()

vi.mock('@/server/repositories/knowledge.repository', () => ({
  KnowledgeRepository: {
    findOwnedBaseIds: (...args: unknown[]) => findOwnedBaseIds(...args),
    findChunksForRetrieval: (...args: unknown[]) => findChunksForRetrieval(...args),
  },
}))

// ---- mock：embedding（不调外部 API） ----
const createEmbedding = vi.fn()

vi.mock('@/server/services/ai/siliconflow', () => ({
  createEmbedding: (...args: unknown[]) => createEmbedding(...args),
}))

const { retrieve } = await import('../index')

/** 构造一个候选 chunk */
function chunk(id: string, embedding: number[], name = 'doc.md', index = 0) {
  return {
    id,
    index,
    content: `片段内容 ${id}`,
    embedding,
    documentId: `doc-${id}`,
    documentName: name,
    knowledgeBaseId: 'kb-a',
  }
}

const baseParams = {
  userId: 'user-a',
  apiKey: 'test-key',
  query: '测试问题',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('retrieve - 权限收敛', () => {
  it('用户没有该知识库时，返回「不存在或无权访问」，且不读取任何片段', async () => {
    // 关键：传入别人的 kb-id，findOwnedBaseIds 以 userId 收敛后返回空
    findOwnedBaseIds.mockResolvedValue([])

    const result = await retrieve({
      ...baseParams,
      knowledgeBaseId: 'kb-of-user-b',
    })

    expect(result.resultCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.content).toContain('不存在')
    expect(result.content).toContain('没有访问权限')
    // 绝不能在无归属的情况下继续去查 chunk
    expect(findChunksForRetrieval).not.toHaveBeenCalled()
    // 也不应该浪费一次 embedding 调用
    expect(createEmbedding).not.toHaveBeenCalled()
  })

  it('用户没有任何知识库时给出创建提示', async () => {
    findOwnedBaseIds.mockResolvedValue([])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('还没有创建任何知识库')
    expect(findChunksForRetrieval).not.toHaveBeenCalled()
  })

  it('检索范围始终带上当前用户 id（不接受客户端提交的 userId）', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockResolvedValue([[1, 0]])
    findChunksForRetrieval.mockResolvedValue([])

    await retrieve({ ...baseParams, userId: 'user-a' })

    expect(findOwnedBaseIds).toHaveBeenCalledWith('user-a', undefined)
    // 第三参为扫描上限，第二参是收敛后的知识库 id 列表
    const [passedUserId, passedBaseIds] = findChunksForRetrieval.mock.calls[0]
    expect(passedUserId).toBe('user-a')
    expect(passedBaseIds).toEqual(['kb-a'])
  })

  it('指定 knowledgeBaseId 时把它作为候选范围下推给 ownership 查询', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockResolvedValue([[1, 0]])
    findChunksForRetrieval.mockResolvedValue([])

    await retrieve({ ...baseParams, knowledgeBaseId: 'kb-a' })

    expect(findOwnedBaseIds).toHaveBeenCalledWith('user-a', ['kb-a'])
  })
})

describe('retrieve - 相似度与 Top-K', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockResolvedValue([[1, 0]])
  })

  it('按余弦相似度降序返回 Top-K，并过滤低于阈值的片段', async () => {
    findChunksForRetrieval.mockResolvedValue([
      chunk('c', [0, 1]), // cos = 0 → 低于阈值，应被过滤
      chunk('a', [1, 0]), // cos = 1
      chunk('d', [0.4, 0.9165], 'doc-d.md', 3), // cos ≈ 0.4 → 低于 0.5 阈值，被过滤
      chunk('b', [0.8, 0.6], 'doc-b.md', 1), // cos = 0.8
    ])

    const result = await retrieve({ ...baseParams, topK: 2 })

    expect(result.resultCount).toBe(2)
    expect(result.sources.map((s) => s.documentName)).toEqual(['doc.md', 'doc-b.md'])
    // 分数降序
    expect(result.sources[0].score).toBeGreaterThan(result.sources[1].score)
  })

  it('阈值边界：cos≈0.4 被默认阈值挡掉', async () => {
    findChunksForRetrieval.mockResolvedValue([chunk('d', [0.4, 0.9165], 'doc-d.md', 3)])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.content).toContain('未检索到')
  })

  it('阈值边界：cos≈0.55 通过默认阈值', async () => {
    findChunksForRetrieval.mockResolvedValue([chunk('e', [0.55, 0.8352], 'doc-e.md', 1)])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.sources[0].documentName).toBe('doc-e.md')
  })

  it('RAG_MIN_SCORE 环境变量可覆盖阈值', async () => {
    vi.stubEnv('RAG_MIN_SCORE', '0.2')
    try {
      findChunksForRetrieval.mockResolvedValue([chunk('d', [0.4, 0.9165], 'doc-d.md', 3)])

      const result = await retrieve({ ...baseParams })

      // 阈值降到 0.2 后，cos≈0.4 的片段即可通过
      expect(result.resultCount).toBe(1)
      expect(result.sources[0].documentName).toBe('doc-d.md')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('命中时把来源文件名写进给模型的内容里', async () => {
    findChunksForRetrieval.mockResolvedValue([chunk('a', [1, 0], '员工手册.md')])

    const result = await retrieve({ ...baseParams })

    expect(result.content).toContain('员工手册.md')
    expect(result.content).toContain('片段 1')
    expect(result.sources[0].documentName).toBe('员工手册.md')
  })

  it('维度不一致的片段被跳过，不计入命中数', async () => {
    findChunksForRetrieval.mockResolvedValue([
      chunk('a', [1, 0, 0]), // 3 维，与 query 的 2 维不一致 → 跳过
      chunk('b', [1, 0]), // 正常
    ])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.sources[0].documentName).toBe('doc.md')
  })

  it('候选为空时提示知识库还没有文档', async () => {
    findChunksForRetrieval.mockResolvedValue([])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('还没有可检索的文档片段')
  })
})

describe('retrieve - 检索不到时不编造', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockResolvedValue([[1, 0]])
  })

  it('全部低于阈值时，明确要求模型不要凭常识编造', async () => {
    findChunksForRetrieval.mockResolvedValue([chunk('c', [0, 1])])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.content).toContain('未检索到')
    expect(result.content).toContain('不要凭常识编造')
  })

  it('维度全部不一致时，提示可能需要重新入库', async () => {
    findChunksForRetrieval.mockResolvedValue([chunk('a', [1, 0, 0, 0])])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('向量维度不匹配')
    expect(result.content).toContain('重新入库')
  })
})

describe('retrieve - 错误处理', () => {
  it('空 query 直接失败，不做任何查询', async () => {
    const result = await retrieve({ ...baseParams, query: '   ' })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('query 不能为空')
    expect(findOwnedBaseIds).not.toHaveBeenCalled()
  })

  it('embedding 失败时返回明确的失败信息，而不是伪装成「无结果」', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockRejectedValue(new Error('上游 503'))

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('检索失败')
    expect(result.content).toContain('向量化')
    expect(result.content).toContain('上游 503')
  })

  it('数据库查询失败时返回明确的失败信息', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    createEmbedding.mockResolvedValue([[1, 0]])
    findChunksForRetrieval.mockRejectedValue(new Error('connection refused'))

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('检索失败')
    expect(result.content).toContain('connection refused')
  })
})

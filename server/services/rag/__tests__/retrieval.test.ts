/**
 * RAG 检索单元测试
 *
 * 用 mock 替换掉 Repository、embedding、rerank，从而在没有数据库、没有网络的情况下
 * 验证 retrieve() 的编排行为。覆盖：
 * - 权限收敛：别人的 knowledgeBaseId 只得到「不存在或无权访问」，且不读片段、不调 embedding
 * - 混合召回：向量通道 + 词法通道 → RRF 融合 → 精排 → 相对阈值
 * - 精排失败降级：上游抖动不能让检索整体失败
 * - 灰度双模型：库里有旧模型片段时，用旧模型再算一次 query 向量
 * - 「检索不到时不编造」：区分"库里没东西"与"有东西但没匹配上"
 * - 错误处理：空 query / 向量化失败 / DB 失败 → 明确失败信息而非静默空结果
 *
 * 这里刻意用 RAG_VECTOR_BACKEND=app（应用层精确扫描）跑主要用例：
 * pgvector 路径的 SQL 与 HNSW 召回无法用 mock 验证，属于集成测试与端到端验收的范围
 * （见 scripts/_verify-recall.mjs 的思路与 test-rag/ 的验收脚本）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- mock：Repository（不连数据库） ----
const findOwnedBaseIds = vi.fn()
const findChunkEmbeddingModels = vi.fn()
const countRetrievableChunks = vi.fn()
const findChunkPageForExactScan = vi.fn()
const searchChunksByVector = vi.fn()
const searchChunksByLexical = vi.fn()

vi.mock('@/server/repositories/knowledge.repository', () => ({
  KnowledgeRepository: {
    findOwnedBaseIds: (...args: unknown[]) => findOwnedBaseIds(...args),
    findChunkEmbeddingModels: (...args: unknown[]) => findChunkEmbeddingModels(...args),
    countRetrievableChunks: (...args: unknown[]) => countRetrievableChunks(...args),
    findChunkPageForExactScan: (...args: unknown[]) => findChunkPageForExactScan(...args),
    searchChunksByVector: (...args: unknown[]) => searchChunksByVector(...args),
    searchChunksByLexical: (...args: unknown[]) => searchChunksByLexical(...args),
  },
}))

// ---- mock：embedding 缓存（不入库） ----
vi.mock('@/server/repositories/embedding-cache.repository', () => ({
  EmbeddingCacheRepository: {
    findMany: vi.fn().mockResolvedValue([]),
    saveMany: vi.fn().mockResolvedValue(0),
    recordHits: vi.fn().mockResolvedValue(undefined),
  },
}))

// ---- mock：外部 AI（不调 API） ----
const createEmbedding = vi.fn()
const createRerank = vi.fn()

vi.mock('@/server/services/ai/siliconflow', () => ({
  createEmbedding: (...args: unknown[]) => createEmbedding(...args),
  createRerank: (...args: unknown[]) => createRerank(...args),
}))

const { retrieve } = await import('../index')
const { resetVectorCapabilityCache } = await import('../vector-store')

/** 1024 维 one-hot 向量：与 EMBEDDING_MODELS 声明的维度一致，cosine 只可能为 1 或 0 */
function vec(index = 0): number[] {
  const v = new Array(1024).fill(0)
  v[index] = 1
  return v
}

/** 构造一个候选 chunk */
function chunk(
  id: string,
  options: { index?: number; name?: string; model?: string | null } = {}
) {
  return {
    id,
    index: options.index ?? 0,
    content: `片段内容 ${id}`,
    documentId: `doc-${id}`,
    documentName: options.name ?? 'doc.md',
    knowledgeBaseId: 'kb-a',
    embedding: vec(0),
    embeddingModel: options.model === undefined ? 'BAAI/bge-m3' : options.model,
  }
}

/** 让精确扫描一次性返回给定候选（分页在 vector-store 里，单测不模拟多页） */
function scanReturns(chunks: Array<ReturnType<typeof chunk>>) {
  findChunkPageForExactScan.mockImplementation(
    async (params: { cursor: string | null }) => (params.cursor ? [] : chunks)
  )
}

/**
 * 词法通道的 mock 形状
 *
 * 注意 mock 的是 KnowledgeRepository.searchChunksByLexical（返回 ScoredChunk[]），
 * 不是 lexical.ts 的 searchByLexical（返回 { enabled, hits, terms }）——
 * 前者是 SQL 层，后者会把它包一层。形状搞错会让 lexical.ts 拿到对象当数组用，
 * 结果是通道抛错降级、命中数为 0，而非报错（这个坑踩过一次，记在这里）。
 */
function lexicalReturns(entries: Array<{ id: string; score: number; chunk: ReturnType<typeof chunk> }>) {
  searchChunksByLexical.mockResolvedValue(
    entries.map((e) => ({ chunk: e.chunk, score: e.score }))
  )
}

const baseParams = {
  userId: 'user-a',
  apiKey: 'test-key',
  query: '测试问题',
}

beforeEach(() => {
  vi.clearAllMocks()
  // 每个用例都必须从干净的环境变量开始：vitest 默认 unstubEnvs=false，
  // 上一个用例 stub 的 RAG_RERANK / RAG_VECTOR_MIN_SCORE 会泄漏到下一个用例，
  // 表现为"单独跑能过、一起跑就挂"（这个坑也踩过一次）
  vi.unstubAllEnvs()
  // 主要用例走应用层精确扫描：pgvector 能力探测需要数据库，单测里绕过它
  vi.stubEnv('RAG_VECTOR_BACKEND', 'app')
  resetVectorCapabilityCache()
  findChunkEmbeddingModels.mockResolvedValue([
    { model: 'BAAI/bge-m3', dim: 1024, count: 2 },
  ])
  countRetrievableChunks.mockResolvedValue(2)
  createEmbedding.mockResolvedValue([vec(0)])
  createRerank.mockResolvedValue([])
  findChunkPageForExactScan.mockResolvedValue([])
  searchChunksByLexical.mockResolvedValue([])
})

describe('retrieve - 权限收敛', () => {
  it('用户没有该知识库时，返回「不存在或无权访问」，且不读取任何片段', async () => {
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
    expect(findChunkPageForExactScan).not.toHaveBeenCalled()
    expect(searchChunksByLexical).not.toHaveBeenCalled()
    // 也不应该浪费一次 embedding 调用
    expect(createEmbedding).not.toHaveBeenCalled()
  })

  it('用户没有任何知识库时给出创建提示', async () => {
    findOwnedBaseIds.mockResolvedValue([])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('还没有创建任何知识库')
    expect(createEmbedding).not.toHaveBeenCalled()
  })

  it('检索范围始终带上当前用户 id（不接受客户端提交的 userId）', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    scanReturns([])
    findChunkEmbeddingModels.mockResolvedValue([])

    await retrieve({ ...baseParams, userId: 'user-a' })

    expect(findOwnedBaseIds).toHaveBeenCalledWith('user-a', undefined)
  })

  it('指定 knowledgeBaseId 时把它作为候选范围下推给 ownership 查询', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    findChunkEmbeddingModels.mockResolvedValue([])

    await retrieve({ ...baseParams, knowledgeBaseId: 'kb-a' })

    expect(findOwnedBaseIds).toHaveBeenCalledWith('user-a', ['kb-a'])
  })
})

describe('retrieve - 混合召回与融合', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
  })

  it('向量与词法都命中时，来源里标出两个通道', async () => {
    const a = chunk('a', { name: 'doc-a.md' })
    const b = chunk('b', { name: 'doc-b.md' })
    scanReturns([a, b])
    lexicalReturns([{ id: 'b', score: 3.2, chunk: b }])

    const result = await retrieve({ ...baseParams, topK: 5 })

    expect(result.resultCount).toBe(2)
    const sources = result.sources
    const sourceB = sources.find((s) => s.documentName === 'doc-b.md')!
    const sourceA = sources.find((s) => s.documentName === 'doc-a.md')!
    expect(sourceB.channels).toEqual(['vector', 'lexical'])
    expect(sourceB.lexicalScore).toBe(3.2)
    expect(sourceA.channels).toEqual(['vector'])
  })

  it('只有词法通道命中时仍然返回结果（混合检索的意义）', async () => {
    // 向量通道扫描不到任何片段（例如维度不匹配被跳过），但字面命中
    const c = chunk('c', { name: 'doc-c.md' })
    scanReturns([])
    lexicalReturns([{ id: 'c', score: 5.5, chunk: c }])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.sources[0].documentName).toBe('doc-c.md')
    expect(result.sources[0].channels).toEqual(['lexical'])
  })

  it('词法通道失败不会让整条检索失败，只会被记入降级原因', async () => {
    const a = chunk('a')
    scanReturns([a])
    searchChunksByLexical.mockRejectedValue(new Error('GIN 索引缺失'))

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.debug.degraded.join(' ')).toContain('词法检索失败')
  })

  it('精排生效时按精排分排序，并把精排分写进 debug', async () => {
    const a = chunk('a', { name: 'doc-a.md' })
    const b = chunk('b', { name: 'doc-b.md' })
    // 向量通道把 a 排前，但精排认为 b 更相关
    scanReturns([a, b])
    createRerank.mockResolvedValue([
      { index: 1, score: 0.91 },
      { index: 0, score: 0.88 },
    ])

    const result = await retrieve({ ...baseParams })

    expect(createRerank).toHaveBeenCalledTimes(1)
    expect(result.sources[0].documentName).toBe('doc-b.md')
    expect(result.debug.rerank.applied).toBe(true)
    expect(result.sources[0].rerankScore).toBeCloseTo(0.91, 4)
  })

  it('精排接口报错时降级为融合顺序，检索仍然返回结果', async () => {
    const a = chunk('a', { name: 'doc-a.md' })
    scanReturns([a])
    createRerank.mockRejectedValue(new Error('上游 503'))

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.debug.rerank.applied).toBe(false)
    expect(result.debug.degraded.join(' ')).toContain('精排未生效')
  })
})

describe('retrieve - 阈值', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
  })

  it('精排后低于「相对最好命中」的候选被切掉', async () => {
    const a = chunk('a', { name: 'doc-a.md' })
    const b = chunk('b', { name: 'doc-b.md' })
    const c = chunk('c', { name: 'doc-c.md' })
    scanReturns([a, b, c])
    // 0.9 与 0.8 保留（>= 0.25×0.9），0.1 被切掉
    createRerank.mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.8 },
      { index: 2, score: 0.1 },
    ])

    const result = await retrieve({ ...baseParams, topK: 5 })

    expect(result.resultCount).toBe(2)
    expect(result.sources.map((s) => s.documentName)).toEqual(['doc-a.md', 'doc-b.md'])
    expect(result.debug.threshold.mode).toBe('rerank')
  })

  it('精排关闭时按融合名次截断，而不是靠 RRF 分的比例阈值', async () => {
    vi.stubEnv('RAG_RERANK', '0')
    const candidates = Array.from({ length: 20 }, (_, i) =>
      chunk(`c${i}`, { name: `doc-${i}.md` })
    )
    scanReturns(candidates)

    const result = await retrieve({ ...baseParams, topK: 20 })

    expect(createRerank).not.toHaveBeenCalled()
    expect(result.debug.rerank.applied).toBe(false)
    expect(result.debug.threshold.mode).toBe('fusion')
    // 默认 RAG_FUSION_TOP_N = max(topK*3, 15) = 60 → 20 条全留
    expect(result.resultCount).toBe(20)

    // 收紧名次截断后只剩前 5
    vi.stubEnv('RAG_FUSION_TOP_N', '5')
    const trimmed = await retrieve({ ...baseParams, topK: 20 })
    expect(trimmed.resultCount).toBe(5)
  })

  it('RAG_FUSION_MIN_RATIO 可叠加比例阈值（默认关闭）', async () => {
    vi.stubEnv('RAG_RERANK', '0')
    const a = chunk('a', { name: 'doc-a.md' })
    const b = chunk('b', { name: 'doc-b.md' })
    scanReturns([a, b])

    // 默认 0：不按比例切尾
    const kept = await retrieve({ ...baseParams, topK: 5 })
    expect(kept.resultCount).toBe(2)

    // RRF 分第 2/第 1 的比值是 61/62 ≈ 0.9839，所以只有 >0.9839 的比例才会切掉第 2 名
    // （这也是为什么"比例阈值"不能当默认手段：它在 RRF 的压缩尺度上几乎不起作用）
    vi.stubEnv('RAG_FUSION_MIN_RATIO', '0.99')
    const dropped = await retrieve({ ...baseParams, topK: 5 })
    expect(dropped.resultCount).toBe(1)
    expect(dropped.sources[0].documentName).toBe('doc-a.md')
  })

  it('精排不可用时，余弦分过低且无词法支持的候选被绝对下限挡掉', async () => {
    vi.stubEnv('RAG_RERANK', '0')
    const a = chunk('a', { name: 'doc-a.md' }) // 与 query 同向，cos=1
    const b = { ...chunk('b', { name: 'doc-b.md' }), embedding: vec(7) } // cos=0
    scanReturns([a, b])

    const result = await retrieve({ ...baseParams })

    expect(result.sources.map((s) => s.documentName)).toEqual(['doc-a.md'])
  })

  it('只被词法通道命中的片段不会被余弦下限否掉', async () => {
    vi.stubEnv('RAG_RERANK', '0')
    const c = chunk('c', { name: 'doc-c.md' })
    scanReturns([])
    lexicalReturns([{ id: 'c', score: 4, chunk: c }])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.sources[0].documentName).toBe('doc-c.md')
  })

  it('RAG_RERANK_MIN_RATIO 可覆盖相对阈值', async () => {
    const a = chunk('a', { name: 'doc-a.md' })
    const b = chunk('b', { name: 'doc-b.md' })
    scanReturns([a, b])
    createRerank.mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.3 },
    ])

    // 默认 0.25 → 0.3 >= 0.225 保留；调到 0.9 后只剩第一条
    const kept = await retrieve({ ...baseParams })
    expect(kept.resultCount).toBe(2)

    vi.stubEnv('RAG_RERANK_MIN_RATIO', '0.9')
    const dropped = await retrieve({ ...baseParams })
    expect(dropped.resultCount).toBe(1)
    expect(dropped.sources[0].documentName).toBe('doc-a.md')
  })
})

describe('retrieve - 灰度双模型', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
  })

  it('库里有旧模型片段时，用旧模型再算一次 query 向量', async () => {
    findChunkEmbeddingModels.mockResolvedValue([
      { model: 'BAAI/bge-m3', dim: 1024, count: 5 },
      { model: 'Qwen/Qwen3-Embedding-0.6B', dim: 1024, count: 2 },
    ])
    createEmbedding.mockResolvedValue([vec(0)])
    scanReturns([chunk('a')])

    const result = await retrieve({ ...baseParams })

    // 当前模型一次 + 旧模型一次
    expect(createEmbedding).toHaveBeenCalledTimes(2)
    const models = createEmbedding.mock.calls.map(
      (call) => (call[1] as { model: string }).model
    )
    expect(models).toContain('BAAI/bge-m3')
    expect(models).toContain('Qwen/Qwen3-Embedding-0.6B')
    expect(result.debug.vector.legacyModels).toEqual(['Qwen/Qwen3-Embedding-0.6B'])
  })

  it('RAG_GRAY_LEGACY_QUERY=0 时只用当前模型，并说明有旧模型未参与', async () => {
    vi.stubEnv('RAG_GRAY_LEGACY_QUERY', '0')
    findChunkEmbeddingModels.mockResolvedValue([
      { model: 'BAAI/bge-m3', dim: 1024, count: 5 },
      { model: 'BAAI/bge-large-zh-v1.5', dim: 1024, count: 2 },
    ])
    scanReturns([chunk('a')])

    const result = await retrieve({ ...baseParams })

    expect(createEmbedding).toHaveBeenCalledTimes(1)
    expect(result.debug.vector.legacyModels).toEqual([])
  })

  it('未标注模型的片段不参与向量检索，并在降级原因里提示回填', async () => {
    findChunkEmbeddingModels.mockResolvedValue([
      { model: 'BAAI/bge-m3', dim: 1024, count: 5 },
      { model: null, dim: null, count: 3 },
    ])
    scanReturns([])
    countRetrievableChunks.mockResolvedValue(8)

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('未标注 embedding 模型')
    expect(result.content).toContain('rag:backfill')
  })
})

describe('retrieve - 检索不到时不编造', () => {
  beforeEach(() => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
  })

  it('库里完全没有片段时，提示先上传文档', async () => {
    countRetrievableChunks.mockResolvedValue(0)
    scanReturns([])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('还没有可检索的文档片段')
  })

  it('有片段但全部被阈值切掉时，要求模型不要凭常识编造', async () => {
    scanReturns([chunk('a')])
    countRetrievableChunks.mockResolvedValue(1)
    createRerank.mockResolvedValue([{ index: 0, score: 0.02 }]) // 低于绝对下限 0.05

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.sources).toEqual([])
    expect(result.content).toContain('未检索到')
    expect(result.content).toContain('不要凭常识编造')
  })

  it('向量维度全部不匹配时，提示需要重新入库', async () => {
    const wrong = { ...chunk('a'), embedding: new Array(768).fill(0.1) }
    scanReturns([wrong])
    countRetrievableChunks.mockResolvedValue(1)

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('向量维度')
    expect(result.content).toContain('重新入库')
    expect(result.debug.vector.dimMismatch).toBe(1)
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

  it('向量通道数据库失败时返回明确的失败信息', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    findChunkPageForExactScan.mockRejectedValue(new Error('connection refused'))

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(0)
    expect(result.content).toContain('检索失败')
    expect(result.content).toContain('connection refused')
  })

  it('模型分布查询失败不影响检索，只记录降级原因', async () => {
    findOwnedBaseIds.mockResolvedValue(['kb-a'])
    findChunkEmbeddingModels.mockRejectedValue(new Error('relation does not exist'))
    scanReturns([chunk('a')])

    const result = await retrieve({ ...baseParams })

    expect(result.resultCount).toBe(1)
    expect(result.debug.degraded.join(' ')).toContain('模型分布查询失败')
  })
})

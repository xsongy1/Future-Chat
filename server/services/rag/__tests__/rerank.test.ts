/**
 * RAG 精排单测
 *
 * 用 mock 替换掉 createRerank，从而在没有网络的情况下验证精排的取舍。
 *
 * 这里最重要的断言不是「排序对不对」，而是「任何失败都必须返回 null 而不是抛错」：
 * 调用方靠 null 决定回退到 RRF 顺序，一旦精排抛错，整条知识库检索就废了。
 * 因此每个失败分支都同时断言「返回 null」「没有多余的 API 调用」「打了一条中文告警」。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- mock：精排 API（不调外部接口） ----
const createRerank = vi.fn()

vi.mock('@/server/services/ai/siliconflow', () => ({
  createRerank: (...args: unknown[]) => createRerank(...args),
}))

const {
  RERANK_MAX_CHARS,
  isRerankEnabled,
  rerankChunks,
  resolveRerankModel,
  resolveRerankTopN,
} = await import('../rerank')

const DEFAULT_RERANK_MODEL = 'BAAI/bge-reranker-v2-m3'

/** 构造一个候选片段 */
function candidate(id: string, text = `片段 ${id}`) {
  return { id, text }
}

const baseParams = {
  apiKey: 'test-key',
  query: '报销流程是怎样的',
}

/** 收集 console.warn 输出，断言失败原因确实被记录下来（而不是静默降级） */
const warnings: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  warnings.length = 0
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '))
  })

  // 基线：固定成「启用 + 默认模型 + 用调用方给的 topN」，
  // 避免开发机 shell 里残留的 RAG_* 变量让测试时好时坏
  vi.stubEnv('RAG_RERANK', '')
  vi.stubEnv('RAG_RERANK_MODEL', '')
  vi.stubEnv('RAG_RERANK_TOP_N', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('rerank - 开关与配置解析', () => {
  it('默认启用，只有 0 / false / off 才关闭（大小写不敏感）', () => {
    expect(isRerankEnabled()).toBe(true)

    for (const value of ['0', 'false', 'off', 'FALSE', 'Off', ' off ']) {
      vi.stubEnv('RAG_RERANK', value)
      expect(isRerankEnabled(), `RAG_RERANK=${value}`).toBe(false)
    }

    for (const value of ['1', 'true', 'on', 'yes']) {
      vi.stubEnv('RAG_RERANK', value)
      expect(isRerankEnabled(), `RAG_RERANK=${value}`).toBe(true)
    }
  })

  it('resolveRerankModel 未配置时返回白名单默认模型', () => {
    expect(resolveRerankModel()).toBe(DEFAULT_RERANK_MODEL)
    expect(warnings).toEqual([])
  })

  it('resolveRerankModel 认出白名单内的模型', () => {
    // 用白名单里真实存在（2026-08 实测可用）的非默认模型：
    // BAAI/bge-reranker-v2-minicpm-layerwise 实测报 400 Model does not exist，已从白名单移除
    vi.stubEnv('RAG_RERANK_MODEL', 'Qwen/Qwen3-Reranker-0.6B')
    try {
      expect(resolveRerankModel()).toBe('Qwen/Qwen3-Reranker-0.6B')
      expect(warnings).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolveRerankModel 对未知值告警并回退默认模型，而不是抛错', () => {
    vi.stubEnv('RAG_RERANK_MODEL', 'gpt-9000')
    try {
      // 关键：环境变量写错只该降低排序质量，绝不能把整条检索带崩
      expect(resolveRerankModel()).toBe(DEFAULT_RERANK_MODEL)
      expect(warnings.join('\n')).toContain(
        'RAG_RERANK_MODEL="gpt-9000" 不在 RERANK_MODELS 白名单中'
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolveRerankTopN 只接受正整数，0 / 负数 / 非数字都回退', () => {
    expect(resolveRerankTopN(5)).toBe(5)

    vi.stubEnv('RAG_RERANK_TOP_N', '7')
    try {
      expect(resolveRerankTopN(5)).toBe(7)
    } finally {
      vi.unstubAllEnvs()
    }

    for (const value of ['0', '-3', 'abc', '2.5']) {
      vi.stubEnv('RAG_RERANK_TOP_N', value)
      expect(resolveRerankTopN(5), `RAG_RERANK_TOP_N=${value}`).toBe(5)
    }
    vi.unstubAllEnvs()

    // 回退必须留下痕迹，否则"配置没生效"会被当成框架 bug 排查
    expect(warnings.join('\n')).toContain('不是正整数')
  })
})

describe('rerankChunks - 降级为 null 的路径', () => {
  it('RAG_RERANK=0 时返回 null，且完全不调用精排 API', async () => {
    vi.stubEnv('RAG_RERANK', '0')
    try {
      const result = await rerankChunks({
        ...baseParams,
        candidates: [candidate('a')],
      })

      expect(result).toBeNull()
      expect(createRerank).not.toHaveBeenCalled()
      expect(warnings.join('\n')).toContain('RAG_RERANK 已关闭')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('候选为空时返回 null，且不调用 API', async () => {
    const result = await rerankChunks({ ...baseParams, candidates: [] })

    expect(result).toBeNull()
    expect(createRerank).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('没有候选片段')
  })

  it('上游 reject 时 resolve 为 null（而不是抛出），并写明失败原因', async () => {
    createRerank.mockRejectedValue(
      new Error('SiliconFlow rerank error: 503 - busy')
    )

    await expect(
      rerankChunks({ ...baseParams, candidates: [candidate('a')] })
    ).resolves.toBeNull()

    expect(warnings.join('\n')).toContain(
      '精排失败，沿用融合顺序：SiliconFlow rerank error: 503 - busy'
    )
  })

  it('上游超时（AbortError，调用方未取消）也降级为 null', async () => {
    createRerank.mockRejectedValue(
      Object.assign(new Error('This operation was aborted'), {
        name: 'AbortError',
      })
    )

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('精排失败')
  })

  it('响应不是数组时降级为 null', async () => {
    createRerank.mockResolvedValue(null)

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('响应不是数组')
  })

  it('响应是空数组时降级为 null', async () => {
    createRerank.mockResolvedValue([])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('上游返回空结果')
  })

  it('结果下标全部越界时降级为 null', async () => {
    createRerank.mockResolvedValue([{ index: 9, score: 0.99 }])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('越界')
    expect(warnings.join('\n')).toContain('全部不可用')
  })

  it('结果分数全部无效时降级为 null', async () => {
    createRerank.mockResolvedValue([
      { index: 0, score: null },
      { index: 1, score: undefined },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a'), candidate('b')],
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('无效分数')
  })

  it('非法 topN 直接跳过精排，不浪费一次请求', async () => {
    for (const topN of [0, -2, 1.5, Number.NaN]) {
      createRerank.mockClear()
      warnings.length = 0

      const result = await rerankChunks({
        ...baseParams,
        candidates: [candidate('a')],
        topN,
      })

      expect(result).toBeNull()
      expect(createRerank).not.toHaveBeenCalled()
      expect(warnings.join('\n')).toContain('不是正整数')
    }
  })

  it('调用方 signal 已 aborted 时返回 null，不再发请求', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
      signal: controller.signal,
    })

    expect(result).toBeNull()
    expect(createRerank).not.toHaveBeenCalled()
    expect(warnings.join('\n')).toContain('请求已取消')
  })

  it('请求途中被取消也 resolve 为 null，让被取消的对话优雅结束', async () => {
    const controller = new AbortController()
    createRerank.mockImplementation(async () => {
      controller.abort()
      throw Object.assign(new Error('This operation was aborted'), {
        name: 'AbortError',
      })
    })

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
      signal: controller.signal,
    })

    expect(result).toBeNull()
    expect(warnings.join('\n')).toContain('请求已取消')
  })
})

describe('rerankChunks - 正常路径', () => {
  it('乱序 index 映射回正确的 id，并按分数降序返回', async () => {
    createRerank.mockResolvedValue([
      { index: 2, score: 0.95 },
      { index: 0, score: 0.41 },
      { index: 1, score: 0.72 },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a'), candidate('b'), candidate('c')],
    })

    expect(result).toEqual([
      { id: 'c', score: 0.95 },
      { id: 'b', score: 0.72 },
      { id: 'a', score: 0.41 },
    ])
    expect(createRerank).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({
        model: DEFAULT_RERANK_MODEL,
        query: baseParams.query,
        documents: ['片段 a', '片段 b', '片段 c'],
        topN: 3,
      })
    )
  })

  it('越界 index 被丢弃，不会把分数贴到错误的片段上', async () => {
    createRerank.mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 7, score: 0.99 },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a'), candidate('b')],
    })

    expect(result).toEqual([{ id: 'a', score: 0.9 }])
    expect(warnings.join('\n')).toContain('精排丢弃越界结果：index=7')
  })

  it('无效分数的那条被丢弃，其余照常返回', async () => {
    createRerank.mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: Number.NaN },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [candidate('a'), candidate('b')],
    })

    expect(result).toEqual([{ id: 'a', score: 0.9 }])
    expect(warnings.join('\n')).toContain('精排丢弃无效分数：index=1')
  })

  it('topN 同时限制发送的文档数与返回条数', async () => {
    createRerank.mockResolvedValue([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.5 },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [
        candidate('a'),
        candidate('b'),
        candidate('c'),
        candidate('d'),
      ],
      topN: 2,
    })

    // 多发一篇就白付一对 query-文档的费用，所以只发会被保留的那几条
    expect(createRerank).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({ documents: ['片段 a', '片段 b'], topN: 2 })
    )
    expect(result).toHaveLength(2)
    expect(result).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.5 },
    ])
  })

  it('RAG_RERANK_TOP_N 在未显式传 topN 时生效', async () => {
    vi.stubEnv('RAG_RERANK_TOP_N', '1')
    try {
      createRerank.mockResolvedValue([{ index: 0, score: 0.8 }])

      const result = await rerankChunks({
        ...baseParams,
        candidates: [candidate('a'), candidate('b')],
      })

      expect(createRerank).toHaveBeenCalledWith(
        'test-key',
        expect.objectContaining({ documents: ['片段 a'], topN: 1 })
      )
      expect(result).toEqual([{ id: 'a', score: 0.8 }])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('显式传 model 时不再读环境变量', async () => {
    vi.stubEnv('RAG_RERANK_MODEL', 'gpt-9000')
    try {
      createRerank.mockResolvedValue([{ index: 0, score: 0.8 }])

      await rerankChunks({
        ...baseParams,
        candidates: [candidate('a')],
        model: 'BAAI/bge-reranker-v2-m3',
      })

      expect(createRerank).toHaveBeenCalledWith(
        'test-key',
        expect.objectContaining({ model: 'BAAI/bge-reranker-v2-m3' })
      )
      expect(warnings.join('\n')).toBe('')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('候选文本按 RERANK_MAX_CHARS 截断后才发送', async () => {
    createRerank.mockResolvedValue([{ index: 0, score: 0.5 }])
    const longText = '知'.repeat(RERANK_MAX_CHARS + 500)

    await rerankChunks({
      ...baseParams,
      candidates: [{ id: 'a', text: longText }],
    })

    expect(RERANK_MAX_CHARS).toBe(1000)
    expect(createRerank).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({
        documents: [longText.slice(0, RERANK_MAX_CHARS)],
      })
    )
  })

  it('重复的 id 只保留最高分，不占两个名额', async () => {
    createRerank.mockResolvedValue([
      { index: 0, score: 0.3 },
      { index: 1, score: 0.9 },
      { index: 2, score: 0.6 },
    ])

    const result = await rerankChunks({
      ...baseParams,
      candidates: [
        { id: 'dup', text: 'x' },
        { id: 'dup', text: 'y' },
        { id: 'z', text: 'z' },
      ],
    })

    expect(result).toEqual([
      { id: 'dup', score: 0.9 },
      { id: 'z', score: 0.6 },
    ])
  })

  it('把调用方的 signal 透传给 API，便于用户停止生成时中断请求', async () => {
    const controller = new AbortController()
    createRerank.mockResolvedValue([{ index: 0, score: 0.8 }])

    await rerankChunks({
      ...baseParams,
      candidates: [candidate('a')],
      signal: controller.signal,
    })

    expect(createRerank).toHaveBeenCalledWith(
      'test-key',
      expect.objectContaining({ signal: controller.signal })
    )
  })
})

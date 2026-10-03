/**
 * Embedding：内容哈希 + 缓存 + 批量向量化
 *
 * 这里是"钱"最集中的地方（每次向量化都是一次付费 API 调用），因此有三层保护：
 *   1. 内容哈希（sha256）：同一段文本永远得到同一个键，是缓存与去重的基础
 *   2. EmbeddingCache：命中就不调用 API（跨文档、跨用户、跨重建复用）
 *   3. 批内去重：同一批里出现两次相同文本时只请求一次
 *
 * 哈希用的是「即将送去向量化的那段文本」本身，不是 chunk 下标或其他间接标识：
 * 只有当键与真正参与计算的内容一一对应时，缓存才不会在文本被改动后错误命中。
 */

import { createHash } from 'crypto'
import { createEmbedding } from '@/server/services/ai/siliconflow'
import { getDefaultEmbeddingModel, getEmbeddingModelById } from '@/shared/constants/models'
import { EmbeddingCacheRepository } from '@/server/repositories/embedding-cache.repository'

/** 单次向量化请求的最大文本数（批量过小会让大文档入库变得很慢，过大容易触发上游限流） */
export const EMBEDDING_BATCH_SIZE = 32

/** 文本内容哈希（sha256 十六进制） */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 正文规范化：与 chunker 的规范化规则保持一致（统一换行 + 去首尾空白）
 *
 * 必须一致，否则「同一份文件」在重传时会算出不同的 hash，
 * 文档级去重会失效，用户会把同一份文件存两遍。
 */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n?/g, '\n').trim()
}

/** 解析当前使用的 Embedding 模型（env 可覆盖白名单默认值） */
export function resolveEmbeddingModelId(): string {
  const fromEnv = process.env.EMBEDDING_MODEL
  if (fromEnv) {
    const info = getEmbeddingModelById(fromEnv)
    if (!info) {
      throw new Error(
        `EMBEDDING_MODEL="${fromEnv}" 不在共享白名单中，请先在 shared/constants/models.ts 的 EMBEDDING_MODELS 中登记`
      )
    }
    return info.id
  }
  return getDefaultEmbeddingModel().id
}

/** 白名单声明的向量维度（写入 chunk.embeddingDim 的期望值） */
export function resolveEmbeddingDim(model: string): number {
  return getEmbeddingModelById(model)?.dimensions ?? 0
}

export interface EmbedBatchResult {
  /** 与入参 texts 顺序一致 */
  embeddings: number[][]
  model: string
  dim: number
  /** 命中缓存、未产生 API 调用的条数 */
  cacheHits: number
  /** 真正调用 API 的条数（批内去重后） */
  embeddedCount: number
}

/**
 * 批量向量化（带缓存）
 *
 * @param params.onProgress - 每完成一批回调一次（异步入库用它写回进度）
 */
export async function embedTexts(params: {
  apiKey: string
  texts: string[]
  model?: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void | Promise<void>
}): Promise<EmbedBatchResult> {
  const { apiKey, texts, signal, onProgress } = params
  const model = params.model ?? resolveEmbeddingModelId()

  if (texts.length === 0) {
    return {
      embeddings: [],
      model,
      dim: resolveEmbeddingDim(model),
      cacheHits: 0,
      embeddedCount: 0,
    }
  }

  const hashes = texts.map((text) => sha256(text))

  // 1. 查缓存：按 hash 去重后一次性查（重复文本只需查一次）
  const uniqueHashes = [...new Set(hashes)]
  const cached = await EmbeddingCacheRepository.findMany(uniqueHashes, model)
  const vectorByHash = new Map(cached.map((c) => [c.contentHash, c.embedding]))

  // 2. 找出未命中的文本（同一批内相同文本只向量化一次）
  const pendingHashToText = new Map<string, string>()
  hashes.forEach((hash, i) => {
    if (!vectorByHash.has(hash) && !pendingHashToText.has(hash)) {
      pendingHashToText.set(hash, texts[i])
    }
  })

  const pending = [...pendingHashToText.entries()]
  const newVectors: Array<{ contentHash: string; model: string; embedding: number[]; dim: number }> =
    []

  for (let i = 0; i < pending.length; i += EMBEDDING_BATCH_SIZE) {
    signal?.throwIfAborted()
    const batch = pending.slice(i, i + EMBEDDING_BATCH_SIZE)
    const result = await createEmbedding(apiKey, {
      model,
      input: batch.map(([, text]) => text),
      signal,
    })

    if (result.length !== batch.length) {
      throw new Error(
        `Embedding 返回数量不匹配：期望 ${batch.length}，实际 ${result.length}`
      )
    }

    batch.forEach(([hash], index) => {
      const embedding = result[index]
      vectorByHash.set(hash, embedding)
      newVectors.push({
        contentHash: hash,
        model,
        embedding,
        dim: embedding.length,
      })
    })

    // 已完成的批次数（含缓存命中的部分按整体进度计）
    await onProgress?.(
      Math.min(i + EMBEDDING_BATCH_SIZE, pending.length),
      pending.length
    )
  }

  // 3. 回写缓存（写失败不影响本次入库，只少一次复用机会）
  if (newVectors.length > 0) {
    try {
      await EmbeddingCacheRepository.saveMany(newVectors)
    } catch (error) {
      console.warn(
        '[RAG] embedding 缓存写入失败（不影响本次入库）:',
        error instanceof Error ? error.message : error
      )
    }
  }

  if (cached.length > 0) {
    await EmbeddingCacheRepository.recordHits(
      cached.map((c) => c.contentHash),
      model
    )
  }

  const dim = resolveEmbeddingDim(model)
  const embeddings = hashes.map((hash) => {
    const vector = vectorByHash.get(hash)
    if (!vector) {
      throw new Error(`向量化结果缺失：hash=${hash.slice(0, 12)}…`)
    }
    if (dim > 0 && vector.length !== dim) {
      throw new Error(
        `Embedding 维度与白名单不一致：模型 ${model} 声明 ${dim} 维，实际 ${vector.length} 维`
      )
    }
    return vector
  })

  return {
    embeddings,
    model,
    dim: dim > 0 ? dim : (embeddings[0]?.length ?? 0),
    cacheHits: hashes.filter((h) => cached.some((c) => c.contentHash === h)).length,
    embeddedCount: newVectors.length,
  }
}

/**
 * 单条查询向量化（同样走缓存：同一个问题反复问很常见）
 */
export async function embedQuery(params: {
  apiKey: string
  query: string
  model?: string
  signal?: AbortSignal
}): Promise<{ vector: number[]; model: string; dim: number; cacheHit: boolean }> {
  const result = await embedTexts({
    apiKey: params.apiKey,
    texts: [params.query],
    model: params.model,
    signal: params.signal,
  })

  return {
    vector: result.embeddings[0],
    model: result.model,
    dim: result.dim,
    cacheHit: result.cacheHits > 0,
  }
}

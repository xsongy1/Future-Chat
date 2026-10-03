/**
 * RAG 精排（rerank）
 *
 * RRF 只看名次、不看内容，遇到"关键词命中但答非所问"的片段会照样把它排前面。
 * cross-encoder 把 query 与候选拼在一起逐对打分，能纠正这类排序，所以这一步放在
 * 融合之后、组装上下文之前。
 *
 * 本模块的硬约束：任何异常都返回 null 而不抛错。精排是加分项，上游抖动/超时/返回
 * 异常都不该让整条检索失败——调用方拿到 null 就沿用融合顺序。
 * 每个失败分支都会打一条中文 warn，否则"检索突然变差"会变成一个查不出原因的哑故障。
 */

import {
  RERANK_MODELS,
  getDefaultRerankModel,
  getRerankModelById,
} from '@/shared/constants/models'
import { createRerank } from '@/server/services/ai/siliconflow'

export interface RerankCandidate {
  id: string
  text: string
}

export interface RerankedHit {
  id: string
  score: number
}

/** 关闭开关的取值：与项目其它布尔环境变量保持一致 */
const DISABLED_VALUES = ['0', 'false', 'off']

/**
 * 精排是否启用（默认启用）
 *
 * 默认开启：默认模型与端点都可用时，精排只有收益；真出问题由 rerankChunks 的
 * 失败兜底降级，而不是让用户默认少一层召回质量。
 */
export function isRerankEnabled(): boolean {
  const raw = process.env.RAG_RERANK?.trim().toLowerCase()
  if (!raw) return true
  return !DISABLED_VALUES.includes(raw)
}

/**
 * 解析精排模型（env RAG_RERANK_MODEL，非法值回退默认）
 *
 * 与 resolveEmbeddingModelId 不同，这里刻意不抛错：环境变量写错只是排序质量回退，
 * 一旦抛错会让整个知识库检索不可用，代价和收益完全不对等。
 */
export function resolveRerankModel(): string {
  const raw = process.env.RAG_RERANK_MODEL?.trim()
  if (!raw) return getDefaultRerankModel().id

  const model = getRerankModelById(raw)
  if (!model) {
    console.warn(
      `[RAG] RAG_RERANK_MODEL="${raw}" 不在 RERANK_MODELS 白名单中，已回退到默认模型 ` +
        `${getDefaultRerankModel().id}。可选值：${RERANK_MODELS.map((m) => m.id).join(', ')}`
    )
    return getDefaultRerankModel().id
  }

  return model.id
}

/**
 * 解析精排保留条数（env RAG_RERANK_TOP_N，非法值用 fallback）
 *
 * 这是精排唯一的成本/延迟旋钮：上游按 query-文档对计费，topN 直接决定一次检索
 * 要买多少对、要等多久。所以调大它等于同时加钱和加延迟，默认不去动它。
 */
export function resolveRerankTopN(fallback: number): number {
  const raw = process.env.RAG_RERANK_TOP_N?.trim()
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[RAG] RAG_RERANK_TOP_N="${raw}" 不是正整数，回退到 ${fallback}`
    )
    return fallback
  }

  return parsed
}

/**
 * 送进精排的单个候选文本上限（字符）
 *
 * 精排按 query-文档对计费，长文本会成倍抬高 token 成本；而融合后的候选本身已按
 * 相关性排好序，答案通常落在片段开头，截掉尾部对 cross-encoder 的判断影响很小。
 */
export const RERANK_MAX_CHARS = 1000

/**
 * 对融合后的候选做精排
 *
 * @returns 按 score 降序的命中列表；任何无法精排的情况都返回 null（调用方沿用融合顺序）
 */
export async function rerankChunks(params: {
  apiKey: string
  query: string
  candidates: RerankCandidate[]
  topN?: number
  model?: string
  signal?: AbortSignal
}): Promise<RerankedHit[] | null> {
  const { apiKey, query, candidates, model, signal } = params
  // 未显式传 topN 时也读环境变量：否则 RAG_RERANK_TOP_N 就成了只有编排层才知道的配置
  const topN = params.topN ?? resolveRerankTopN(candidates.length)

  if (candidates.length === 0) {
    console.warn('[RAG] 精排跳过：没有候选片段')
    return null
  }

  if (!isRerankEnabled()) {
    console.warn('[RAG] 精排跳过：RAG_RERANK 已关闭，沿用融合顺序')
    return null
  }

  // 非法 topN 只可能来自配置错误，这时"精排 0 条"会让调用方误以为检索无结果，故直接放弃
  if (!Number.isInteger(topN) || topN <= 0) {
    console.warn(`[RAG] 精排跳过：topN=${topN} 不是正整数`)
    return null
  }

  // 调用方已经取消（客户端断开 / 用户停止生成）时不必再发一次注定被丢弃的请求
  if (signal?.aborted) {
    console.warn('[RAG] 精排跳过：请求已取消')
    return null
  }

  const effectiveModel = model ?? resolveRerankModel()
  // 只发送会被保留的条数：多发一篇就是白付一对的费用，且它不可能出现在结果里
  const sendCount = Math.min(candidates.length, topN)
  const sent = candidates.slice(0, sendCount)
  const documents = sent.map((candidate) =>
    candidate.text.slice(0, RERANK_MAX_CHARS)
  )

  try {
    const results = await createRerank(apiKey, {
      model: effectiveModel,
      query,
      documents,
      topN: sendCount,
      signal,
    })

    if (!Array.isArray(results)) {
      console.warn('[RAG] 精排失败：响应不是数组，沿用融合顺序')
      return null
    }

    if (results.length === 0) {
      console.warn('[RAG] 精排失败：上游返回空结果，沿用融合顺序')
      return null
    }

    // 同 id 只保留最高分：候选理论上不该重复，但重复时必须去重，否则同一片段占两个名额
    const bestById = new Map<string, number>()

    for (const result of results) {
      const index = result?.index
      const score = result?.score

      if (!Number.isInteger(index) || index < 0 || index >= sendCount) {
        // 越界下标意味着响应与请求没有对齐，丢掉它比把分数贴到别的片段上安全
        console.warn(
          `[RAG] 精排丢弃越界结果：index=${index}（本次发送 ${sendCount} 篇）`
        )
        continue
      }

      if (typeof score !== 'number' || !Number.isFinite(score)) {
        console.warn(`[RAG] 精排丢弃无效分数：index=${index} score=${score}`)
        continue
      }

      const id = sent[index].id
      const previous = bestById.get(id)
      if (previous === undefined || score > previous) bestById.set(id, score)
    }

    if (bestById.size === 0) {
      console.warn('[RAG] 精排失败：返回结果全部不可用，沿用融合顺序')
      return null
    }

    return [...bestById.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
  } catch (error) {
    // 取消不是故障，单独报出来，免得日志里一堆"精排失败"其实都是用户点了停止
    if (signal?.aborted) {
      console.warn('[RAG] 精排跳过：请求已取消')
      return null
    }
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[RAG] 精排失败，沿用融合顺序：${reason}`)
    return null
  }
}

/**
 * 词法通道（BM25）
 *
 * 单路向量召回的问题不是"不够准"，而是**分数不可比**：余弦相似度的绝对阈值
 * 依赖语料与模型，小知识库上高分的无关片段与低分的正确答案会重叠，
 * 于是"抬高阈值"既挡不住噪声又误杀正解（见 index.ts 的历史标定记录）。
 * 词法通道提供的是另一种证据：字面命中。两者用 RRF 融合而不是分数加权，
 * 正是因为 BM25 分与余弦分不在同一个量纲上。
 *
 * 中文没有空格，直接上 Postgres 的默认分词器会把整句当成一个词项，
 * 因此词项由 tokenizer.ts 统一生成（CJK 二元组 + 拉丁词），
 * 索引侧写进 chunk.tsv，查询侧拼成 tsquery——两边必须来自同一个分词器。
 */

import { queryTerms, toTsQueryInput } from './tokenizer'
import { BM25_B, BM25_K1 } from './bm25'
import {
  KnowledgeRepository,
  type ScoredChunk,
} from '@/server/repositories/knowledge.repository'

export interface LexicalSearchResult {
  /** 是否具备可用的词法索引（无有效词项时为 false） */
  enabled: boolean
  hits: ScoredChunk[]
  terms: string[]
}

/** 读取可覆盖的 BM25 参数（k1 控制词频饱和，b 控制长度归一化强度） */
function resolveBm25Params(): { k1: number; b: number } {
  const parse = (raw: string | undefined, fallback: number, min: number, max: number, name: string) => {
    if (raw === undefined || raw === '') return fallback
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      console.warn(
        `[RAG] ${name}="${raw}" 不是 ${min}~${max} 的数值，使用默认值 ${fallback}`
      )
      return fallback
    }
    return parsed
  }

  return {
    k1: parse(process.env.RAG_BM25_K1, BM25_K1, 0, 10, 'RAG_BM25_K1'),
    b: parse(process.env.RAG_BM25_B, BM25_B, 0, 1, 'RAG_BM25_B'),
  }
}

/**
 * BM25 检索
 *
 * @param params.limit - 词法候选数上限。语料越大 BM25 的高分项越集中，
 *                       40~100 条已足够覆盖真正相关的片段。
 */
export async function searchByLexical(params: {
  ownedBaseIds: string[]
  query: string
  limit: number
}): Promise<LexicalSearchResult> {
  const tsQuery = toTsQueryInput(params.query)
  const terms = queryTerms(params.query)

  if (!tsQuery || terms.length === 0 || params.limit <= 0) {
    // 纯标点/空查询：词法通道无话可说，交给向量通道
    return { enabled: false, hits: [], terms: [] }
  }

  const { k1, b } = resolveBm25Params()
  const hits = await KnowledgeRepository.searchChunksByLexical({
    ownedBaseIds: params.ownedBaseIds,
    tsQuery,
    terms,
    limit: params.limit,
    k1,
    b,
  })

  return { enabled: true, hits, terms }
}

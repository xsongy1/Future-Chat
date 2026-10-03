/**
 * RAG 混合检索的结果融合
 *
 * 向量通道给的是余弦相似度（0~1 的连续值），BM25 通道给的是词频打分（无上界、
 * 依赖语料统计），两者的绝对数值不可比。所以这里不做"加权求和"或"统一阈值"，
 * 而是用 RRF：只看每条结果在各自通道里的名次，1/(k+rank) 累加。
 *
 * 这样做的好处是加通道不用重新标定权重：任何一路召回坏了，另一路仍能把它
 * 该给的结果顶上来；而绝对分数阈值一旦换语料/换 embedding 模型就得重标一次。
 */

export type RetrievalChannel = 'vector' | 'lexical'

/** 单通道的排序结果 */
export interface RankedHit {
  /** 片段 id（DocumentChunk.id） */
  id: string
  /** 该通道自己的原始分数（余弦相似度 / BM25 分），只回传不参与融合计算 */
  score: number
  /** 该条来自哪个通道 */
  channel: RetrievalChannel
}

/** 融合结果：多通道的排名与分数都保留下来，便于调试与后续阈值判断 */
export interface FusedHit {
  id: string
  /** RRF 累加得分 */
  rrfScore: number
  /** 命中该条目的通道，按固定顺序排列 */
  channels: RetrievalChannel[]
  /** 各通道内的 1-based 排名 */
  ranks: Partial<Record<RetrievalChannel, number>>
  /** 各通道的原始分数 */
  scores: Partial<Record<RetrievalChannel, number>>
}

/**
 * RRF 的标准常数（来自 Cormack 等人的论文，取 60）。
 *
 * 它的作用是压平头部：rank1 与 rank2 的贡献差从 1/1 - 1/2 缩到 1/61 - 1/62，
 * 于是单个通道没法靠"把某条排到第一"独吞结果，多通道共识才有分量。
 * 这里只给默认值，运行时由调用方通过 options.k（或环境变量）覆盖。
 */
export const RRF_K = 60

/** 输出里 channels 的固定顺序：结果要能被测试和缓存稳定比较，不能随输入顺序抖动 */
const CHANNEL_ORDER: RetrievalChannel[] = ['vector', 'lexical']

/** 按 CHANNEL_ORDER 排序，让"同时命中两个通道"时的数组内容可预期 */
function sortChannels(channels: RetrievalChannel[]): RetrievalChannel[] {
  return [...channels].sort(
    (a, b) => CHANNEL_ORDER.indexOf(a) - CHANNEL_ORDER.indexOf(b)
  )
}

/**
 * 倒数排名融合（RRF）
 *
 * 约定：每个输入 list 已经按相关性从好到坏排好序，本函数不再排序——
 * 两条通道的排序口径不同（相似度降序 / BM25 降序），重排会覆盖调用方的判断。
 *
 * @param lists - 各通道的排序结果，顺序不重要（各条自带 channel 标记）
 * @param options.k - RRF 常数，缺省用 RRF_K
 */
export function reciprocalRankFusion(
  lists: RankedHit[][],
  options?: { k?: number }
): FusedHit[] {
  const k = options?.k ?? RRF_K
  const fused = new Map<string, FusedHit>()

  for (const list of lists) {
    if (!Array.isArray(list)) continue

    for (let i = 0; i < list.length; i++) {
      const hit = list[i]
      if (!hit) continue

      const channel = hit.channel
      const rank = i + 1

      const existing = fused.get(hit.id)
      // 同一条在一个通道里出现多次（去重不彻底、或同一通道传了多份列表）时只认更好的名次，
      // 否则同一次召回会被累加两次，等于偷偷给这条加权
      if (existing?.ranks[channel] !== undefined) continue

      const entry: FusedHit = existing ?? {
        id: hit.id,
        rrfScore: 0,
        channels: [],
        ranks: {},
        scores: {},
      }

      entry.rrfScore += 1 / (k + rank)
      entry.ranks[channel] = rank
      entry.scores[channel] = hit.score
      if (!entry.channels.includes(channel)) entry.channels.push(channel)

      fused.set(hit.id, entry)
    }
  }

  return [...fused.values()]
    .map((entry) => ({ ...entry, channels: sortChannels(entry.channels) }))
    .sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore
      // 两个通道都认可 > 只有一个通道认可，这是弱信号但确实是正信号
      if (b.channels.length !== a.channels.length)
        return b.channels.length - a.channels.length
      // 最后按 id 兜底，保证同分结果每次顺序一致（否则测试与前端展示都会飘）
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/**
 * 相对阈值筛选
 *
 * 绝对阈值（如"余弦相似度 >= 0.45"）在不同语料/不同 query 上的分辨力有限：
 * 简单问句整体分数偏低，长问句整体偏高，用同一个常数切必然两头不讨好。
 * 这里改成相对当前 query 的最好命中来切：只保留"和 best 差得不太远"的条目。
 *
 * @param options.ratio - 相对比例，会被夹到 [0,1]
 * @param options.absoluteFloor - 绝对下限（缺省 0），防止 ratio 过小时把明显不相关的条目也放进来
 */
export function selectByRelativeThreshold<T extends { score: number }>(
  items: T[],
  options: { ratio: number; absoluteFloor?: number }
): T[] {
  if (!Array.isArray(items) || items.length === 0) return []

  // ratio 非法（NaN / 越界）时按 0 处理：宁可多留，也不能因为配置写错把结果清空
  const ratio = Number.isFinite(options.ratio)
    ? Math.min(1, Math.max(0, options.ratio))
    : 0
  const floor = options.absoluteFloor ?? 0

  const topScore = items.reduce(
    (max, item) => (item.score > max ? item.score : max),
    -Infinity
  )

  // topScore <= 0 时相对阈值没有意义（0 的任意比例还是 0），只能退回绝对下限
  if (!(topScore > 0)) {
    return items.filter((item) => item.score >= floor)
  }

  const threshold = Math.max(floor, ratio * topScore)
  return items.filter((item) => item.score >= threshold)
}

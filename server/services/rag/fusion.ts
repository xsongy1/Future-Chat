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
 * 阈值筛选：绝对下限 + 相对比例（两道闸门各管一件事）
 *
 * **绝对下限**（absoluteFloor）回答的是"这条候选本身够不够相关"，与本次 query
 * 里最好的一条无关。它是唯一能回答"这一批候选整体都不相关"的闸门：当 topScore
 * 自己就低于下限时，整批候选一条都不该返回。
 *
 * **相对阈值**（ratio × topScore）回答的是"这条相对于本次最佳结果是不是差太多"，
 * 用来切长尾。它按定义**永远不可能清空结果**（topScore 自己总满足
 * `topScore >= ratio × topScore`，ratio ∈ [0,1]），所以不能指望它发现"这个 query
 * 在知识库里根本没有答案"。
 *
 * 两者合成一个统一门槛：
 *
 * ```
 * threshold = max(absoluteFloor, ratio × topScore)
 * ```
 *
 * 因为取的是较大值，一条被挡掉的候选可能同时低于两侧，所以拒绝原因分
 * `absolute` / `relative` / `both` 三档，事后可以明确回答"这条是被哪道闸门挡的"。
 *
 * ⚠️ **分数语义**：cross-encoder 的 score 既**不是概率**，也不是跨模型可比的量纲。
 * 同一段文本在不同 rerank 模型下的分数尺度可能完全不同，所以 absoluteFloor 必须
 * 针对"当前精排模型 + 当前语料"用标注数据标定，换模型就要重标（见 rag/README §1.4）。
 */

/** 门槛由哪一侧决定（两侧相等时记为 absolute） */
export type ThresholdDecider = 'absolute' | 'relative'

/** 单条候选被挡掉的原因分类 */
export type ThresholdRejection = 'absolute' | 'relative' | 'both'

/** 门槛的分解：绝对下限与相对阈值各算一份，最终门槛取两者较大值 */
export interface ThresholdBreakdown {
  /** ratio × topScore；topScore <= 0 时相对阈值失效，记 0 */
  relativeThreshold: number
  /** 配置的绝对下限（缺省 0） */
  absoluteFloor: number
  /** 实际生效门槛 = max(absoluteFloor, relativeThreshold) */
  finalThreshold: number
  /** 候选集最高分（空集或分数非正时记 0） */
  topScore: number
  /** 门槛由哪一侧决定（两侧相等时记为 absolute） */
  decidedBy: ThresholdDecider
}

/** 一条被挡掉的候选及其原因 */
export interface RejectedCandidate<T> {
  item: T
  score: number
  reason: ThresholdRejection
}

export interface ThresholdSelection<T> {
  /** 通过门槛的候选，保持输入顺序 */
  kept: T[]
  /** 被挡掉的候选及原因，保持输入顺序 */
  rejected: Array<RejectedCandidate<T>>
  threshold: ThresholdBreakdown
  /** 按原因计数，便于只看数量时不遍历 rejected */
  counts: { absolute: number; relative: number; both: number }
}

/** ratio 非法（NaN / 越界）时按 0 处理：宁可多留，也不能因为配置写错把结果清空 */
function normalizeRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/** floor 非法（NaN / 非有限）时同样按 0 处理，避免"配置写错 → 检索恒为空"这种查不出的哑故障 */
function normalizeFloor(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 只算门槛，不做筛选
 *
 * 拆出来是为了让调用方能把"绝对侧 / 相对侧 / 最终门槛 / 谁决定的"直接写进 debug，
 * 而不是只留一个数字——只留一个数字时，"0.3 是被绝对阈值挡的还是被相对阈值挡的"
 * 就只能靠猜。
 */
export function resolveSelectThreshold<T extends { score: number }>(
  items: T[],
  options: { ratio: number; absoluteFloor?: number }
): ThresholdBreakdown {
  const list = Array.isArray(items) ? items : []
  const ratio = normalizeRatio(options.ratio)
  const absoluteFloor = normalizeFloor(options.absoluteFloor)

  const topScore = list.reduce(
    (max, item) => (item.score > max ? item.score : max),
    -Infinity
  )
  const effectiveTop = Number.isFinite(topScore) ? topScore : 0

  // topScore <= 0 时相对阈值没有意义（0 的任意比例还是 0），只能退回绝对下限
  const relativeThreshold = effectiveTop > 0 ? ratio * effectiveTop : 0
  const finalThreshold = Math.max(absoluteFloor, relativeThreshold)

  return {
    relativeThreshold,
    absoluteFloor,
    finalThreshold,
    topScore: effectiveTop,
    // 门槛取 max：分数要越过的是"更高的那一道"，所以是谁把门槛抬上去，谁就是拒绝原因
    decidedBy: absoluteFloor >= relativeThreshold ? 'absolute' : 'relative',
  }
}

/**
 * 绝对下限 → 相对阈值 → 通过与否（含原因）
 *
 * 调用方拿到 kept 后再做 TopK 截断：**先过滤，再截断**。反过来先截断会把
 * "分数不够但名次靠前"的候选放进结果里，等于用数量掩盖质量问题。
 */
export function selectByThreshold<T extends { score: number }>(
  items: T[],
  options: { ratio: number; absoluteFloor?: number }
): ThresholdSelection<T> {
  const list = Array.isArray(items) ? items : []
  const threshold = resolveSelectThreshold(list, options)

  const kept: T[] = []
  const rejected: Array<RejectedCandidate<T>> = []
  const counts = { absolute: 0, relative: 0, both: 0 }

  for (const item of list) {
    if (item.score >= threshold.finalThreshold) {
      kept.push(item)
      continue
    }

    const belowAbsolute = item.score < threshold.absoluteFloor
    const belowRelative = item.score < threshold.relativeThreshold
    const reason: ThresholdRejection =
      belowAbsolute && belowRelative
        ? 'both'
        : belowAbsolute
          ? 'absolute'
          : 'relative'

    counts[reason] += 1
    rejected.push({ item, score: item.score, reason })
  }

  return { kept, rejected, threshold, counts }
}

export interface ScoreGapResult<T> {
  /** 断崖之上的候选（断崖处不保留） */
  kept: T[]
  /** 截断位置（= kept.length）；未触发时为 null */
  cutAt: number | null
  /** 触发时的相邻落差比例 (prev - cur) / prev */
  dropRatio: number | null
}

/**
 * 分数断崖截断（**默认关闭**，仅在 RAG_RERANK_MAX_GAP_RATIO > 0 时启用）
 *
 * 用途：处理"最高分够格、尾巴却拖得很长"的情况。绝对下限挡不住尾巴（它们都在
 * 下限之上），相对阈值要么切不掉、要么一刀切太狠，而相邻分数的落差是个更局部的
 * 信号：`[0.30, 0.20, 0.19, 0.18, 0.17]` 的断崖在第 1→2 条（落差 33%），
 * `[0.90, 0.82, 0.78, 0.70, 0.65]` 相邻落差都在 10% 上下，没有断崖。
 *
 * **它是启发式，不是标定值**：断崖只说明"这一批分数在这里分层"，不说明分层
 * 之上一定相关、之下一定不相关。所以默认关闭，必须先用标注数据验证过
 * "断崖处确实是相关/不相关的分界线"再打开；打开后建议同时看 debug 里的
 * `threshold.scoreGap`（cutAt / dropRatio）确认它的实际行为。
 *
 * @param maxGapRatio - 允许的最大相邻落差比例（0 或非法值 = 不启用）；严格大于才截断
 */
export function applyMaxScoreGap<T extends { score: number }>(
  items: T[],
  maxGapRatio: number
): ScoreGapResult<T> {
  const list = Array.isArray(items) ? items : []

  if (!Number.isFinite(maxGapRatio) || maxGapRatio <= 0 || list.length <= 1) {
    return { kept: [...list], cutAt: null, dropRatio: null }
  }

  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1].score
    // prev <= 0 时"落差比例"没有意义（除数为 0 或符号翻转），跳过
    const dropRatio = prev > 0 ? (prev - list[i].score) / prev : 0

    if (dropRatio > maxGapRatio) {
      return { kept: list.slice(0, i), cutAt: i, dropRatio }
    }
  }

  return { kept: [...list], cutAt: null, dropRatio: null }
}

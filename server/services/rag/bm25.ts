/**
 * Okapi BM25 打分（词法检索的参考实现）
 *
 * 纯函数，无 IO、无依赖。
 *
 * ## 这个文件存在的意义是「给 SQL 当参考答案」
 * 生产路径上的 tf / df 由 Postgres 统计，词法打分的 SQL 是手写的（lexical.ts）。
 * 手写聚合里的公式很容易写错，而且没有数据库跑不了单测，所以这里用同一个公式在
 * 应用层实现一遍：测试拿它当基准交叉验证 SQL 算出的分数，两边对不上就说明 SQL 错了。
 * 因此两边的常量、公式、边界处理必须保持逐字一致，改动其一就要同步另一个。
 *
 * 公式（K1/B 为常量，dl 为文档 token 数，avgdl 为语料平均 token 数）：
 *   score = Σ_t idf(t) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
 *   idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *
 * 几个刻意的选择：
 * - idf 用带 +1 的形式：私有知识库规模小，常见 bigram 的 df 很容易等于 N，
 *   用经典写法 ln((N - df + 0.5) / (df + 0.5)) 会得到负数，命中该词的文档反被扣分，
 *   排序会变得反直觉。加 +1 后最坏也只是趋近 0（词项不贡献），分数始终非负。
 * - k1 控制 tf 的饱和速度：k1 越小，同一个词多出现几次的边际收益衰减越快，
 *   避免长文档靠「某个词重复很多遍」压过语义更贴合的短文档。
 * - b 控制长度归一化强度：b = 0 完全不做长度惩罚，b = 1 完全按 dl / avgdl 归一化。
 *   0.75 是 BM25 惯例值；这里沿用，因为中文 bigram 词项多且 chunk 长度由 chunker
 *   固定，长度分布本身比较集中，不需要额外调参。
 */

/** tf 饱和系数（BM25 惯例值，控制 tf 增长的边际收益衰减速度） */
export const BM25_K1 = 1.2

/** 长度归一化强度（BM25 惯例值，0 = 不惩罚长文档，1 = 完全按 dl / avgdl 归一化） */
export const BM25_B = 0.75

/**
 * 逆文档频率
 *
 * 所有非法输入都收口成合法值，而不是抛错或返回 NaN：
 * 分数链路里只要出现一个 NaN，整个排序结果的顺序就不可预测（比较运算全为 false），
 * 那比某个词项算得不准危险得多。
 *
 * @param df - 含该词项的文档数（来自 SQL 聚合；0 表示该词不在语料里）
 * @param total - 语料文档总数
 * @returns 非负有限值；语料为空时返回 0
 */
export function idf(df: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0

  // 顺序有意义：Infinity 也满足 df > total，先按「过大的 df」压到 total，
  // 再兜住 NaN / 非正数（这两类按 1 处理，等价于「极罕见词」）
  let safeDf = df > total ? total : df
  if (!Number.isFinite(safeDf) || safeDf <= 0) safeDf = 1

  return Math.log(1 + (total - safeDf + 0.5) / (safeDf + 0.5))
}

/**
 * 单个词项的 BM25 贡献
 *
 * @param params.tf - 该词项在文档中的出现次数
 * @param params.idfValue - `idf(df, total)` 的结果
 * @param params.docLength - 文档 token 数 dl（`countTokens` 的返回值）
 * @param params.avgDocLength - 语料平均 token 数 avgdl
 * @param params.k1 - 覆盖默认饱和系数
 * @param params.b - 覆盖默认长度归一化强度
 * @returns 非负有限值；tf <= 0 时返回 0
 */
export function termScore(params: {
  tf: number
  idfValue: number
  docLength: number
  avgDocLength: number
  k1?: number
  b?: number
}): number {
  const { tf, idfValue, docLength, avgDocLength } = params

  // tf 为 0 说明文档没有这个词，直接 0 分省掉后面的除法
  if (!Number.isFinite(tf) || tf <= 0) return 0

  // idf 为负会变成「越命中越扣分」，非有限值会污染整个总分，都当 0 处理
  if (!Number.isFinite(idfValue) || idfValue <= 0) return 0

  // k1 必须非负：负值会让分母变成 tf 减去某个正数，极端情况下为 0 甚至为负，
  // 分数会翻成 Infinity 或负数
  const k1 =
    params.k1 !== undefined && Number.isFinite(params.k1) && params.k1 >= 0
      ? params.k1
      : BM25_K1

  // b 夹到 [0, 1]：越界值会让长度项 (1 - b + b * dl / avgdl) 为负，分母随之失去意义
  const b =
    params.b !== undefined && Number.isFinite(params.b)
      ? Math.min(Math.max(params.b, 0), 1)
      : BM25_B

  // 长度项：avgDocLength 缺失或为 0（空语料、SQL 聚合没算出来）时退化为「长度等于
  // 平均长度」，即比值 1，而不是让 0 当除数算出 Infinity / NaN
  const length = Number.isFinite(docLength) && docLength > 0 ? docLength : 0
  const average =
    Number.isFinite(avgDocLength) && avgDocLength > 0 ? avgDocLength : length
  const lengthRatio = average > 0 ? length / average : 1

  return (idfValue * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * lengthRatio))
}

/**
 * 文档总分：所有命中词项的贡献之和
 *
 * @param params.terms - 每个命中词项的 tf 与其 idf
 * @returns 非负有限值；词项列表为空时返回 0
 */
export function scoreDocument(params: {
  terms: Array<{ tf: number; idfValue: number }>
  docLength: number
  avgDocLength: number
  k1?: number
  b?: number
}): number {
  const { terms, docLength, avgDocLength } = params
  if (terms.length === 0) return 0

  const k1 = params.k1 ?? BM25_K1
  const b = params.b ?? BM25_B

  let score = 0

  for (const term of terms) {
    score += termScore({
      tf: term.tf,
      idfValue: term.idfValue,
      docLength,
      avgDocLength,
      k1,
      b,
    })
  }

  return score
}

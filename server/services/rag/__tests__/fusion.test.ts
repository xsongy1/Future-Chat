/**
 * RRF 融合与阈值筛选单测
 *
 * 纯函数，不依赖数据库、网络与环境变量。重点验证：
 * - 名次贡献 1/(k+rank) 与跨通道累加（RRF 的核心公式）
 * - 输出顺序完全确定：同分先看通道数、再看 id
 * - 脏输入（空列表、空洞、同一列表内重复 id、空 id）不抛错
 * - 阈值边界：ratio 夹取、absoluteFloor 优先级、全 0/负数、空输入、泛型字段不丢
 * - 阈值分解：绝对下限 / 相对阈值 / 最终门槛 / 谁决定的
 * - 拒绝归因：一条被挡掉的候选到底是绝对阈值挡的还是相对阈值挡的
 * - 六个验收场景（长尾 / 整体低质量 / 多个高质量 / TopK 上限 / 全部不相关 / 单条相关）
 * - 断崖截断是可选启发式，默认关闭
 *
 * 用相对路径导入，与同目录的 chunker.test.ts / retrieval.test.ts 保持一致。
 */

import { describe, it, expect } from 'vitest'
import {
  RRF_K,
  applyMaxScoreGap,
  reciprocalRankFusion,
  resolveSelectThreshold,
  selectByThreshold,
} from '../fusion'
import type { RankedHit, RetrievalChannel } from '../fusion'

/**
 * 用例里使用的绝对下限：**测试用的示例值，不是产品默认值**
 *
 * 产品默认仍是 0.05（`RAG_RERANK_MIN_SCORE`，见 index.ts），因为仓库里没有精排分的
 * 标注数据可以标定它。用例里显式传 0.45 只是为了让"绝对阈值这一侧确实在起作用"
 * 可被验证，不代表 0.45 在任何真实语料上成立。
 */
const EXAMPLE_FLOOR = 0.45

/** 把分数列表压成 { score } 数组，方便逐条对照题目给的数字 */
function scored(...values: number[]): Array<{ score: number }> {
  return values.map((score) => ({ score }))
}

/** 取出分数序列，断言时比对象数组更直观 */
function scores(items: Array<{ score: number }>): number[] {
  return items.map((item) => item.score)
}

/** 构造一条通道命中 */
function hit(id: string, score: number, channel: RetrievalChannel): RankedHit {
  return { id, score, channel }
}

describe('reciprocalRankFusion - 名次贡献与累加', () => {
  it('RRF 常数默认为 60（Cormack 论文取值，用于压平头部名次差）', () => {
    expect(RRF_K).toBe(60)
  })

  it('单列表：名次从 1 开始，贡献为 1/(k+rank)', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 0.9, 'vector'), hit('b', 0.8, 'vector')],
    ])

    expect(fused).toHaveLength(2)
    expect(fused[0].id).toBe('a')
    expect(fused[0].rrfScore).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(fused[1].rrfScore).toBeCloseTo(1 / (RRF_K + 2), 12)
    expect(fused[0].channels).toEqual(['vector'])
    expect(fused[0].ranks).toEqual({ vector: 1 })
    expect(fused[0].scores).toEqual({ vector: 0.9 })
    expect(fused[1].ranks).toEqual({ vector: 2 })
  })

  it('同一 id 命中两个通道且都是第 1 名：累加 1/(k+1) + 1/(k+1)', () => {
    const fused = reciprocalRankFusion([
      [hit('x', 0.7, 'vector')],
      [hit('x', 12.5, 'lexical')],
    ])

    expect(fused).toHaveLength(1)
    expect(fused[0].rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1), 12)
    expect(fused[0].channels).toEqual(['vector', 'lexical'])
    expect(fused[0].ranks).toEqual({ vector: 1, lexical: 1 })
    // 两个通道的原始分数各自保留，不做归一化（它们本来就不可比）
    expect(fused[0].scores).toEqual({ vector: 0.7, lexical: 12.5 })
  })

  it('一个通道第 1 名、另一个通道第 3 名：累加 1/(k+1) + 1/(k+3)', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 0.9, 'vector')],
      [hit('p', 9, 'lexical'), hit('q', 8, 'lexical'), hit('a', 7, 'lexical')],
    ])

    const a = fused.find((h) => h.id === 'a')!
    expect(a.rrfScore).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 3), 12)
    expect(a.ranks).toEqual({ vector: 1, lexical: 3 })
    // 两路共识的条目要排在只有单通道 1/61 的 p/q 之前
    expect(fused.map((h) => h.id)).toEqual(['a', 'p', 'q'])
  })

  it('channels 顺序固定为 vector → lexical，与输入列表顺序无关', () => {
    const forward = reciprocalRankFusion([
      [hit('x', 0.7, 'vector')],
      [hit('x', 12.5, 'lexical')],
    ])
    const backward = reciprocalRankFusion([
      [hit('x', 12.5, 'lexical')],
      [hit('x', 0.7, 'vector')],
    ])

    expect(forward[0].channels).toEqual(['vector', 'lexical'])
    expect(backward[0].channels).toEqual(['vector', 'lexical'])
  })

  it('k 可覆盖：k=1 时第 1 名贡献 1/2，第 2 名贡献 1/3', () => {
    const fused = reciprocalRankFusion(
      [[hit('a', 1, 'vector'), hit('b', 0.5, 'vector')]],
      { k: 1 }
    )

    expect(fused[0].rrfScore).toBe(0.5)
    expect(fused[1].rrfScore).toBeCloseTo(1 / 3, 12)
  })
})

describe('reciprocalRankFusion - 确定性排序', () => {
  it('分数相同时，命中通道多的排前面', () => {
    // k=0 让算术后验：z 在两个通道都是第 2 名 → 1/2 + 1/2 = 1，与 a、b 的单通道第 1 名同分
    const fused = reciprocalRankFusion(
      [
        [hit('a', 1, 'vector'), hit('z', 1, 'vector')],
        [hit('b', 1, 'lexical'), hit('z', 1, 'lexical')],
      ],
      { k: 0 }
    )

    expect(fused.map((h) => h.id)).toEqual(['z', 'a', 'b'])
    expect(fused[0].rrfScore).toBe(1)
  })

  it('分数与通道数都相同时按 id 升序，保证输出稳定', () => {
    const fused = reciprocalRankFusion([
      [hit('m', 1, 'vector')],
      [hit('a', 1, 'lexical')],
    ])

    expect(fused.map((h) => h.id)).toEqual(['a', 'm'])
    expect(fused[0].rrfScore).toBe(fused[1].rrfScore)
  })
})

describe('reciprocalRankFusion - 脏输入', () => {
  it('同一列表内重复出现的 id 只保留更好的名次', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 1, 'vector'), hit('b', 1, 'vector'), hit('a', 0.2, 'vector')],
    ])

    expect(fused).toHaveLength(2)
    const a = fused.find((h) => h.id === 'a')!
    expect(a.rrfScore).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(a.ranks.vector).toBe(1)
    expect(a.scores.vector).toBe(1)
  })

  it('同一通道传了多份列表时也不会把同一条累加两次', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 1, 'vector'), hit('b', 1, 'vector')],
      [hit('a', 1, 'vector')],
    ])

    const a = fused.find((h) => h.id === 'a')!
    expect(a.rrfScore).toBeCloseTo(1 / (RRF_K + 1), 12)
    expect(a.ranks.vector).toBe(1)
  })

  it('空数组、空列表、空洞都返回空结果而不抛错', () => {
    expect(reciprocalRankFusion([])).toEqual([])
    expect(reciprocalRankFusion([[], []])).toEqual([])
    expect(reciprocalRankFusion([undefined as unknown as RankedHit[]])).toEqual(
      []
    )
  })

  it('空 id 允许通过且不抛错（由上游去重逻辑负责）', () => {
    const fused = reciprocalRankFusion([
      [hit('', 0.5, 'vector'), hit('a', 0.4, 'vector')],
    ])

    expect(fused).toHaveLength(2)
    expect(fused.find((h) => h.id === '')!.ranks.vector).toBe(1)
  })
})

describe('selectByThreshold - 门槛边界（保留项）', () => {
  const items = [{ score: 0.7 }, { score: 1 }, { score: 0.9 }, { score: 0.5 }]

  it('保留 score >= ratio * topScore 的条目，并保持输入顺序', () => {
    // 门槛 = 0.6 * 1 = 0.6 → 0.7 / 1 / 0.9 通过，0.5 被挡掉
    expect(selectByThreshold(items, { ratio: 0.6 }).kept).toEqual([
      { score: 0.7 },
      { score: 1 },
      { score: 0.9 },
    ])
  })

  it('恰好等于门槛的条目要保留（边界用 >=）', () => {
    expect(
      selectByThreshold([{ score: 1 }, { score: 0.5 }], { ratio: 0.5 }).kept
    ).toEqual([{ score: 1 }, { score: 0.5 }])
  })

  it('absoluteFloor 高于 ratio * topScore 时以前者为准', () => {
    const list = [{ score: 1 }, { score: 0.9 }, { score: 0.5 }]

    // ratio * top = 0.1，真正的门槛是 0.55 的绝对下限
    expect(
      selectByThreshold(list, { ratio: 0.1, absoluteFloor: 0.55 }).kept
    ).toEqual([{ score: 1 }, { score: 0.9 }])
  })

  it('ratio 被夹到 [0,1]，NaN 按 0 处理（宁可多留也不清空结果）', () => {
    const list = [{ score: 1 }, { score: 0.9 }]

    // ratio=5 → 1，只剩最高分
    expect(selectByThreshold(list, { ratio: 5 }).kept).toEqual([{ score: 1 }])
    // ratio=-3 → 0，配合默认 floor=0 时全部保留
    expect(selectByThreshold(list, { ratio: -3 }).kept).toEqual(list)
    expect(selectByThreshold(list, { ratio: Number.NaN }).kept).toEqual(list)
  })

  it('空输入返回空结果', () => {
    expect(selectByThreshold([], { ratio: 0.5 }).kept).toEqual([])
  })

  it('分数全为 0 或负数时相对阈值失效，只按 absoluteFloor 过滤', () => {
    const zeros = [{ score: 0 }, { score: 0 }]

    // 默认 floor = 0 → 0 >= 0，全部保留
    expect(selectByThreshold(zeros, { ratio: 0.9 }).kept).toEqual(zeros)
    // floor 抬高后全部淘汰，而不是退化成"保留全部"
    expect(
      selectByThreshold(zeros, { ratio: 0.9, absoluteFloor: 0.1 }).kept
    ).toEqual([])
    expect(
      selectByThreshold([{ score: -0.2 }, { score: -0.5 }], {
        ratio: 0.9,
        absoluteFloor: 0,
      }).kept
    ).toEqual([])
  })

  it('要求 { score } 之外的其他字段时原样保留（泛型不丢字段）', () => {
    const list = [
      { id: 'a', score: 0.8, extra: true },
      { id: 'b', score: 0.1, extra: false },
    ]

    expect(selectByThreshold(list, { ratio: 0.5 }).kept).toEqual([
      { id: 'a', score: 0.8, extra: true },
    ])
  })
})

describe('resolveSelectThreshold - 门槛分解（绝对侧 / 相对侧 / 谁决定）', () => {
  it('统一公式：threshold = max(absoluteFloor, ratio × topScore)', () => {
    const breakdown = resolveSelectThreshold(scored(0.8, 0.3, 0.29), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(breakdown.topScore).toBe(0.8)
    expect(breakdown.relativeThreshold).toBeCloseTo(0.2, 12) // 0.25 × 0.8
    expect(breakdown.absoluteFloor).toBe(0.45)
    expect(breakdown.finalThreshold).toBe(0.45) // max(0.45, 0.2)
    expect(breakdown.decidedBy).toBe('absolute')
  })

  it('绝对下限低于相对阈值时，门槛由相对侧决定', () => {
    // 0.25 × 0.9 = 0.225 > 0.05，门槛由相对侧抬起
    const breakdown = resolveSelectThreshold(scored(0.9, 0.5), {
      ratio: 0.25,
      absoluteFloor: 0.05,
    })

    expect(breakdown.relativeThreshold).toBeCloseTo(0.225, 12)
    expect(breakdown.finalThreshold).toBeCloseTo(0.225, 12)
    expect(breakdown.decidedBy).toBe('relative')
  })

  it('两侧相等时门槛记为 absolute（并列时归绝对侧，输出必须确定）', () => {
    const breakdown = resolveSelectThreshold(scored(1, 0.5), {
      ratio: 0.5,
      absoluteFloor: 0.5,
    })

    expect(breakdown.relativeThreshold).toBe(0.5)
    expect(breakdown.finalThreshold).toBe(0.5)
    expect(breakdown.decidedBy).toBe('absolute')
  })

  it('topScore <= 0 时相对阈值退化为 0，门槛只剩绝对下限', () => {
    const breakdown = resolveSelectThreshold(scored(0, -0.2), {
      ratio: 0.9,
      absoluteFloor: 0.1,
    })

    expect(breakdown.topScore).toBe(0)
    expect(breakdown.relativeThreshold).toBe(0)
    expect(breakdown.finalThreshold).toBe(0.1)
  })

  it('空输入与非法配置都不抛错（ratio 夹到 [0,1]，floor 非法按 0）', () => {
    expect(resolveSelectThreshold([], { ratio: 0.5 })).toEqual({
      relativeThreshold: 0,
      absoluteFloor: 0,
      finalThreshold: 0,
      topScore: 0,
      decidedBy: 'absolute',
    })

    // ratio 越界 → 夹到 1；NaN → 0
    expect(
      resolveSelectThreshold(scored(1, 0.9), { ratio: 5 }).relativeThreshold
    ).toBe(1)
    expect(
      resolveSelectThreshold(scored(1, 0.9), { ratio: Number.NaN })
        .finalThreshold
    ).toBe(0)

    // floor 写成 NaN 时不能把整批结果清空（配置写错不该变成"检索恒为空"）
    expect(
      resolveSelectThreshold(scored(0.9, 0.4), {
        ratio: 0,
        absoluteFloor: Number.NaN,
      }).finalThreshold
    ).toBe(0)
  })
})

describe('selectByThreshold - 拒绝原因归因（哪道闸门挡的）', () => {
  it('低于绝对下限、但高于相对阈值 → 归因 absolute', () => {
    const selection = selectByThreshold(scored(0.8, 0.3, 0.29), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(scores(selection.kept)).toEqual([0.8])
    expect(selection.rejected.map((r) => [r.score, r.reason])).toEqual([
      [0.3, 'absolute'],
      [0.29, 'absolute'],
    ])
    expect(selection.counts).toEqual({ absolute: 2, relative: 0, both: 0 })
  })

  it('高于绝对下限、但低于相对阈值 → 归因 relative', () => {
    // 相对阈值 = 0.8 × 0.8 = 0.64；0.5 高于下限 0.2，只被相对阈值挡掉
    const selection = selectByThreshold(scored(0.8, 0.5), {
      ratio: 0.8,
      absoluteFloor: 0.2,
    })

    expect(scores(selection.kept)).toEqual([0.8])
    expect(selection.rejected).toEqual([
      { item: { score: 0.5 }, score: 0.5, reason: 'relative' },
    ])
    expect(selection.counts).toEqual({ absolute: 0, relative: 1, both: 0 })
  })

  it('两侧都没过 → 归因 both（它同时不满足"自身够相关"和"相对最佳不过差"）', () => {
    // 相对阈值 = 0.5 × 1 = 0.5，绝对下限 0.45：0.4 两侧都低于
    const selection = selectByThreshold(scored(1, 0.4), {
      ratio: 0.5,
      absoluteFloor: 0.45,
    })

    expect(selection.rejected.map((r) => r.reason)).toEqual(['both'])
    expect(selection.counts.both).toBe(1)
  })

  it('通过数 + 三种拒绝数 = 候选数（计数不会漏）', () => {
    const list = scored(1, 0.8, 0.5, 0.4, 0.1)
    const selection = selectByThreshold(list, {
      ratio: 0.5,
      absoluteFloor: 0.45,
    })
    const { absolute, relative, both } = selection.counts

    expect(selection.kept.length + absolute + relative + both).toBe(list.length)
    expect(selection.rejected.length).toBe(absolute + relative + both)
  })

  it('保持输入顺序，且不修改入参', () => {
    const list = scored(0.7, 1, 0.9, 0.5)
    const snapshot = JSON.parse(JSON.stringify(list))

    const selection = selectByThreshold(list, { ratio: 0.6 })

    expect(scores(selection.kept)).toEqual([0.7, 1, 0.9])
    expect(scores(selection.rejected.map((r) => r.item))).toEqual([0.5])
    expect(list).toEqual(snapshot)
  })

  it('空输入返回空结果，门槛只剩绝对下限', () => {
    const selection = selectByThreshold([], { ratio: 0.5, absoluteFloor: 0.4 })

    expect(selection.kept).toEqual([])
    expect(selection.rejected).toEqual([])
    expect(selection.threshold.topScore).toBe(0)
    expect(selection.threshold.relativeThreshold).toBe(0)
    expect(selection.threshold.finalThreshold).toBe(0.4)
  })
})

/**
 * 六个验收场景（纯函数层）
 *
 * 这里只验证"过滤"这一步的语义；TopK 截断是调用方的事（`kept.slice(0, topK)`），
 * 端到端行为在 retrieval.test.ts 里验证。
 */
describe('阈值筛选 - 六个验收场景', () => {
  it('Case 1 明显长尾 [0.80, 0.30, 0.29]：只留下 0.80', () => {
    const selection = selectByThreshold(scored(0.8, 0.3, 0.29), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(scores(selection.kept)).toEqual([0.8])
    // 相对阈值只有 0.2，靠它挡不住 0.30/0.29——挡下来的是绝对下限
    expect(selection.threshold.relativeThreshold).toBeCloseTo(0.2, 12)
    expect(selection.counts).toEqual({ absolute: 2, relative: 0, both: 0 })
  })

  it('Case 1 反例：绝对下限还是默认的 0.05 时，长尾会全部通过（所以它必须标定）', () => {
    const selection = selectByThreshold(scored(0.8, 0.3, 0.29), {
      ratio: 0.25,
      absoluteFloor: 0.05,
    })

    expect(scores(selection.kept)).toEqual([0.8, 0.3, 0.29])
    expect(selection.threshold.decidedBy).toBe('relative')
  })

  it('Case 2 整体低质量 [0.30, 0.20, 0.19, 0.18, 0.17]：绝对阈值负责清空', () => {
    const weak = scored(0.3, 0.2, 0.19, 0.18, 0.17)

    // 只靠相对阈值：门槛 = 0.25 × 0.30 = 0.075 → 几乎全部通过（这正是问题所在）
    const relativeOnly = selectByThreshold(weak, {
      ratio: 0.25,
      absoluteFloor: 0,
    })
    expect(scores(relativeOnly.kept)).toEqual([0.3, 0.2, 0.19, 0.18, 0.17])

    // 加上标定过的绝对下限：整批候选都不够相关 → 返回 0 条
    const gated = selectByThreshold(weak, {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })
    expect(gated.kept).toEqual([])
    expect(gated.counts).toEqual({ absolute: 5, relative: 0, both: 0 })
    expect(gated.threshold.finalThreshold).toBe(EXAMPLE_FLOOR)
  })

  it('Case 3 多个高质量 [0.90, 0.82, 0.78, 0.70, 0.65]：一条都不能误删', () => {
    const selection = selectByThreshold(scored(0.9, 0.82, 0.78, 0.7, 0.65), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(scores(selection.kept)).toEqual([0.9, 0.82, 0.78, 0.7, 0.65])
    expect(selection.rejected).toEqual([])
  })

  it('Case 4 TopK 上限 [0.95…0.70]：全部通过阈值，但最终只能返回 5 条', () => {
    const selection = selectByThreshold(
      scored(0.95, 0.9, 0.85, 0.8, 0.75, 0.7),
      {
        ratio: 0.25,
        absoluteFloor: EXAMPLE_FLOOR,
      }
    )

    // 过滤这一步放行 6 条；TopK 是调用方的数量上限，不是"必须凑到 K 条"
    expect(selection.kept).toHaveLength(6)
    expect(scores(selection.kept.slice(0, 5))).toEqual([
      0.95, 0.9, 0.85, 0.8, 0.75,
    ])
  })

  it('Case 5 全部不相关 [0.20…0.08]：返回 0 条，不为凑 TopK 强行返回', () => {
    const selection = selectByThreshold(scored(0.2, 0.18, 0.15, 0.1, 0.08), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(selection.kept).toEqual([])
    expect(selection.kept.slice(0, 5)).toEqual([])
    expect(selection.counts.absolute).toBe(5)
  })

  it('Case 6 只有一个相关结果 [0.90, 0.20, 0.10]：只返回第一条', () => {
    const selection = selectByThreshold(scored(0.9, 0.2, 0.1), {
      ratio: 0.25,
      absoluteFloor: EXAMPLE_FLOOR,
    })

    expect(scores(selection.kept)).toEqual([0.9])
    // 相对阈值 0.225 也高于这两条，所以它们两侧都没过 → both
    expect(selection.rejected.map((r) => r.reason)).toEqual(['both', 'both'])
    expect(selection.counts).toEqual({ absolute: 0, relative: 0, both: 2 })
  })
})

describe('applyMaxScoreGap - 分数断崖截断（默认关闭的可选启发式）', () => {
  it('相邻落差超过上限时，从断崖处截断', () => {
    // 0.80 → 0.45 落差 43.75% > 25% → 只保留断崖之上的一条
    const result = applyMaxScoreGap(scored(0.8, 0.45, 0.42), 0.25)

    expect(scores(result.kept)).toEqual([0.8])
    expect(result.cutAt).toBe(1)
    expect(result.dropRatio).toBeCloseTo(0.4375, 12)
  })

  it('整体低质量 [0.30, 0.20, …] 的断崖在第 1→2 条', () => {
    const result = applyMaxScoreGap(scored(0.3, 0.2, 0.19, 0.18, 0.17), 0.25)

    expect(scores(result.kept)).toEqual([0.3])
    expect(result.dropRatio).toBeCloseTo(1 / 3, 12)
  })

  it('多个高质量结果分数平滑下降时不应截断（否则会误删）', () => {
    const result = applyMaxScoreGap(scored(0.9, 0.82, 0.78, 0.7, 0.65), 0.25)

    expect(result.kept).toHaveLength(5)
    expect(result.cutAt).toBeNull()
    expect(result.dropRatio).toBeNull()
  })

  it('maxGapRatio = 0（默认）或非法值时不启用', () => {
    const list = scored(0.9, 0.1)

    expect(applyMaxScoreGap(list, 0).kept).toEqual(list)
    expect(applyMaxScoreGap(list, -1).kept).toEqual(list)
    expect(applyMaxScoreGap(list, Number.NaN).kept).toEqual(list)
    expect(applyMaxScoreGap(list, 0).cutAt).toBeNull()
  })

  it('落差必须严格大于上限才截断（等于上限时不切）', () => {
    const result = applyMaxScoreGap(scored(1, 0.75), 0.25)

    expect(scores(result.kept)).toEqual([1, 0.75])
    expect(result.cutAt).toBeNull()
  })

  it('单条、空列表、前一条分数非正时都不截断', () => {
    expect(applyMaxScoreGap(scored(0.5), 0.1).kept).toEqual([{ score: 0.5 }])
    expect(applyMaxScoreGap([], 0.1).kept).toEqual([])
    // prev <= 0 时"落差比例"没有意义，跳过而不是算出一个假断崖
    expect(applyMaxScoreGap(scored(0, 0.5), 0.1).cutAt).toBeNull()
    expect(applyMaxScoreGap(scored(-0.1, -0.5), 0.1).cutAt).toBeNull()
  })

  it('返回新数组，不修改入参', () => {
    const list = scored(0.9, 0.82)
    const result = applyMaxScoreGap(list, 0.5)

    expect(result.kept).not.toBe(list)
    expect(result.kept).toEqual(list)
  })
})

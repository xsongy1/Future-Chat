/**
 * RRF 融合与相对阈值筛选单测
 *
 * 纯函数，不依赖数据库、网络与环境变量。重点验证：
 * - 名次贡献 1/(k+rank) 与跨通道累加（RRF 的核心公式）
 * - 输出顺序完全确定：同分先看通道数、再看 id
 * - 脏输入（空列表、空洞、同一列表内重复 id、空 id）不抛错
 * - 相对阈值在 ratio / absoluteFloor 边界上的取舍
 *
 * 用相对路径导入，与同目录的 chunker.test.ts / retrieval.test.ts 保持一致。
 */

import { describe, it, expect } from 'vitest'
import {
  RRF_K,
  reciprocalRankFusion,
  selectByRelativeThreshold,
} from '../fusion'
import type { RankedHit, RetrievalChannel } from '../fusion'

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

describe('selectByRelativeThreshold - 相对阈值', () => {
  const items = [{ score: 0.7 }, { score: 1 }, { score: 0.9 }, { score: 0.5 }]

  it('保留 score >= ratio * topScore 的条目，并保持输入顺序', () => {
    // 门槛 = 0.6 * 1 = 0.6 → 0.7 / 1 / 0.9 通过，0.5 被挡掉
    expect(selectByRelativeThreshold(items, { ratio: 0.6 })).toEqual([
      { score: 0.7 },
      { score: 1 },
      { score: 0.9 },
    ])
  })

  it('恰好等于 ratio * topScore 的条目要保留（边界用 >=）', () => {
    expect(
      selectByRelativeThreshold([{ score: 1 }, { score: 0.5 }], { ratio: 0.5 })
    ).toEqual([{ score: 1 }, { score: 0.5 }])
  })

  it('absoluteFloor 高于 ratio * topScore 时以后者为准', () => {
    const list = [{ score: 1 }, { score: 0.9 }, { score: 0.5 }]

    // ratio * top = 0.1，真正的门槛是 0.55 的绝对下限
    expect(
      selectByRelativeThreshold(list, { ratio: 0.1, absoluteFloor: 0.55 })
    ).toEqual([{ score: 1 }, { score: 0.9 }])
  })

  it('ratio 被夹到 [0,1]，NaN 按 0 处理（宁可多留也不清空结果）', () => {
    const list = [{ score: 1 }, { score: 0.9 }]

    // ratio=5 → 1，只剩最高分
    expect(selectByRelativeThreshold(list, { ratio: 5 })).toEqual([
      { score: 1 },
    ])
    // ratio=-3 → 0，配合默认 floor=0 时全部保留
    expect(selectByRelativeThreshold(list, { ratio: -3 })).toEqual(list)
    expect(selectByRelativeThreshold(list, { ratio: Number.NaN })).toEqual(list)
  })

  it('空输入返回空数组', () => {
    expect(selectByRelativeThreshold([], { ratio: 0.5 })).toEqual([])
  })

  it('分数全为 0 或负数时相对阈值失效，只按 absoluteFloor 过滤', () => {
    const zeros = [{ score: 0 }, { score: 0 }]

    // 默认 floor = 0 → 0 >= 0，全部保留
    expect(selectByRelativeThreshold(zeros, { ratio: 0.9 })).toEqual(zeros)
    // floor 抬高后全部淘汰，而不是退化成"保留全部"
    expect(
      selectByRelativeThreshold(zeros, { ratio: 0.9, absoluteFloor: 0.1 })
    ).toEqual([])
    expect(
      selectByRelativeThreshold([{ score: -0.2 }, { score: -0.5 }], {
        ratio: 0.9,
        absoluteFloor: 0,
      })
    ).toEqual([])
  })

  it('要求 { score } 之外的其他字段时原样保留（泛型不丢字段）', () => {
    const list = [
      { id: 'a', score: 0.8, extra: true },
      { id: 'b', score: 0.1, extra: false },
    ]

    expect(selectByRelativeThreshold(list, { ratio: 0.5 })).toEqual([
      { id: 'a', score: 0.8, extra: true },
    ])
  })
})

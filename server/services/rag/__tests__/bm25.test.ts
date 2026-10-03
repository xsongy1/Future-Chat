/**
 * BM25 单元测试
 *
 * 这些断言同时也是 lexical.ts 里手写 SQL 的验收标准：SQL 侧算出的分数必须与这里的
 * 公式一致（含 k1 / b 默认值、idf 的非负性、长度归一化方式）。因此这里既验证
 * 「单调性」这类性质，也把公式直译成独立参照做数值比对——只验证单调性的话，
 * 公式写错一个常数照样能通过。
 */

import { describe, it, expect } from 'vitest'
import { BM25_B, BM25_K1, idf, scoreDocument, termScore } from '../bm25'

/**
 * 公式直译，作为被测实现的独立参照（刻意不复用被测代码）
 */
function formula(params: {
  tf: number
  idfValue: number
  docLength: number
  avgDocLength: number
  k1: number
  b: number
}): number {
  const { tf, idfValue, docLength, avgDocLength, k1, b } = params

  return (
    (idfValue * (tf * (k1 + 1))) /
    (tf + k1 * (1 - b + b * (docLength / avgDocLength)))
  )
}

describe('BM25 常量', () => {
  it('使用惯例默认值', () => {
    expect(BM25_K1).toBe(1.2)
    expect(BM25_B).toBe(0.75)
  })
})

describe('idf', () => {
  it('空语料或非法 total 返回 0', () => {
    expect(idf(0, 0)).toBe(0)
    expect(idf(1, 0)).toBe(0)
    expect(idf(5, -1)).toBe(0)
    expect(idf(1, Number.POSITIVE_INFINITY)).toBe(0)
    expect(idf(1, Number.NaN)).toBe(0)
  })

  it('df <= 0 按 1 处理', () => {
    expect(idf(0, 10)).toBe(idf(1, 10))
    expect(idf(-3, 10)).toBe(idf(1, 10))
    expect(idf(Number.NaN, 10)).toBe(idf(1, 10))
  })

  it('df > total 被压到 total', () => {
    expect(idf(11, 10)).toBe(idf(10, 10))
    expect(idf(999, 10)).toBe(idf(10, 10))
    expect(idf(Number.POSITIVE_INFINITY, 10)).toBe(idf(10, 10))
  })

  it('df 相同时语料越大 idf 越大', () => {
    expect(idf(1, 100)).toBeGreaterThan(idf(1, 10))
  })

  it('df 增大时严格单调递减', () => {
    const total = 50

    for (let df = 1; df < total; df++) {
      expect(idf(df, total)).toBeGreaterThan(idf(df + 1, total))
    }
  })

  it('始终非负且有限，100% df 时也不为负', () => {
    const total = 20

    for (let df = 1; df <= total; df++) {
      const value = idf(df, total)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }

    // 词项出现在每个 chunk 里：经典 BM25（不加 +1）在这里会算出负数，这里必须是正数
    expect(idf(total, total)).toBeGreaterThan(0)
    expect(idf(total, total)).toBeCloseTo(Math.log(1 + 0.5 / (total + 0.5)), 12)
  })

  it('与公式直译一致', () => {
    expect(idf(3, 10)).toBeCloseTo(Math.log(1 + (10 - 3 + 0.5) / (3 + 0.5)), 12)
  })
})

describe('termScore', () => {
  const base = { idfValue: 1, docLength: 100, avgDocLength: 100 }

  it('tf <= 0 得 0 分', () => {
    expect(termScore({ ...base, tf: 0 })).toBe(0)
    expect(termScore({ ...base, tf: -1 })).toBe(0)
    expect(termScore({ ...base, tf: Number.NaN })).toBe(0)
  })

  it('tf 增大时分数递增', () => {
    const one = termScore({ ...base, tf: 1 })
    const two = termScore({ ...base, tf: 2 })
    const many = termScore({ ...base, tf: 100 })

    expect(two).toBeGreaterThan(one)
    expect(many).toBeGreaterThan(two)
  })

  it('tf 的收益饱和，上界为 idf * (k1 + 1)', () => {
    const limit = base.idfValue * (BM25_K1 + 1)
    const huge = termScore({ ...base, tf: 1_000_000 })

    expect(huge).toBeLessThan(limit)
    // 饱和很快：tf 到百万级后离上界已经可以忽略
    expect(limit - huge).toBeLessThan(1e-4)
    expect(termScore({ ...base, tf: 1000 })).toBeGreaterThan(
      termScore({ ...base, tf: 100 })
    )
  })

  it('文档长于平均长度时分数变小', () => {
    const at = (docLength: number) =>
      termScore({ tf: 2, idfValue: 1, docLength, avgDocLength: 100 })

    expect(at(200)).toBeLessThan(at(100))
    expect(at(1000)).toBeLessThan(at(200))
    expect(at(1000)).toBeGreaterThan(0)
  })

  it('文档短于平均长度时反而加分', () => {
    expect(
      termScore({ tf: 2, idfValue: 1, docLength: 10, avgDocLength: 100 })
    ).toBeGreaterThan(
      termScore({ tf: 2, idfValue: 1, docLength: 100, avgDocLength: 100 })
    )
  })

  it('b = 0 时完全不做长度归一化', () => {
    const params = { tf: 2, idfValue: 1, avgDocLength: 100, b: 0 }

    expect(termScore({ ...params, docLength: 10 })).toBe(
      termScore({ ...params, docLength: 10_000 })
    )
    // b = 0 时长项消失，退化成 tf * (k1 + 1) / (tf + k1)
    expect(termScore({ ...params, docLength: 10 })).toBeCloseTo(
      (1 * (2 * (BM25_K1 + 1))) / (2 + BM25_K1),
      12
    )
  })

  it('b = 1 时按 dl / avgdl 完全归一化', () => {
    const expected =
      (1 * (2 * (BM25_K1 + 1))) / (2 + BM25_K1 * (1 - 1 + 1 * (200 / 100)))

    expect(
      termScore({ tf: 2, idfValue: 1, docLength: 200, avgDocLength: 100, b: 1 })
    ).toBeCloseTo(expected, 12)
  })

  it('avgDocLength 为 0 时退化成比值 1，不产生 NaN / Infinity', () => {
    const zero = termScore({
      tf: 1,
      idfValue: 1,
      docLength: 50,
      avgDocLength: 0,
    })

    expect(zero).toBe(
      termScore({ tf: 1, idfValue: 1, docLength: 50, avgDocLength: 50 })
    )
    expect(Number.isFinite(zero)).toBe(true)
    expect(Number.isNaN(zero)).toBe(false)

    const bothZero = termScore({
      tf: 1,
      idfValue: 1,
      docLength: 0,
      avgDocLength: 0,
    })

    expect(Number.isFinite(bothZero)).toBe(true)
    expect(bothZero).toBeGreaterThan(0)

    // 空语料下 avgdl 可能是 NULL / NaN，同样不能污染分数
    expect(
      Number.isFinite(
        termScore({
          tf: 1,
          idfValue: 1,
          docLength: 10,
          avgDocLength: Number.NaN,
        })
      )
    ).toBe(true)
  })

  it('docLength 为 0 时仍有限且比平均长度得分高', () => {
    const value = termScore({
      tf: 1,
      idfValue: 1,
      docLength: 0,
      avgDocLength: 100,
    })

    expect(Number.isFinite(value)).toBe(true)
    expect(value).toBeGreaterThan(0)
    expect(value).toBeGreaterThan(
      termScore({ tf: 1, idfValue: 1, docLength: 100, avgDocLength: 100 })
    )
  })

  it('采纳自定义 k1', () => {
    const params = {
      tf: 3,
      idfValue: 2,
      docLength: 200,
      avgDocLength: 100,
      b: BM25_B,
    }

    expect(termScore({ ...params, k1: 3 })).toBeCloseTo(
      formula({ ...params, k1: 3 }),
      12
    )
    expect(termScore({ ...params, k1: 3 })).not.toBeCloseTo(
      termScore({ ...params, k1: BM25_K1 }),
      6
    )
  })

  it('k1 / b 缺省时等于常量', () => {
    const expected = formula({
      tf: 2,
      idfValue: 1.5,
      docLength: 250,
      avgDocLength: 100,
      k1: BM25_K1,
      b: BM25_B,
    })

    expect(
      termScore({ tf: 2, idfValue: 1.5, docLength: 250, avgDocLength: 100 })
    ).toBeCloseTo(expected, 12)
  })

  it('idf 为 0 / 负数 / 非有限值的词项不贡献分数', () => {
    const base = { tf: 5, docLength: 100, avgDocLength: 100 }

    expect(termScore({ ...base, idfValue: 0 })).toBe(0)
    expect(termScore({ ...base, idfValue: -1 })).toBe(0)
    expect(termScore({ ...base, idfValue: Number.NaN })).toBe(0)
  })
})

describe('scoreDocument', () => {
  it('空词项列表得 0 分', () => {
    expect(
      scoreDocument({ terms: [], docLength: 100, avgDocLength: 100 })
    ).toBe(0)
  })

  it('等于各词项 termScore 之和', () => {
    const terms = [
      { tf: 3, idfValue: idf(2, 10) },
      { tf: 1, idfValue: idf(5, 10) },
      { tf: 7, idfValue: idf(9, 10) },
    ]
    const params = { docLength: 250, avgDocLength: 120 }
    const expected = terms.reduce(
      (sum, term) => sum + termScore({ ...term, ...params }),
      0
    )

    expect(scoreDocument({ terms, ...params })).toBeCloseTo(expected, 12)
    expect(scoreDocument({ terms, ...params })).toBeGreaterThan(
      scoreDocument({ terms: terms.slice(0, 1), ...params })
    )
  })

  it('自定义 k1 / b 透传到每个词项', () => {
    const terms = [
      { tf: 2, idfValue: 1 },
      { tf: 5, idfValue: 0.5 },
    ]
    const params = { docLength: 300, avgDocLength: 100, k1: 2, b: 0.5 }
    const expected = terms.reduce(
      (sum, term) => sum + formula({ ...term, ...params }),
      0
    )

    expect(scoreDocument({ terms, ...params })).toBeCloseTo(expected, 12)
  })

  it('全部词项都不贡献时为 0，而不是 NaN', () => {
    const score = scoreDocument({
      terms: [
        { tf: 0, idfValue: 0 },
        { tf: 3, idfValue: 0 },
      ],
      docLength: 100,
      avgDocLength: 100,
    })

    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })
})

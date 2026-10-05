/**
 * token 估算器测试
 *
 * 重点不是"估得准不准"（它是保守上界，本来就不追求准），而是：
 * 1. 方向必须对：**只能高估，不能低估**（低估会让请求真的撞上 provider 的超窗错误）
 * 2. 口径必须稳定：同样的文本永远得到同样的数（否则预算会随调用顺序漂移）
 * 3. 不能退化成"按字符数算"：中文与英文的字符/token 比差了 4 倍，这正是改造要修的问题
 */

import { describe, expect, it } from 'vitest'
import {
  MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  TOKEN_ESTIMATOR_KIND,
  estimateHistoryTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  estimateTokens,
} from '../tokens'
import { filler } from './fixtures'

describe('estimateTokens：保守上界', () => {
  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('ASCII 按 4 字符/token 上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('hello world')).toBe(3)
  })

  it('CJK 按 1 字符/token', () => {
    expect(estimateTokens('你好')).toBe(2)
    expect(estimateTokens(filler(100))).toBe(100)
    expect(estimateTokens('，。！？')).toBe(4) // 全角标点落在 CJK 区间
  })

  it('emoji 与其他文字按 2 字符/token 上界', () => {
    // 代理对（2 个 UTF-16 码元）→ 4，比真实的 2~3 更保守
    expect(estimateTokens('😀')).toBe(4)
  })

  it('绝不会低估：对真实 tokenizer 的常见样本都取到上界', () => {
    // 这些是真实 BPE 分词下的典型 token 数（英文约 4 字符/token，中文约 0.6~0.7）
    const samples: Array<[string, number]> = [
      ['The quick brown fox jumps over the lazy dog', 9],
      ['你好，世界', 4],
      ['给我讲讲 RAG 的混合检索是怎么做的', 14],
    ]
    for (const [text, realTokens] of samples) {
      expect(estimateTokens(text)).toBeGreaterThanOrEqual(realTokens)
    }
  })

  it('同一文本多次估算结果一致（无隐藏状态）', () => {
    const text = '混合检索 + 精排：RRF 融合后 30 条候选进入 cross-encoder'
    const first = estimateTokens(text)
    for (let i = 0; i < 5; i++) expect(estimateTokens(text)).toBe(first)
  })

  it('可加性：拼接后的估算不超过两段估算之和 + 1（避免跨界取整放大）', () => {
    const a = 'abcde'
    const b = 'fghij'
    expect(estimateTokens(a + b)).toBeLessThanOrEqual(
      estimateTokens(a) + estimateTokens(b) + 1
    )
  })

  it('估算器性质被显式标记为启发式（报告里不能当成实测）', () => {
    expect(TOKEN_ESTIMATOR_KIND).toBe('conservative-heuristic')
  })
})

describe('estimateMessageTokens / estimateHistoryTokens', () => {
  it('每条消息含固定包装开销', () => {
    expect(estimateMessageTokens({ role: 'user', content: '你好' })).toBe(
      MESSAGE_OVERHEAD_TOKENS + 2
    )
  })

  it('content 为 null 时只计包装开销（助手只发起工具调用、没有正文的情形）', () => {
    expect(estimateMessageTokens({ role: 'assistant', content: null })).toBe(
      MESSAGE_OVERHEAD_TOKENS
    )
  })

  it('一次遍历给出逐条明细与合计，且逐条之和等于合计', () => {
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: 'ok' },
    ]
    const breakdown = estimateHistoryTokens(messages)
    expect(breakdown.perMessage).toHaveLength(3)
    expect(breakdown.perMessage.reduce((a, b) => a + b, 0)).toBe(
      breakdown.total
    )
  })

  it('空历史合计为 0', () => {
    expect(estimateHistoryTokens([]).total).toBe(0)
  })
})

describe('estimateRequestTokens', () => {
  it('包含整请求固定开销与每一层', () => {
    const system = 'sys'
    const current = 'hi'
    const history = [{ role: 'assistant', content: 'x' }]

    const expected =
      REQUEST_OVERHEAD_TOKENS +
      estimateMessageTokens({ role: 'system', content: system }) +
      estimateMessageTokens({ role: 'assistant', content: 'x' }) +
      estimateMessageTokens({ role: 'user', content: current })

    expect(estimateRequestTokens(system, current, history)).toBe(expected)
  })
})

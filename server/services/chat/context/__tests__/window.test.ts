/**
 * 最近窗口选择测试
 *
 * 这个模块最容易出错的地方不是"预算算得准不准"，而是**切出了非法/残缺的消息序列**：
 * - 窗口以 assistant 开头 → 模型看到一段没有问题的答案
 * - 窗口以 tool 结果开头 → OpenAI 兼容协议下的非法序列（tool 必须紧跟带 tool_calls 的 assistant）
 * - 窗口为空但历史里明明有内容 → 模型彻底失忆
 *
 * 所以断言的重点是"边界对齐"，而不仅仅是 token 数量。
 */

import { describe, expect, it } from 'vitest'
import { estimateHistoryTokens } from '../tokens'
import { selectRecentMessages } from '../window'
import { filler, makeHistory } from './fixtures'
import type { ContextHistoryMessage } from '../types'

/** 便捷调用：估算与选择一起做（模拟 manager 的用法：估算只做一次） */
function select(messages: ContextHistoryMessage[], budgetTokens: number) {
  return selectRecentMessages(
    messages,
    estimateHistoryTokens(messages),
    budgetTokens
  )
}

describe('selectRecentMessages：按 token 预算选连续后缀', () => {
  const history = makeHistory({ turns: 10, tokensPerMessage: 100 })
  // 每条消息 = 100 + 4(包装) = 104 token
  const perMessage = 104

  it('预算充足时保留全部历史', () => {
    const result = select(history, perMessage * history.length)
    expect(result.messages).toHaveLength(history.length)
    expect(result.droppedCount).toBe(0)
    expect(result.startIndex).toBe(0)
  })

  it('预算只够 N 条时，保留的是**最新**的 N 条连续后缀', () => {
    const result = select(history, perMessage * 4)
    expect(result.messages).toHaveLength(4)
    // 保留的必须是尾部
    expect(result.messages).toEqual(history.slice(history.length - 4))
    expect(result.droppedCount).toBe(history.length - 4)
  })

  it('预算为 0 时窗口为空，且如实报出丢弃条数', () => {
    const result = select(history, 0)
    expect(result.messages).toEqual([])
    expect(result.droppedCount).toBe(history.length)
  })

  it('负预算不会被当成"无限预算"', () => {
    const result = select(history, -1000)
    expect(result.messages).toEqual([])
  })

  it('空历史返回空窗口且不报错', () => {
    const result = select([], 1000)
    expect(result.messages).toEqual([])
    expect(result.tokens).toBe(0)
    expect(result.droppedCount).toBe(0)
  })
})

describe('selectRecentMessages：整轮与序列合法性', () => {
  const history = makeHistory({ turns: 10, tokensPerMessage: 100 })
  const perMessage = 104

  it('窗口起始落在 assistant 上时，向前扩到该轮的 user（保住"用户问了什么"）', () => {
    // 预算 400 → 朴素后缀从 index 17（assistant）开始、用掉 312，还剩 88 的余量；
    // 向前补一条 user（104）共 416，在 15% 容差（460）内 → 应当扩。
    expect(history[17].role).toBe('assistant')

    const result = select(history, 400)
    expect(result.messages[0].role).toBe('user')
    expect(result.adjustedForPair).toBe(true)
    expect(result.messages).toHaveLength(4)
    expect(result.messages).toEqual(history.slice(16))
  })

  it('扩一轮会大幅超预算时，改为向前丢掉半轮（严格守住预算）', () => {
    // 每条消息的 cost = 4(包装) + 正文字数（汉字 1 token/字）
    //   0 user 1004 ｜ 1 assistant 204 ｜ 2 user 6 ｜ 3 assistant 6 ｜ 4 user 6 ｜ 5 assistant 5
    const messages: ContextHistoryMessage[] = [
      { id: 'a', role: 'user', content: filler(1000) }, // 最近的前一条 user 极其昂贵
      { id: 'b', role: 'assistant', content: filler(200) },
      { id: 'c', role: 'user', content: '继续' }, // cost 6
      { id: 'd', role: 'assistant', content: '好的' }, // cost 6 ← 朴素起点
      { id: 'e', role: 'user', content: '再问' }, // cost 6
      { id: 'f', role: 'assistant', content: '嗯' }, // cost 5
    ]

    // 预算 17：从后往前只装得下 [3,4,5]（6+6+5=17），起点是 assistant(3)
    const result = select(messages, 17)

    // 扩到 user(2) 需要 +6 → 23，超过容差 17×1.15=19.55 → 扩不动
    expect(17 + 6).toBeGreaterThan(17 * 1.15)

    // 于是向前丢掉半轮：从下一个 user 边界（index 4）重新开始 → [4,5]
    expect(result.startIndex).toBe(4)
    expect(result.messages).toEqual(messages.slice(4))
    expect(result.tokens).toBe(11)
    expect(result.adjustedForPair).toBe(true)
    // 关键不变量：无论如何都不能以 assistant 开头
    expect(result.messages[0].role).toBe('user')
  })

  it('扩不动且后面已无 user 边界时，退化为无条件扩（宁可略超预算也不清空窗口）', () => {
    const messages: ContextHistoryMessage[] = [
      { id: 'a', role: 'user', content: '问题' }, // cost 6
      { id: 'b', role: 'assistant', content: filler(1000) }, // 昂贵
      { id: 'c', role: 'assistant', content: filler(1000) },
    ]
    // 预算只够最后 1 条，扩到 user(0) 远超容差，且 index 1 之后没有 user 边界
    const result = select(messages, 1004)
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages[0].role).toBe('user')
    expect(result.startIndex).toBe(0)
  })

  it('窗口永不以 tool 消息开头（孤立 tool 结果是非法序列）', () => {
    const withTool: ContextHistoryMessage[] = [
      { id: '1', role: 'user', content: '查一下' },
      { id: '2', role: 'assistant', content: null },
      { id: '3', role: 'tool', content: '检索结果' },
      { id: '4', role: 'assistant', content: '答案' },
      { id: '5', role: 'user', content: '再查一下' },
      { id: '6', role: 'assistant', content: null },
      { id: '7', role: 'tool', content: '检索结果2' },
      { id: '8', role: 'assistant', content: '答案2' },
    ]
    // 从任意预算切，首条都不能是 tool
    for (const budget of [0, 5, 20, 40, 60, 100, 500]) {
      const result = select(withTool, budget)
      if (result.messages.length > 0) {
        expect(result.messages[0].role).not.toBe('tool')
      }
    }
  })

  it('至少保留一个用户轮次：纯 assistant 尾部不会把窗口挤成空', () => {
    const trailingAssistant: ContextHistoryMessage[] = [
      { id: '1', role: 'user', content: filler(100) },
      { id: '2', role: 'assistant', content: filler(100) },
      { id: '3', role: 'assistant', content: filler(100) },
    ]
    // 预算只够最后 1 条 assistant：必须向前把 user 一起带进来
    const result = select(trailingAssistant, 110)
    expect(result.messages.some((m) => m.role === 'user')).toBe(true)
  })

  it('minUserTurns 生效：配置要求保留 N 轮时窗口就真的留 N 轮', () => {
    // 每条消息 cost = 4 + 100 = 104；预算 300 只够 2 条
    const history = makeHistory({ turns: 6, tokensPerMessage: 100 })
    const breakdown = estimateHistoryTokens(history)

    const oneTurn = selectRecentMessages(history, breakdown, 300, {
      minUserTurns: 1,
    })
    const countUser = (r: typeof oneTurn) =>
      r.messages.filter((m) => m.role === 'user').length

    expect(countUser(oneTurn)).toBe(1)

    const threeTurns = selectRecentMessages(history, breakdown, 300, {
      minUserTurns: 3,
    })
    expect(countUser(threeTurns)).toBe(3)
    // 为了凑够轮次必须向前扩，所以窗口比 minUserTurns=1 时更长
    expect(threeTurns.messages.length).toBeGreaterThan(oneTurn.messages.length)
  })

  it('minUserTurns 大于历史里实际存在的轮次时，退化为"有多少给多少"而不是报错', () => {
    const history = makeHistory({ turns: 2, tokensPerMessage: 100 })
    const breakdown = estimateHistoryTokens(history)
    const result = selectRecentMessages(history, breakdown, 300, {
      minUserTurns: 99,
    })
    expect(result.messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })

  it('token 合计与窗口内容一致', () => {
    const result = select(history, perMessage * 5)
    const recomputed = estimateHistoryTokens(result.messages).total
    expect(result.tokens).toBe(recomputed)
  })
})

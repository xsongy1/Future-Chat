/**
 * 回归测试：多轮 Function Calling 达到轮次上限时，落库正文不能为空
 *
 * 背景：createSSEStreamWithTools 的循环最多跑 MAX_TOOL_ROUNDS(5) 轮。
 * 以前只有"某一轮没有工具调用"这条分支才会给 finalAnswerContent 赋值，于是：
 *   - 轮次跑满退出 → finalAnswerContent 保持初始 ''，但每轮正文其实都已流给前端
 *   - 结果：前端显示最后一轮回答，数据库存空字符串，刷新后回答消失
 * 现在每轮都用 pickPersistedAnswer 更新，跑满上限时落库的仍是最后一轮正文。
 */

import { describe, it, expect } from 'vitest'
import { pickPersistedAnswer } from '@/server/services/chat/round-answer'

describe('pickPersistedAnswer：多轮工具调用该落库哪一轮正文', () => {
  it('轮次跑满上限：保留最后一轮正文，而不是空字符串（本次修的缺口）', () => {
    // 模拟 5 轮全部带工具调用：每轮都有正文，循环因 while 条件失败退出
    let persisted = ''
    const roundAnswers = ['第一轮正文', '第二轮正文', '第三轮正文', '第四轮正文', '第五轮正文']
    for (const answer of roundAnswers) {
      persisted = pickPersistedAnswer(persisted, answer)
    }
    expect(persisted).toBe('第五轮正文')
    // 旧实现的等价写法：只在"无工具调用"分支赋值 → 跑满上限时是空串
    expect('').not.toBe(persisted)
  })

  it('正常收尾：最后一轮无工具调用时，落库的就是那一轮正文', () => {
    let persisted = ''
    persisted = pickPersistedAnswer(persisted, '我先查一下')
    persisted = pickPersistedAnswer(persisted, '')
    persisted = pickPersistedAnswer(persisted, '查到了，结论是……')
    expect(persisted).toBe('查到了，结论是……')
  })

  it('整轮只有工具调用、没有正文时，保持上一轮的值（不被空串覆盖）', () => {
    expect(pickPersistedAnswer('已有正文', '')).toBe('已有正文')
    expect(pickPersistedAnswer('已有正文', null)).toBe('已有正文')
    expect(pickPersistedAnswer('已有正文', undefined)).toBe('已有正文')
  })

  it('首轮就空（模型直接调工具、完全没输出文本）时保持空，不会凭空造内容', () => {
    expect(pickPersistedAnswer('', '')).toBe('')
  })

  it('有正文的轮次覆盖前一轮：与前端 RoundContentTracker 的展示结果对齐', () => {
    // 前端每次工具轮结束会把内容起点重置到当前长度，所以用户看到的最终正文 = 最后一轮
    expect(pickPersistedAnswer('第一轮的过渡话', '第二轮才是给用户的回答')).toBe(
      '第二轮才是给用户的回答'
    )
  })
})

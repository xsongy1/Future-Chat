/**
 * 附件预算与截断测试
 *
 * 这一组用例对应的是一个真实的线上问题：上传上限 1MB 的 .txt/.md 会被**全文**
 * 拼进当前消息，1MB 中文约 100 万 token，远超 32K 窗口 —— 一次上传就能让对话不可用。
 *
 * 断言的重点：
 * - 装得下就必须一个字符都不改（不能"顺手"重写用户文件）
 * - 装不下就必须截断到预算内，并留下显式的省略标记（不能静默丢数据）
 * - 连保底都放不下就要整份丢弃并明说（不能让模型假装读过）
 */

import { describe, expect, it } from 'vitest'
import { appendAttachments, formatAttachmentBlock } from '../../prompt.builder'
import { applyAttachmentBudget, estimateAttachmentTokens } from '../attachments'
import { estimateTokens } from '../tokens'
import { filler, makeContextConfig } from './fixtures'
import type { ContextConfig } from '../config'
import type { ContextAttachment } from '../types'

function makeAttachment(name: string, tokens: number): ContextAttachment {
  return { name, content: filler(tokens), type: 'txt', size: tokens }
}

describe('applyAttachmentBudget：快速路径', () => {
  it('没有附件时不做任何事', () => {
    const result = applyAttachmentBudget([], 1000, makeContextConfig())
    expect(result.attachments).toEqual([])
    expect(result.tokens).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.notice).toBeNull()
  })

  it('预算够时原文全量，一个字符都不动', () => {
    const file = makeAttachment('readme.md', 200)
    const result = applyAttachmentBudget([file], 5000, makeContextConfig())

    expect(result.truncated).toBe(false)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].content).toBe(file.content)
    expect(result.tokens).toBe(estimateAttachmentTokens(file))
    expect(result.tokens).toBeLessThanOrEqual(5000)
  })
})

describe('applyAttachmentBudget：截断路径', () => {
  const config = makeContextConfig()

  it('超预算时截断到预算内，并留下省略标记', () => {
    const file = makeAttachment('大文件.md', 20000)
    const budget = 1000
    const result = applyAttachmentBudget([file], budget, config)

    expect(result.truncated).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(budget)
    const content = result.attachments[0].content
    expect(content).toContain('已省略')
    // 保留文件头与文件尾：既能读到开头，也能读到结论
    expect(content.startsWith(file.content.slice(0, 10))).toBe(true)
    expect(content.endsWith(file.content.slice(-10))).toBe(true)
    expect(content.length).toBeLessThan(file.content.length)
  })

  it('截断标记里报出的是真实省略字符数', () => {
    const file = makeAttachment('x.txt', 20000)
    const result = applyAttachmentBudget([file], 800, config)
    const match = /此处已省略 (\d+) 字符/.exec(result.attachments[0].content)
    expect(match).not.toBeNull()
    const reported = Number(match![1])
    expect(reported).toBeGreaterThan(0)
    // 头 + 尾 + 标记 = 原文长度
    expect(reported).toBeLessThan(file.content.length)
  })

  it('多个附件平均分配预算，总量仍不超', () => {
    const files = [makeAttachment('a.txt', 5000), makeAttachment('b.txt', 5000)]
    const budget = 1200
    const result = applyAttachmentBudget(files, budget, config)

    expect(result.attachments).toHaveLength(2)
    expect(result.tokens).toBeLessThanOrEqual(budget)
    expect(result.truncated).toBe(true)
    for (const file of result.attachments) {
      expect(file.content).toContain('已省略')
    }
  })

  it('预算连保底尺寸都放不下时，整份丢弃并给出显式说明', () => {
    const files = [
      makeAttachment('a.txt', 5000),
      makeAttachment('b.txt', 5000),
      makeAttachment('c.txt', 5000),
    ]
    // 保底 120/份 → 预算 250 只放得下 2 份
    const result = applyAttachmentBudget(files, 250, config)

    expect(result.droppedNames).toEqual(['c.txt'])
    expect(result.notice).toContain('c.txt')
    expect(result.notice).toContain('未能包含')
    expect(result.tokens).toBeLessThanOrEqual(250)
  })

  it('预算为 0 时全部丢弃，并且明确告知而不是静默', () => {
    const files = [makeAttachment('a.txt', 100), makeAttachment('b.txt', 100)]
    const result = applyAttachmentBudget(files, 0, config)

    expect(result.attachments).toEqual([])
    expect(result.droppedNames).toEqual(['a.txt', 'b.txt'])
    expect(result.notice).toContain('a.txt')
    expect(result.notice).toContain('b.txt')
    expect(result.truncated).toBe(true)
  })

  it('1MB 量级的附件被压到预算内（复现原问题的规模）', () => {
    // 1MB 中文 ≈ 100 万字符 ≈ 100 万 token
    const huge: ContextAttachment = {
      name: 'huge.txt',
      content: filler(200000),
      type: 'txt',
      size: 600000,
    }
    const before = estimateAttachmentTokens(huge)
    const result = applyAttachmentBudget([huge], 12000, config)

    expect(before).toBeGreaterThan(190000)
    expect(result.tokens).toBeLessThanOrEqual(12000)
    expect(result.truncated).toBe(true)
  })

  it('截断后的内容仍是合法的附件块（与未截断时结构一致）', () => {
    const file = makeAttachment('doc.md', 8000)
    const result = applyAttachmentBudget([file], 700, config)
    const block = formatAttachmentBlock(result.attachments[0])

    expect(block).toContain('**附件: doc.md**')
    expect(block.startsWith('\n\n---\n')).toBe(true)
    expect(block.trimEnd().endsWith('```')).toBe(true)
  })

  it('截断是确定性的：同样输入两次得到同样输出', () => {
    const file = makeAttachment('d.txt', 9999)
    const first = applyAttachmentBudget([file], 900, config)
    const second = applyAttachmentBudget([file], 900, config)
    expect(first.attachments[0].content).toBe(second.attachments[0].content)
    expect(first.tokens).toBe(second.tokens)
  })
})

describe('与 prompt.builder 的拼装保持一致', () => {
  it('截断后的附件走 appendAttachments，实际占用仍在预算内', () => {
    const config: ContextConfig = makeContextConfig()
    const file = makeAttachment('big.txt', 30000)
    const result = applyAttachmentBudget([file], 2000, config)

    const message = appendAttachments('看看这个文件', result.attachments)
    // 实测整条消息的 token 必须仍然低于"预算 + 用户正文 + 固定开销"
    const upperBound = 2000 + estimateTokens('看看这个文件') + 16
    expect(estimateTokens(message)).toBeLessThanOrEqual(upperBound)
  })
})

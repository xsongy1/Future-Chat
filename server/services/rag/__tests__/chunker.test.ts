/**
 * Chunker 单元测试
 *
 * 用相对路径导入（vitest.config.ts 未配置 @/ 别名）。
 * 覆盖切分的边界行为：空输入、单块、多块、超长无标点文本、重叠、CRLF。
 */

import { describe, it, expect } from 'vitest'
import {
  chunkText,
  DEFAULT_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
} from '../chunker'

describe('chunkText', () => {
  it('空文本返回空数组', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  \t ')).toEqual([])
  })

  it('短文本返回单个 chunk，index 从 0 开始', () => {
    const result = chunkText('这是一段很短的文本。')
    expect(result).toHaveLength(1)
    expect(result[0].index).toBe(0)
    expect(result[0].content).toBe('这是一段很短的文本。')
  })

  it('统一 CRLF 换行', () => {
    const result = chunkText('第一段\r\n\r\n第二段')
    expect(result).toHaveLength(1)
    expect(result[0].content).not.toContain('\r')
    expect(result[0].content).toContain('第一段')
    expect(result[0].content).toContain('第二段')
  })

  it('长文本切成多块，index 连续递增', () => {
    // 每段 100 字，共 30 段 → 远超单块 800 字上限
    const paragraph = '知'.repeat(100)
    const text = Array.from({ length: 30 }, () => paragraph).join('\n\n')

    const result = chunkText(text)

    expect(result.length).toBeGreaterThan(1)
    result.forEach((chunk, i) => expect(chunk.index).toBe(i))
  })

  it('块长度不超过 chunkSize（除硬切场景）', () => {
    const paragraph = '知'.repeat(100)
    const text = Array.from({ length: 30 }, () => paragraph).join('\n\n')
    const size = 300

    const result = chunkText(text, { chunkSize: size, overlap: 0 })

    for (const chunk of result) {
      expect(chunk.content.length).toBeLessThanOrEqual(size)
    }
  })

  it('相邻块之间存在重叠内容', () => {
    const paragraph = '甲乙丙丁戊己庚辛壬癸'.repeat(10) // 100 字
    const text = Array.from({ length: 20 }, (_, i) => `第${i}段${paragraph}`).join(
      '\n\n'
    )

    const result = chunkText(text, { chunkSize: 200, overlap: 50 })

    expect(result.length).toBeGreaterThan(1)

    // 后一块开头应包含前一块结尾的片段（重叠）
    const prevTail = result[0].content.slice(-50)
    expect(result[1].content.startsWith(prevTail.slice(0, 20))).toBe(true)
  })

  it('无标点超长文本按长度硬切，不丢内容', () => {
    const text = 'a'.repeat(2500)
    const size = 400

    const result = chunkText(text, { chunkSize: size, overlap: 0 })

    expect(result.length).toBeGreaterThanOrEqual(Math.ceil(2500 / size))
    // 硬切场景下内容应被完整保留（拼接后长度等于原文）
    const totalLength = result.reduce((sum, c) => sum + c.content.length, 0)
    expect(totalLength).toBe(2500)
  })

  it('超长单段按句子边界切分', () => {
    const sentence = '这是一个测试句子。'
    const text = sentence.repeat(200) // 1800 字，无空行

    const result = chunkText(text, { chunkSize: 400, overlap: 0 })

    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      expect(chunk.content.length).toBeLessThanOrEqual(400)
    }
  })

  it('极短尾块并入前一块，不产生碎片（overlap 为 0 时）', () => {
    // 构造恰好超过一块的内容，再补一个极短段落
    const big = '知'.repeat(DEFAULT_CHUNK_SIZE)
    const text = `${big}\n\n短`

    const result = chunkText(text, { overlap: 0 })

    // 不存在长度小于 MIN_CHUNK_SIZE 的独立尾块
    const last = result[result.length - 1]
    if (result.length > 1) {
      expect(last.content.length).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE)
    }
  })

  it('overlap 被限制为不超过 chunkSize 的一半', () => {
    const paragraph = '知'.repeat(100)
    const text = Array.from({ length: 30 }, () => paragraph).join('\n\n')

    // 传入过大的 overlap，不应导致死循环或内容爆炸
    const result = chunkText(text, { chunkSize: 200, overlap: 5000 })

    expect(result.length).toBeGreaterThan(0)
    // 每块长度不应因为重叠而失控（最多 chunkSize + overlap 上限）
    for (const chunk of result) {
      expect(chunk.content.length).toBeLessThanOrEqual(200 + 100)
    }
  })
})

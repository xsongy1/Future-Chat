/**
 * 知识库检索结果的展示合并：状态（status）传播
 *
 * 模型在同一条回答里常连续调用多次 knowledge_search（第一次没命中就换个问法再试）。
 * 合并后的状态必须反映"最终结论"，否则界面会说错话：
 * - 只要合并后有来源 → matched；
 * - 一条来源都没有 → 用最后一次调用的状态（最后一次才是结论）；
 * - 连状态字段都没有的老历史消息 → 保持 undefined，由界面回退到中性文案。
 *
 * 纯函数，不依赖浏览器与 React。
 */

import { describe, it, expect } from 'vitest'
import {
  mergeKnowledgeInvocations,
  toKnowledgeInvocation,
} from '../knowledge-invocations'
import type {
  KnowledgeRetrievalStatus,
  ToolInvocation,
} from '@/features/chat/types/chat'

function invocation(
  toolCallId: string,
  result: {
    success: boolean
    resultCount?: number
    status?: KnowledgeRetrievalStatus
    knowledgeSources?: Array<{ documentName: string; chunkIndex: number }>
  },
  state: ToolInvocation['state'] = 'completed'
): ToolInvocation {
  return {
    toolCallId,
    name: 'knowledge_search',
    state,
    result: result as ToolInvocation['result'],
  }
}

const source = (documentName: string, chunkIndex: number) => ({
  documentName,
  chunkIndex,
})

describe('mergeKnowledgeInvocations - 状态传播', () => {
  it('单次调用原样返回（含状态）', () => {
    const merged = mergeKnowledgeInvocations([
      invocation('1', { success: true, resultCount: 0, status: 'no_match' }),
    ])

    expect(merged?.result?.status).toBe('no_match')
  })

  it('多次 no_match 重试后仍无来源 → 用最后一次的状态', () => {
    const merged = mergeKnowledgeInvocations([
      invocation('1', { success: true, resultCount: 0, status: 'no_match' }),
      invocation('2', {
        success: true,
        resultCount: 0,
        status: 'empty_knowledge_base',
      }),
    ])

    expect(merged?.result?.resultCount).toBe(0)
    expect(merged?.result?.status).toBe('empty_knowledge_base')
  })

  it('先 no_match 后命中 → matched（以最终结论为准）', () => {
    const merged = mergeKnowledgeInvocations([
      invocation('1', { success: true, resultCount: 0, status: 'no_match' }),
      invocation('2', {
        success: true,
        resultCount: 1,
        status: 'matched',
        knowledgeSources: [source('a.md', 0)],
      }),
    ])

    expect(merged?.result?.status).toBe('matched')
    expect(merged?.result?.resultCount).toBe(1)
    expect(merged?.result?.knowledgeSources).toHaveLength(1)
  })

  it('有计数但拿不到来源时也算 matched（结果数优先用去重来源数）', () => {
    const merged = mergeKnowledgeInvocations([
      invocation('1', { success: true, resultCount: 3, status: 'matched' }),
    ])

    expect(merged?.result?.status).toBe('matched')
    expect(merged?.result?.resultCount).toBe(3)
  })

  it('老历史消息没有 status 字段 → 保持 undefined，由界面回退到中性文案', () => {
    const merged = mergeKnowledgeInvocations([
      invocation('1', { success: true, resultCount: 0 }),
    ])

    // 当时的 0 条已经无从判断是"没有证据"还是"检索失败"，不替它下结论
    expect(merged?.result?.status).toBeUndefined()
    expect(merged?.result?.resultCount).toBe(0)
  })
})

describe('toKnowledgeInvocation - 历史结果还原', () => {
  it('把持久化的 toolResult 还原成调用，并带上 status', () => {
    const restored = toKnowledgeInvocation({
      toolCallId: 'tc-1',
      name: 'knowledge_search',
      result: { success: true, resultCount: 0, status: 'no_match' },
    })

    expect(restored.state).toBe('completed')
    expect(restored.result?.status).toBe('no_match')
  })

  it('取消的结果标记为 cancelled，失败的结果标记为 failed', () => {
    expect(
      toKnowledgeInvocation({
        toolCallId: 'tc-1',
        name: 'knowledge_search',
        result: { success: false, cancelled: true, status: 'error' },
      }).state
    ).toBe('cancelled')

    expect(
      toKnowledgeInvocation({
        toolCallId: 'tc-2',
        name: 'knowledge_search',
        result: { success: false, status: 'error' },
      }).state
    ).toBe('failed')
  })
})

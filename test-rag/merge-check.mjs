/**
 * 合并逻辑验证（不依赖 vitest / esbuild，直接用 Node 的类型擦除运行真实 TS 源码）
 *
 *   node --experimental-strip-types test-rag/merge-check.mjs
 *
 * 覆盖用户报的 bug：同一条消息里第一次检索 0 条、第二次检索命中时，
 * 合并后必须只显示「已检索 N 个知识片段 + 来源」，不能出现「未找到」。
 */

import assert from 'node:assert'
import { mergeKnowledgeInvocations, toKnowledgeInvocation } from '../features/chat/utils/knowledge-invocations.ts'

const K = 'knowledge_search'

function inv(id, state, result = {}) {
  return { toolCallId: id, name: K, state, result }
}
function src(doc, idx, score) {
  return { documentName: doc, chunkIndex: idx, score, snippet: `${doc} 摘要` }
}

let pass = 0
function check(label, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${label}`)
  } catch (error) {
    console.log(`  ❌ ${label}\n     ${error.message}`)
    process.exitCode = 1
  }
}

console.log('=== 合并逻辑验证 ===')

check('空数组 → null', () => {
  assert.strictEqual(mergeKnowledgeInvocations([]), null)
})

check('单次调用 → 原样返回', () => {
  const one = inv('1', 'completed', { success: true, resultCount: 3, knowledgeSources: [src('a.md', 0, 0.8)] })
  assert.strictEqual(mergeKnowledgeInvocations([one]), one)
})

check('用户报的 bug：第 1 次 0 条 + 第 2 次 3 条 → 只显示 3 条，状态为成功', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'completed', { success: true, resultCount: 0, knowledgeSources: [] }),
    inv('2', 'completed', {
      success: true,
      resultCount: 3,
      knowledgeSources: [src('project-overview.md', 0, 0.79), src('development-guide.md', 0, 0.66), src('deployment-guide.md', 0, 0.65)],
    }),
  ])
  assert.strictEqual(merged.state, 'completed')
  assert.strictEqual(merged.result.success, true)
  assert.strictEqual(merged.result.resultCount, 3)
  assert.strictEqual(merged.result.knowledgeSources.length, 3)
  // 界面文案取 resultCount>0 且 sources 非空 → 渲染「已检索 3 个知识片段」而不是「未找到」
})

check('全部 0 条 → 仍显示「未找到」（不伪造来源）', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'completed', { success: true, resultCount: 0, knowledgeSources: [] }),
    inv('2', 'completed', { success: true, resultCount: 0, knowledgeSources: [] }),
  ])
  assert.strictEqual(merged.state, 'completed')
  assert.strictEqual(merged.result.resultCount, 0)
  assert.deepStrictEqual(merged.result.knowledgeSources, [])
})

check('多次命中同一片段 → 按 文档名#序号 去重', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'completed', { success: true, resultCount: 2, knowledgeSources: [src('a.md', 0, 0.8), src('b.md', 0, 0.7)] }),
    inv('2', 'completed', { success: true, resultCount: 2, knowledgeSources: [src('a.md', 0, 0.82), src('c.md', 1, 0.6)] }),
  ])
  assert.strictEqual(merged.result.resultCount, 3)
  assert.deepStrictEqual(
    merged.result.knowledgeSources.map((s) => `${s.documentName}#${s.chunkIndex}`),
    ['a.md#0', 'b.md#0', 'c.md#1']
  )
})

check('还有一次在跑 → 状态为 running（界面显示「正在查询知识库…」）', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'completed', { success: true, resultCount: 1, knowledgeSources: [src('a.md', 0, 0.8)] }),
    inv('2', 'running', {}),
  ])
  assert.strictEqual(merged.state, 'running')
})

check('全部失败 → 状态为 failed（界面显示「知识库检索失败」）', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'failed', { success: false }),
    inv('2', 'failed', { success: false }),
  ])
  assert.strictEqual(merged.state, 'failed')
  assert.strictEqual(merged.result.success, false)
})

check('混合失败+成功 → 成功优先', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'failed', { success: false }),
    inv('2', 'completed', { success: true, resultCount: 1, knowledgeSources: [src('a.md', 0, 0.8)] }),
  ])
  assert.strictEqual(merged.state, 'completed')
  assert.strictEqual(merged.result.success, true)
})

check('取消标记被保留', () => {
  const merged = mergeKnowledgeInvocations([
    inv('1', 'cancelled', { success: false, cancelled: true }),
    inv('2', 'completed', { success: true, resultCount: 1, knowledgeSources: [src('a.md', 0, 0.8)] }),
  ])
  assert.strictEqual(merged.result.cancelled, true)
})

check('历史消息：toolResults → invocation 还原（成功）', () => {
  const i = toKnowledgeInvocation({ toolCallId: 'x', name: K, result: { success: true, resultCount: 2 } })
  assert.strictEqual(i.state, 'completed')
})

check('历史消息：toolResults → invocation 还原（失败 / 取消）', () => {
  assert.strictEqual(toKnowledgeInvocation({ toolCallId: 'x', name: K, result: { success: false } }).state, 'failed')
  assert.strictEqual(
    toKnowledgeInvocation({ toolCallId: 'x', name: K, result: { success: false, cancelled: true } }).state,
    'cancelled'
  )
})

console.log(`\n通过 ${pass} 项${process.exitCode ? '（存在失败）' : '，全部通过 ✅'}`)

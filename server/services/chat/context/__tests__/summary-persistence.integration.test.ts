/**
 * 集成测试（需要真实数据库）：摘要持久化与并发 CAS
 *
 * 默认跳过。跑法：
 *
 *   CONTEXT_DB_TEST=1 pnpm test
 *
 * ## 为什么必须打真实库
 *
 * `ConversationRepository.saveSummary()` 的正确性建立在一条**数据库语义**上：
 * Postgres 在 READ COMMITTED 隔离级别下，会对接并发修改过的行**重新求值 WHERE**。
 * 「两个请求同时压缩，只有一个能写成功」这个保证完全依赖这一点。
 *
 * mock 掉 Prisma 就只能验证"我调用了 updateMany"，验证不了"并发时真的只有一个能写成"——
 * 而后者才是这个设计唯一的价值所在。所以这个文件必须打真库。
 *
 * 与 RAG 的 indexing.integration.test.ts 保持同一套开关约定（RAG_DB_TEST / CONTEXT_DB_TEST）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { ConversationRepository } from '@/server/repositories/conversation.repository'

const RUN_DB_TESTS = process.env.CONTEXT_DB_TEST === '1'

/** 测试期间创建的用户与会话 id，结束时清理 */
let userId = ''
let conversationId = ''

describe.runIf(RUN_DB_TESTS)('摘要持久化（真实数据库）', () => {
  beforeAll(async () => {
    // 建一个临时用户 + 临时会话；结束时整体删除（User 上配了级联）
    const user = await prisma.user.create({
      data: { username: `ctx-test-${Date.now()}` },
    })
    userId = user.id
    const conversation = await prisma.conversation.create({
      data: { userId, title: '上下文管理集成测试' },
    })
    conversationId = conversation.id
  })

  afterAll(async () => {
    if (userId) {
      // 会话与摘要都挂在 User 下，删用户即级联清理
      await prisma.user.deleteMany({ where: { id: userId } })
    }
  })

  it('新会话的摘要相关三列为空（迁移后的默认状态）', async () => {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    expect(conversation.summary).toBeNull()
    expect(conversation.summaryUpdatedAt).toBeNull()
    expect(conversation.summaryUpToMessageId).toBeNull()
  })

  it('首次写入（期望版本为 null）成功，并能原样读回摘要与水位线', async () => {
    const ok = await ConversationRepository.saveSummary(
      conversationId,
      { summary: '# 用户目标\n集成测试摘要', summaryUpToMessageId: 'msg-42' },
      null
    )
    expect(ok).toBe(true)

    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    expect(conversation.summary).toBe('# 用户目标\n集成测试摘要')
    expect(conversation.summaryUpToMessageId).toBe('msg-42')
    expect(conversation.summaryUpdatedAt).toBeInstanceOf(Date)
  })

  it('用过期版本号写入会被拒绝，且**不会覆盖**已有摘要（CAS 的核心保证）', async () => {
    const before = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })

    // 模拟"另一个并发请求拿着更早读到的版本号来写"
    const stale = new Date(before.summaryUpdatedAt!.getTime() - 60_000)
    const ok = await ConversationRepository.saveSummary(
      conversationId,
      { summary: '这是并发输家写的摘要', summaryUpToMessageId: 'msg-999' },
      stale
    )

    expect(ok).toBe(false)

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    // 赢家的内容必须原封不动
    expect(after.summary).toBe('# 用户目标\n集成测试摘要')
    expect(after.summaryUpToMessageId).toBe('msg-42')
    expect(after.summaryUpdatedAt!.getTime()).toBe(before.summaryUpdatedAt!.getTime())
  })

  it('用当前版本号写入成功，并推进水位线（增量压缩的正常路径）', async () => {
    const before = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })

    const ok = await ConversationRepository.saveSummary(
      conversationId,
      { summary: '合并后的新摘要', summaryUpToMessageId: 'msg-100' },
      before.summaryUpdatedAt
    )
    expect(ok).toBe(true)

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    expect(after.summary).toBe('合并后的新摘要')
    expect(after.summaryUpToMessageId).toBe('msg-100')
    expect(after.summaryUpdatedAt!.getTime()).toBeGreaterThan(
      before.summaryUpdatedAt!.getTime()
    )
  })

  it('真并发：两个请求同时用同一个版本号写入，只能有一个成功', async () => {
    const current = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })

    // 同一个 expectedUpdatedAt 并发提交两份不同的摘要
    const [a, b] = await Promise.all([
      ConversationRepository.saveSummary(
        conversationId,
        { summary: '并发-A', summaryUpToMessageId: 'msg-A' },
        current.summaryUpdatedAt
      ),
      ConversationRepository.saveSummary(
        conversationId,
        { summary: '并发-B', summaryUpToMessageId: 'msg-B' },
        current.summaryUpdatedAt
      ),
    ])

    // 恰好一个成功、一个失败 —— 这就是"不需要分布式锁"的全部依据
    expect([a, b].filter(Boolean)).toHaveLength(1)

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    const winner = a ? '并发-A' : '并发-B'
    expect(after.summary).toBe(winner)
    expect(after.summaryUpToMessageId).toBe(a ? 'msg-A' : 'msg-B')
  })

  it('水位线可以是 null（缺口起点未知时的退化情形），不会写坏数据', async () => {
    const current = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    const ok = await ConversationRepository.saveSummary(
      conversationId,
      { summary: '无水位线的摘要', summaryUpToMessageId: null },
      current.summaryUpdatedAt
    )
    expect(ok).toBe(true)

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
    })
    expect(after.summary).toBe('无水位线的摘要')
    expect(after.summaryUpToMessageId).toBeNull()
  })

  it('不存在的会话写入返回 false（不抛异常，不影响聊天主链路）', async () => {
    const ok = await ConversationRepository.saveSummary(
      'does-not-exist',
      { summary: 'x', summaryUpToMessageId: null },
      null
    )
    expect(ok).toBe(false)
  })
})

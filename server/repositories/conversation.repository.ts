/**
 * Conversation Repository
 *
 * 会话数据访问层
 */

import { prisma } from '@/server/db/client'

export const ConversationRepository = {
  /**
   * 获取用户所有会话（置顶优先，然后按更新时间倒序）
   */
  async findByUserId(userId: string) {
    return prisma.conversation.findMany({
      where: { userId },
      orderBy: [
        { isPinned: 'desc' }, // 置顶的在前
        { pinnedAt: 'desc' }, // 置顶时间倒序
        { updatedAt: 'desc' }, // 更新时间倒序
      ],
      include: {
        _count: {
          select: { messages: true },
        },
      },
    })
  },

  /**
   * 创建新会话
   */
  async create(userId: string, title = '新对话') {
    return prisma.conversation.create({
      data: { userId, title },
    })
  },

  /**
   * 获取单个会话（含权限检查）
   */
  async findById(id: string, userId?: string) {
    if (userId) {
      return prisma.conversation.findFirst({
        where: { id, userId },
      })
    }
    return prisma.conversation.findUnique({
      where: { id },
    })
  },

  /**
   * 更新会话标题
   */
  async updateTitle(id: string, userId: string, title: string) {
    const result = await prisma.conversation.updateMany({
      where: { id, userId },
      data: { title, updatedAt: new Date() },
    })
    return result.count > 0
  },

  /**
   * 更新会话的 updatedAt 时间戳（带权限检查）
   */
  async touch(id: string, userId?: string) {
    if (userId) {
      // 带权限检查的更新
      await prisma.conversation.updateMany({
        where: { id, userId },
        data: { updatedAt: new Date() },
      })
    } else {
      // 无权限检查（向后兼容）
      await prisma.conversation.update({
        where: { id },
        data: { updatedAt: new Date() },
      })
    }
  },

  /**
   * 删除会话
   */
  async delete(id: string, userId: string) {
    const result = await prisma.conversation.deleteMany({
      where: { id, userId },
    })
    return result.count > 0
  },

  /**
   * 置顶/取消置顶会话
   */
  async togglePin(id: string, isPinned: boolean) {
    return prisma.conversation.update({
      where: { id },
      data: {
        isPinned,
        pinnedAt: isPinned ? new Date() : null,
      },
    })
  },

  /**
   * 写入历史压缩摘要（乐观并发控制）
   *
   * ## 为什么需要 CAS
   *
   * 用户连续发 A / B / C 时会有多个请求并发读同一份会话，并各自触发压缩。
   * 如果直接 update，最后一次写入会**覆盖**掉另一次的结果——而两次压缩的水位线
   * 与摘要内容不同，覆盖就意味着某一段历史既不在摘要里、也已经被排除出窗口，
   * 信息静默丢失。
   *
   * ## 实现方式
   *
   * 用 `summaryUpdatedAt` 当版本号：只有当数据库里的值仍等于**本次读取到的值**时才写入。
   * - `expectedUpdatedAt === null` → 要求当前仍为 NULL（从未压缩过）
   * - 否则要求精确等于读到的那个时间戳
   *
   * 并发时只有第一个请求能匹配到旧值，其余请求 update 到 0 行并返回 false。
   * Postgres 在 READ COMMITTED 下会对被并发修改的行重新求值 WHERE，
   * 因此这里不需要事务、也不需要分布式锁。
   *
   * @returns 是否写入成功（false 表示已有更新的摘要，本次结果应被丢弃）
   */
  async saveSummary(
    id: string,
    data: {
      summary: string
      summaryUpToMessageId: string | null
    },
    expectedUpdatedAt: Date | null
  ): Promise<boolean> {
    const result = await prisma.conversation.updateMany({
      where: {
        id,
        summaryUpdatedAt: expectedUpdatedAt,
      },
      data: {
        summary: data.summary,
        summaryUpToMessageId: data.summaryUpToMessageId,
        summaryUpdatedAt: new Date(),
      },
    })
    return result.count > 0
  },
}

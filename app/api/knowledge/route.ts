/**
 * 知识库 API
 *
 * GET  /api/knowledge - 当前用户的知识库列表
 * POST /api/knowledge - 创建知识库 { name, description? }
 *
 * 鉴权沿用项目现有方式：getCurrentUserId()（NextAuth session 优先，JWT 兜底），
 * 所有查询都以 userId 收敛范围，客户端无法通过参数访问他人知识库。
 */

import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/server/auth/utils'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { audit } from '@/server/middleware/audit'

/** 知识库名称上限 */
const MAX_NAME_LENGTH = 100

export async function GET() {
  try {
    const userId = await getCurrentUserId()
    const bases = await KnowledgeRepository.findBasesByUserId(userId)

    return NextResponse.json({
      knowledgeBases: bases.map((base) => ({
        id: base.id,
        name: base.name,
        description: base.description,
        documentCount: base._count.documents,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      })),
    })
  } catch (error) {
    console.error('[Knowledge GET] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '获取知识库失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const userId = await getCurrentUserId()

    const body = (await req.json()) as { name?: string; description?: string }
    const name = body.name?.trim()

    if (!name) {
      return NextResponse.json({ error: '缺少 name 参数' }, { status: 400 })
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `名称过长，上限 ${MAX_NAME_LENGTH} 字符` },
        { status: 400 }
      )
    }

    const base = await KnowledgeRepository.createBase(
      userId,
      name,
      body.description?.trim() || undefined
    )

    await audit({
      userId,
      action: 'knowledge.create',
      resourceId: base.id,
      metadata: { name: base.name },
      request: req,
    })

    return NextResponse.json({
      knowledgeBase: {
        id: base.id,
        name: base.name,
        description: base.description,
        documentCount: 0,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      },
    })
  } catch (error) {
    console.error('[Knowledge POST] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '创建知识库失败' }, { status: 500 })
  }
}

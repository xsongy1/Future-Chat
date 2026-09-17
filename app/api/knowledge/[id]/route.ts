/**
 * 单个知识库 API
 *
 * GET    /api/knowledge/[id] - 知识库详情（含文档列表）
 * DELETE /api/knowledge/[id] - 删除知识库（级联删除文档与向量 chunk）
 */

import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/server/auth/utils'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { audit } from '@/server/middleware/audit'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const base = await KnowledgeRepository.findBaseById(id, userId)
    if (!base) {
      // 不存在与无权访问返回同一结果，不泄露资源存在性
      return NextResponse.json(
        { error: '知识库不存在或无权访问' },
        { status: 404 }
      )
    }

    const documents = await KnowledgeRepository.findDocumentsByBaseId(id, userId)

    return NextResponse.json({
      knowledgeBase: {
        id: base.id,
        name: base.name,
        description: base.description,
        createdAt: base.createdAt,
        updatedAt: base.updatedAt,
      },
      documents: documents ?? [],
    })
  } catch (error) {
    console.error('[Knowledge GET id] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '获取知识库详情失败' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const deleted = await KnowledgeRepository.deleteBase(id, userId)
    if (!deleted) {
      return NextResponse.json(
        { error: '知识库不存在或无权访问' },
        { status: 404 }
      )
    }

    await audit({
      userId,
      action: 'knowledge.delete',
      resourceId: id,
      request: req,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Knowledge DELETE] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '删除知识库失败' }, { status: 500 })
  }
}

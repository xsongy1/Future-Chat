/**
 * 知识库文档 API
 *
 * POST   /api/knowledge/[id]/documents - 上传文档并入库（解析 → 切分 → 向量化 → 落库）
 * GET    /api/knowledge/[id]/documents - 文档列表
 * DELETE /api/knowledge/[id]/documents?documentId=xxx - 删除文档（级联删除其 chunk）
 *
 * 注意：入库是同步完成的（embedding 是外部 API 调用，无本地 CPU 计算）。
 * 当前项目没有任何后台任务/队列基建，因此这里不假造异步流水线：
 * 请求会在全部 chunk 向量化完成后才返回，大文件耗时可达数十秒。
 * 若后续要改成异步，需要新增任务表 + 轮询接口（见交付说明中的已知限制）。
 */

import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/server/auth/utils'
import { UserRepository } from '@/server/repositories/user.repository'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { ingestDocument } from '@/server/services/rag'
import { parseUploadedDocument, DocumentParseError } from '@/server/services/rag/parse'
import { audit } from '@/server/middleware/audit'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const documents = await KnowledgeRepository.findDocumentsByBaseId(id, userId)
    if (!documents) {
      return NextResponse.json(
        { error: '知识库不存在或无权访问' },
        { status: 404 }
      )
    }

    return NextResponse.json({ documents })
  } catch (error) {
    console.error('[Knowledge documents GET] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '获取文档列表失败' }, { status: 500 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    // 归属校验：先确认该知识库属于当前用户，再做任何写入
    const base = await KnowledgeRepository.findBaseById(id, userId)
    if (!base) {
      return NextResponse.json(
        { error: '知识库不存在或无权访问' },
        { status: 404 }
      )
    }

    // API Key 解析方式与 app/api/chat/route.ts 保持一致（用户自己的 Key 优先）
    const user = await UserRepository.findById(userId)
    const apiKey = user?.apiKey || process.env.SILICONFLOW_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { error: '未配置 API Key，无法对文档做向量化' },
        { status: 400 }
      )
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: '未提供文件' }, { status: 400 })
    }

    // 解析（类型/大小/空内容校验都在 parseUploadedDocument 内）
    let parsed
    try {
      parsed = await parseUploadedDocument(file)
    } catch (error) {
      if (error instanceof DocumentParseError) {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
      throw error
    }

    // 入库：切分 → 向量化 → 落库
    let result
    try {
      result = await ingestDocument({
        userId,
        knowledgeBaseId: id,
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        content: parsed.content,
        apiKey,
        signal: req.signal,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误'
      console.error('[Knowledge documents POST] 入库失败:', msg)
      // 失败原因已随 KnowledgeDocument(status=failed) 落库，详情页可见
      return NextResponse.json({ error: `文档入库失败：${msg}` }, { status: 500 })
    }

    await audit({
      userId,
      action: 'knowledge.upload',
      resourceId: id,
      metadata: {
        documentId: result.documentId,
        name: parsed.name,
        size: parsed.size,
        chunkCount: result.chunkCount,
      },
      request: req,
    })

    return NextResponse.json({
      document: {
        id: result.documentId,
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        status: 'ready',
        chunkCount: result.chunkCount,
      },
    })
  } catch (error) {
    console.error('[Knowledge documents POST] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '上传文档失败' }, { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const { searchParams } = new URL(req.url)
    const documentId = searchParams.get('documentId')
    if (!documentId) {
      return NextResponse.json({ error: '缺少 documentId 参数' }, { status: 400 })
    }

    // 级联删除 chunk（schema 中 onDelete: Cascade），并以 document.knowledgeBase.userId 做归属校验
    const deleted = await KnowledgeRepository.deleteDocument(documentId, userId)
    if (!deleted) {
      return NextResponse.json(
        { error: '文档不存在或无权访问' },
        { status: 404 }
      )
    }

    await audit({
      userId,
      action: 'knowledge.delete',
      resourceId: id,
      metadata: { documentId },
      request: req,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Knowledge documents DELETE] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '删除文档失败' }, { status: 500 })
  }
}

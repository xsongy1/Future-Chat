/**
 * 知识库文档 API
 *
 * POST   /api/knowledge/[id]/documents - 上传文档并入队（解析 → 入队 → worker 异步入库）
 * GET    /api/knowledge/[id]/documents - 文档列表（含入库进度）
 * DELETE /api/knowledge/[id]/documents?documentId=xxx - 删除文档（级联删除其 chunk）
 *
 * ## 为什么 POST 不再同步入库
 * 原实现要在请求里等完全部 chunk 的 embedding 才响应，大文件会卡几十秒，
 * 期间任何一个环节超时（网关、Serverless 最大执行时间、用户关页面）都会留下
 * 半成品数据。现在接口只做三件事：解析、落一条 pending 文档、入队，然后立刻返回 202；
 * 切分/向量化/建索引由 worker 执行（见 server/services/rag/worker.ts），
 * 前端通过 GET 轮询 status 与 processedChunks 看进度。
 *
 * 内容相同的文件（同知识库内 sha256 一致）不会重复入库：
 * 已经在库里的直接返回原文档并标记 deduplicated，重传则复用同一条记录重新入队
 * ——注意 (knowledgeBaseId, contentHash) 上有唯一索引，物理上也不允许存两份。
 */

import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/server/auth/utils'
import { UserRepository } from '@/server/repositories/user.repository'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { RagTaskRepository } from '@/server/repositories/rag-task.repository'
import { normalizeContent, sha256 } from '@/server/services/rag/embedding'
import { kickRagWorker } from '@/server/services/rag/worker'
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

    // 顺带把 worker 踢一下：前端轮询进度时队列一定是活的，
    // 这样进程重启后也能靠一次普通的列表请求把排队的任务续上
    kickRagWorker()

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

    // 提前校验 Key 是否存在：worker 执行时还会再取一次（用户可能中途更换），
    // 但这里先失败能让用户立刻看到"没配 Key"，而不是上传后等任务失败
    const user = await UserRepository.findById(userId)
    const hasApiKey = Boolean(user?.apiKey || process.env.SILICONFLOW_API_KEY)
    if (!hasApiKey) {
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

    const force = new URL(req.url).searchParams.get('force') === '1'

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

    const contentHash = sha256(normalizeContent(parsed.content))

    // 去重：同一知识库内内容一致的文件只保留一条记录
    const existing = await KnowledgeRepository.findDocumentByContentHash(id, contentHash)

    if (existing && !force) {
      if (existing.status === 'ready') {
        return NextResponse.json({
          document: existing,
          deduplicated: true,
          queued: false,
          message: '内容相同的文档已存在，未重复入库',
        })
      }

      if (existing.status === 'pending' || existing.status === 'processing') {
        return NextResponse.json(
          {
            document: existing,
            deduplicated: true,
            queued: true,
            message: '内容相同的文档正在入库中',
          },
          { status: 202 }
        )
      }

      // failed：复用同一条记录重新排队（唯一索引不允许再建一条同哈希的记录）
      const retried = await requeueDocument({
        documentId: existing.id,
        userId,
        knowledgeBaseId: id,
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        content: parsed.content,
        contentHash,
      })

      return NextResponse.json({ ...retried, deduplicated: true }, { status: 202 })
    }

    // force=1：已存在则复用记录重新入库（等价于"重新向量化这份文件"）
    if (existing && force) {
      const requeued = await requeueDocument({
        documentId: existing.id,
        userId,
        knowledgeBaseId: id,
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        content: parsed.content,
        contentHash,
      })

      return NextResponse.json({ ...requeued, deduplicated: true, forced: true }, { status: 202 })
    }

    let document
    try {
      document = await KnowledgeRepository.createDocument({
        knowledgeBaseId: id,
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        status: 'pending',
        chunkCount: 0,
        contentHash,
      })
    } catch (error) {
      // 并发上传同一份文件时唯一索引会拦住后到的那条：把它当成去重命中，
      // 而不是返回 500（用户视角就是"我在传两次同一个文件"）
      if (isUniqueViolation(error)) {
        const raced = await KnowledgeRepository.findDocumentByContentHash(id, contentHash)
        if (raced) {
          return NextResponse.json(
            { document: raced, deduplicated: true, queued: raced.status !== 'ready' },
            { status: 202 }
          )
        }
      }
      throw error
    }

    const task = await RagTaskRepository.enqueue({
      type: 'ingest',
      userId,
      knowledgeBaseId: id,
      documentId: document.id,
      payload: {
        name: parsed.name,
        type: parsed.type,
        size: parsed.size,
        content: parsed.content,
        contentHash,
      },
      // 交互式上传优先于批量重建：用户正等着结果
      priority: 10,
    })

    // 踢一脚，省掉一个轮询周期；失败不影响任务（轮询会捡起来）
    kickRagWorker()

    await audit({
      userId,
      action: 'knowledge.upload',
      resourceId: id,
      metadata: {
        documentId: document.id,
        taskId: task.id,
        name: parsed.name,
        size: parsed.size,
      },
      request: req,
    })

    return NextResponse.json(
      {
        document,
        taskId: task.id,
        queued: true,
        message: '文档已入队，正在后台向量化',
      },
      { status: 202 }
    )
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

/**
 * 把已有文档重新排队入库（重传 / force 重新向量化）
 *
 * 复用同一条文档记录而不是新建：contentHash 上有唯一索引，
 * 同知识库内第二条同哈希记录根本插不进去。
 */
async function requeueDocument(params: {
  documentId: string
  userId: string
  knowledgeBaseId: string
  name: string
  type: 'txt' | 'md'
  size: number
  content: string
  contentHash: string
}) {
  await KnowledgeRepository.updateDocumentProgress(params.documentId, {
    status: 'pending',
  })
  await KnowledgeRepository.clearDocumentError(params.documentId)

  const task = await RagTaskRepository.enqueue({
    type: 'ingest',
    userId: params.userId,
    knowledgeBaseId: params.knowledgeBaseId,
    documentId: params.documentId,
    payload: {
      name: params.name,
      type: params.type,
      size: params.size,
      content: params.content,
      contentHash: params.contentHash,
    },
    priority: 10,
  })

  kickRagWorker()

  const document = await KnowledgeRepository.findDocumentById(
    params.documentId,
    params.userId
  )

  return { document, taskId: task.id, queued: true }
}

/** Prisma 唯一约束冲突（P2002） */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

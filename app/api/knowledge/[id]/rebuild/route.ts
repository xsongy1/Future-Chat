/**
 * 知识库向量重建 API（换 embedding 模型后的灰度重建）
 *
 * POST /api/knowledge/[id]/rebuild - 把该知识库里仍是旧模型的 chunk 重新向量化
 * GET  /api/knowledge/[id]/rebuild - 查看该知识库的模型分布与重建进度
 *
 * ## 为什么需要灰度重建
 * 换 embedding 模型（EMBEDDING_MODEL）后，库里已有向量是用旧模型算的，
 * 直接拿新模型的 query 向量去比对旧向量，分数没有意义（维度相同也不代表语义空间相同）。
 * 两条错误做法：
 *   - 直接全量重新入库：大库要跑很久，"重建期间检索完全不可用"
 *   - 不重建硬查：检索结果静默变差，且没有任何报错
 * 这里的做法是灰度：
 *   - 以文档为单位、以 batchSize 为批大小逐步重建，随时可中断、可续跑
 *   - 检索侧按 embeddingModel 分区查询，新旧向量各自与同模型的 query 向量比对
 *     （见 server/services/rag/index.ts 的灰度双模型查询），因此重建期间检索始终可用
 *   - 全部重建完成后，检索自动回到单模型单次查询，不残留额外开销
 */

import { NextResponse } from 'next/server'
import { getCurrentUserId } from '@/server/auth/utils'
import { KnowledgeRepository } from '@/server/repositories/knowledge.repository'
import { RagTaskRepository } from '@/server/repositories/rag-task.repository'
import { resolveEmbeddingModelId } from '@/server/services/rag/embedding'
import { kickRagWorker } from '@/server/services/rag/worker'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const base = await KnowledgeRepository.findBaseById(id, userId)
    if (!base) {
      return NextResponse.json({ error: '知识库不存在或无权访问' }, { status: 404 })
    }

    const activeModel = resolveEmbeddingModelId()
    const distribution = await KnowledgeRepository.countChunksByModelForBase(id)
    const models = distribution.map((row) => ({
      model: row.embeddingModel,
      dim: row.embeddingDim,
      chunks: row._count._all,
    }))
    const staleChunks = models
      .filter((row) => row.model !== activeModel)
      .reduce((sum, row) => sum + row.chunks, 0)

    const pendingDocuments = await KnowledgeRepository.findDocumentIdsNeedingRebuild(
      id,
      activeModel,
      10
    )

    return NextResponse.json({
      activeModel,
      models,
      staleChunks,
      /** 仍需重建的文档（最多展示 10 个） */
      pendingDocuments,
      queue: await RagTaskRepository.stats(),
    })
  } catch (error) {
    console.error('[Knowledge rebuild GET] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '查询重建状态失败' }, { status: 500 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await getCurrentUserId()
    const { id } = await params

    const base = await KnowledgeRepository.findBaseById(id, userId)
    if (!base) {
      return NextResponse.json({ error: '知识库不存在或无权访问' }, { status: 404 })
    }

    // body 可选：不带参数就是"把这库里所有旧模型片段都重建到当前模型"
    let body: {
      documentId?: string
      targetModel?: string
      limit?: number
      batchSize?: number
      maxChunks?: number
    } = {}
    try {
      const text = await req.text()
      if (text.trim()) body = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
    }

    let targetModel: string
    try {
      targetModel = body.targetModel ?? resolveEmbeddingModelId()
    } catch (error) {
      const msg = error instanceof Error ? error.message : '未知错误'
      return NextResponse.json({ error: msg }, { status: 400 })
    }

    if (body.documentId) {
      const document = await KnowledgeRepository.findDocumentById(body.documentId, userId)
      if (!document || document.knowledgeBaseId !== id) {
        return NextResponse.json({ error: '文档不存在或不属于该知识库' }, { status: 404 })
      }
    }

    const targets = body.documentId
      ? [{ documentId: body.documentId, count: 0 }]
      : await KnowledgeRepository.findDocumentIdsNeedingRebuild(
          id,
          targetModel,
          body.limit && body.limit > 0 ? body.limit : 0
        )

    if (targets.length === 0) {
      return NextResponse.json({
        queued: 0,
        targetModel,
        message: '该知识库没有需要重建的片段（全部已是目标模型）',
      })
    }

    const tasks = []
    for (const target of targets) {
      tasks.push(
        await RagTaskRepository.enqueue({
          type: 'rebuild',
          userId,
          knowledgeBaseId: id,
          documentId: target.documentId,
          payload: {
            documentId: target.documentId,
            targetModel,
            ...(body.batchSize ? { batchSize: body.batchSize } : {}),
            ...(body.maxChunks ? { maxChunks: body.maxChunks } : {}),
          },
          // 重建是后台批量工作，优先级低于用户正在等待的上传任务
          priority: 0,
        })
      )
    }

    kickRagWorker()

    console.log(
      `[RAG] 已排入 ${tasks.length} 个重建任务（知识库 ${id} → ${targetModel}）`
    )

    return NextResponse.json(
      {
        queued: tasks.length,
        targetModel,
        taskIds: tasks.map((t) => t.id),
        staleChunks: targets.reduce((sum, t) => sum + t.count, 0),
        message: '重建任务已入队；重建期间新旧模型的片段都会参与检索',
      },
      { status: 202 }
    )
  } catch (error) {
    console.error('[Knowledge rebuild POST] Error:', error)
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: '创建重建任务失败' }, { status: 500 })
  }
}

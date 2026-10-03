/**
 * Knowledge API Service
 *
 * 知识库相关的 API 调用封装，对应后端真实存在的路由：
 *   GET    /api/knowledge                         列表
 *   POST   /api/knowledge                         创建
 *   GET    /api/knowledge/[id]                    详情（含文档列表）
 *   DELETE /api/knowledge/[id]                    删除（级联删文档与 chunk）
 *   POST   /api/knowledge/[id]/documents          上传文档（解析→切分→向量化→落库）
 *   GET    /api/knowledge/[id]/documents          文档列表
 *   DELETE /api/knowledge/[id]/documents?documentId=  删除文档
 *
 * 鉴权完全依赖浏览器 Cookie（服务端 getCurrentUserId），前端不传任何 userId。
 */

/** 服务端返回的知识库摘要（字段与 app/api/knowledge/route.ts 的返回一致） */
export interface KnowledgeBaseSummary {
  id: string
  name: string
  description: string | null
  documentCount: number
  createdAt: string
  updatedAt: string
}

/** 服务端返回的文档摘要（字段与 KnowledgeDocument 模型一致，去掉无关字段） */
export interface KnowledgeDocumentSummary {
  id: string
  knowledgeBaseId: string
  name: string
  type: string
  size: number
  /** pending | processing | ready | failed */
  status: string
  error: string | null
  chunkCount: number
  /** 已向量化完成的片段数（异步入库的进度，配合 chunkCount 显示） */
  processedChunks?: number
  createdAt: string
}

/** 上传结果：入队与"内容相同未重复入库"区分开，UI 文案才不至于撒谎 */
export interface UploadDocumentResult {
  document: KnowledgeDocumentSummary
  /** 是否命中了内容哈希去重（后端未重新入库） */
  deduplicated: boolean
  /** 是否已入队等待后台向量化（ready 的文档为 false） */
  queued: boolean
}

/** 解析服务端 { error: '...' } 响应，拿不到就给个兜底文案 */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    return data.error || fallback
  } catch {
    return fallback
  }
}

export const KnowledgeAPI = {
  /** 当前登录用户的知识库列表 */
  async list(): Promise<KnowledgeBaseSummary[]> {
    const res = await fetch('/api/knowledge', { method: 'GET' })
    if (!res.ok) throw new Error(await readError(res, '获取知识库列表失败'))
    const data = (await res.json()) as { knowledgeBases?: KnowledgeBaseSummary[] }
    return data.knowledgeBases ?? []
  },

  /** 创建知识库 */
  async create(name: string, description?: string): Promise<KnowledgeBaseSummary> {
    const res = await fetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    })
    if (!res.ok) throw new Error(await readError(res, '创建知识库失败'))
    const data = (await res.json()) as { knowledgeBase: KnowledgeBaseSummary }
    return data.knowledgeBase
  },

  /** 删除知识库（后端 deleteMany + schema onDelete: Cascade，文档与 chunk 一并删除） */
  async remove(id: string): Promise<void> {
    const res = await fetch(`/api/knowledge/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(await readError(res, '删除知识库失败'))
  },

  /** 某个知识库下的文档列表 */
  async listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocumentSummary[]> {
    const res = await fetch(`/api/knowledge/${knowledgeBaseId}/documents`, { method: 'GET' })
    if (!res.ok) throw new Error(await readError(res, '获取文档列表失败'))
    const data = (await res.json()) as { documents?: KnowledgeDocumentSummary[] }
    return data.documents ?? []
  },

  /**
   * 上传文档并入队
   *
   * 后端是【异步】处理：接口只做解析与入队，返回 `202` + `status=pending`，
   * 真正的切分 / 向量化 / 建索引由后台 worker 执行（见 server/services/rag/worker.ts）。
   * 所以"上传成功"不等于"可以检索"，调用方必须轮询 listDocuments 直到
   * status 变成 ready / failed —— 见 waitForDocument。
   *
   * 格式限制与 server/services/rag/parse.ts 保持一致：仅 .txt / .md，单文件 ≤ 1MB。
   */
  async uploadDocument(
    knowledgeBaseId: string,
    file: File
  ): Promise<UploadDocumentResult> {
    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(`/api/knowledge/${knowledgeBaseId}/documents`, {
      method: 'POST',
      body: formData,
    })
    // 202 = 已入队；200 = 命中去重（返回已存在的文档）
    if (!res.ok && res.status !== 202) {
      throw new Error(await readError(res, '文档上传失败'))
    }

    const data = (await res.json()) as {
      document: KnowledgeDocumentSummary
      deduplicated?: boolean
      queued?: boolean
    }

    return {
      document: data.document,
      deduplicated: data.deduplicated ?? false,
      queued: data.queued ?? false,
    }
  },

  /**
   * 轮询等待某个文档完成异步入库
   *
   * @param options.onProgress - 每次拿到最新状态时回调（UI 用它显示"入库中 3/12"）
   * @returns 终态文档（ready 或 failed）；超时返回最后一次看到的状态
   */
  async waitForDocument(
    knowledgeBaseId: string,
    documentId: string,
    options: {
      timeoutMs?: number
      intervalMs?: number
      onProgress?: (doc: KnowledgeDocumentSummary) => void
    } = {}
  ): Promise<KnowledgeDocumentSummary | null> {
    const timeoutMs = options.timeoutMs ?? 180_000
    const intervalMs = options.intervalMs ?? 1500
    const deadline = Date.now() + timeoutMs

    let latest: KnowledgeDocumentSummary | null = null

    while (Date.now() < deadline) {
      const documents = await this.listDocuments(knowledgeBaseId)
      latest = documents.find((doc) => doc.id === documentId) ?? null

      if (latest) {
        options.onProgress?.(latest)
        if (latest.status === 'ready' || latest.status === 'failed') return latest
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    return latest
  },

  /** 删除单个文档（其 chunk 由数据库级联删除） */
  async removeDocument(knowledgeBaseId: string, documentId: string): Promise<void> {
    const res = await fetch(
      `/api/knowledge/${knowledgeBaseId}/documents?documentId=${encodeURIComponent(documentId)}`,
      { method: 'DELETE' }
    )
    if (!res.ok) throw new Error(await readError(res, '删除文档失败'))
  },
}

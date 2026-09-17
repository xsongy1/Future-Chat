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
  status: string
  error: string | null
  chunkCount: number
  createdAt: string
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
   * 上传文档并入库
   *
   * 后端是【同步】处理：请求返回时已经完成解析、切分、向量化与落库，
   * 所以前端只需要一个"上传中"状态，不需要轮询进度。
   * 格式限制与 server/services/rag/parse.ts 保持一致：仅 .txt / .md，单文件 ≤ 1MB。
   */
  async uploadDocument(
    knowledgeBaseId: string,
    file: File
  ): Promise<KnowledgeDocumentSummary> {
    const formData = new FormData()
    formData.append('file', file)

    const res = await fetch(`/api/knowledge/${knowledgeBaseId}/documents`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) throw new Error(await readError(res, '文档上传失败'))
    const data = (await res.json()) as { document: KnowledgeDocumentSummary }
    return data.document
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

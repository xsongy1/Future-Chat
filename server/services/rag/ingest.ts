/**
 * RAG 入库（切分 → 向量化 → 落库 → 建词法索引）
 *
 * 这个函数是"任务体"：既被 worker 在后台调用（正常路径），也保留了直接调用的能力
 * （测试、脚本、以及未来可能的同步小文档路径）。上传接口不再直接调它——
 * 接口只负责落一条 pending 文档并入队（见 app/api/knowledge/[id]/documents/route.ts）。
 *
 * 分三步写入，每一步失败都能留下可解释的状态：
 *   1. 切分与向量化（外部 API，最可能失败）—— 失败落 status=failed + 原因
 *   2. 文档 + chunk 原子写入（一个事务，避免 ready 却 0 chunk 的孤儿文档）
 *   3. tsv / embeddingVec 补写（Prisma 不支持这两个类型，只能走 $executeRaw）
 */

import { chunkText, type Chunk } from './chunker'
import { embedTexts, normalizeContent, sha256 } from './embedding'
import { toLexemeText, tokenize } from './tokenizer'
import {
  KnowledgeRepository,
  toVectorLiteral,
} from '@/server/repositories/knowledge.repository'
import { detectVectorCapability, isVectorColumnCompatible } from './vector-store'

/** 单次入库的文档最大 chunk 数（防止超大文件把库和上下文打爆） */
export const MAX_CHUNKS_PER_DOCUMENT = 500

export interface IngestParams {
  userId: string
  knowledgeBaseId: string
  name: string
  type: 'txt' | 'md'
  size: number
  /** 已解析出的纯文本 */
  content: string
  /** 调用 embedding 的 API Key（复用聊天用的 SiliconFlow Key） */
  apiKey: string
  signal?: AbortSignal
  /**
   * 已存在的文档 id（异步入库时接口先建了 pending 记录）
   * 传入则复用该记录并清空其旧 chunk，不传则新建文档。
   */
  documentId?: string
  /** 正文哈希（接口入队前已算过，避免重复计算） */
  contentHash?: string
  /** 每批向量化完成后的进度回调 */
  onProgress?: (progress: { processed: number; total: number }) => void | Promise<void>
  /**
   * 失败时不写 status=failed，交给调用方决定
   *
   * worker 用它把"失败状态"推迟到重试耗尽之后：任务还有重试次数时先标 failed，
   * 用户会看到"失败 → 重试中 → 成功"来回跳，反而怀疑数据没进去。
   * 直接调用（脚本/测试）保留默认行为，失败原因一定要落库。
   */
  deferFailure?: boolean
}

export interface IngestResult {
  documentId: string
  chunkCount: number
  embeddingModel: string
  embeddingDim: number
  /** 命中 embedding 缓存的 chunk 数（省下的 API 调用） */
  cacheHits: number
  /** 真正调用 API 向量化的 chunk 数 */
  embeddedCount: number
}

/**
 * 落一条失败文档（保留失败原因，让用户在知识库里看得到为什么没入库）
 */
async function recordFailure(
  params: Pick<IngestParams, 'documentId' | 'knowledgeBaseId' | 'name' | 'type' | 'size' | 'contentHash'> & {
    deferFailure?: boolean
  },
  message: string
): Promise<void> {
  if (params.deferFailure) return

  if (params.documentId) {
    await KnowledgeRepository.markDocumentFailed(params.documentId, message)
    return
  }

  await KnowledgeRepository.createDocument({
    knowledgeBaseId: params.knowledgeBaseId,
    name: params.name,
    type: params.type,
    size: params.size,
    status: 'failed',
    error: message,
    chunkCount: 0,
    contentHash: params.contentHash ?? null,
  })
}

/**
 * 文档入库：切分 → 向量化 → 落库
 */
export async function ingestDocument(params: IngestParams): Promise<IngestResult> {
  const { knowledgeBaseId, name, type, size, content, apiKey, signal } = params

  // 规范化后取哈希：与 chunker 的规范化规则一致，保证同一份文件重传时哈希稳定
  const normalized = normalizeContent(content)
  const contentHash = params.contentHash ?? sha256(normalized)

  const chunks: Chunk[] = chunkText(normalized)

  if (chunks.length === 0) {
    const msg = '文档内容为空，未解析到可入库文本'
    await recordFailure(params, msg)
    throw new Error(msg)
  }

  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    const msg = `文档切分后得到 ${chunks.length} 个片段，超过单文档上限 ${MAX_CHUNKS_PER_DOCUMENT}，请拆分后上传`
    await recordFailure(params, msg)
    throw new Error(msg)
  }

  // 向量化（带 embedding 缓存）
  let embedded
  try {
    embedded = await embedTexts({
      apiKey,
      texts: chunks.map((c) => c.content),
      signal,
      onProgress: params.onProgress
        ? (done, total) => params.onProgress?.({ processed: done, total })
        : undefined,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : '未知错误'
    await recordFailure(params, `文本向量化失败：${msg}`)
    throw new Error(`文本向量化失败：${msg}`)
  }

  // pgvector 列是定长 vector(1024)，只有维度匹配且扩展可用时才写
  const capability = await detectVectorCapability()
  const writeVector = capability.available && isVectorColumnCompatible(embedded.dim)

  const chunkRows = chunks.map((chunk, i) => ({
    index: chunk.index,
    content: chunk.content,
    embedding: embedded.embeddings[i],
    contentHash: sha256(chunk.content),
    embeddingModel: embedded.model,
    embeddingDim: embedded.dim,
    tokenCount: tokenize(chunk.content).length,
  }))

  const documentData = {
    knowledgeBaseId,
    name,
    type,
    size,
    status: 'ready',
    error: null,
    chunkCount: chunks.length,
    processedChunks: chunks.length,
    contentHash,
    embeddingModel: embedded.model,
    embeddingDim: embedded.dim,
  }

  // 覆写已有文档时先清空旧 chunk（重建场景）：与写入放在同一事务里，
  // 否则中途失败会留下"旧 chunk 被删、新 chunk 没写"的空文档
  const document = params.documentId
    ? await KnowledgeRepository.replaceDocumentChunks(
        params.documentId,
        documentData,
        chunkRows
      )
    : await KnowledgeRepository.createDocumentWithChunks(documentData, chunkRows)

  // 补写 tsv / embeddingVec（Prisma 不支持这两个类型）
  // 按 chunk.index 建映射而不是按下标取数组：序号与数组位置虽然在当前实现下一致，
  // 但一旦切分策略改成非连续序号，按下标取会静默写错向量。
  const vectorByChunkIndex = new Map(
    chunkRows.map((row) => [row.index, toVectorLiteral(row.embedding)])
  )
  const created = await KnowledgeRepository.findChunksForIndexWrite(document.id)
  await KnowledgeRepository.writeChunkIndex(
    created.map((row) => ({
      id: row.id,
      lexemeText: toLexemeText(row.content),
      vectorLiteral: writeVector ? (vectorByChunkIndex.get(row.index) ?? null) : null,
    })),
    { writeVector }
  )

  // 让知识库列表按最近活跃排序（@updatedAt 只在知识库自身被 update 时刷新）
  await KnowledgeRepository.touchBase(knowledgeBaseId, params.userId)

  console.log(
    `[RAG] 文档入库完成: ${name} → ${chunks.length} 个片段 ` +
      `(${embedded.model}, ${embedded.dim} 维, 缓存命中 ${embedded.cacheHits}/${chunks.length}` +
      `${writeVector ? ', pgvector 已写入' : ', 未写 pgvector 列'})`
  )

  return {
    documentId: document.id,
    chunkCount: chunks.length,
    embeddingModel: embedded.model,
    embeddingDim: embedded.dim,
    cacheHits: embedded.cacheHits,
    embeddedCount: embedded.embeddedCount,
  }
}

-- RAG 混合检索：pgvector 向量列 + HNSW 索引、BM25 词项列、异步入库任务队列、
-- 内容哈希去重与 embedding 缓存。
--
-- 两个刻意的取舍写在这里，避免以后被"优化"掉：
--
-- 1. embedding 同时保留 Float[] 与 vector(1024) 两份。
--    不是冗余：Prisma 不支持 vector 类型，$queryRaw 才能读写 embeddingVec；
--    而 Float[] 是应用层回退路径（库上没有 pgvector 时）唯一的向量来源，
--    也是灰度重建期间旧模型 chunk 的向量来源。只留一份会让"没有 pgvector 就完全不可用"。
--
-- 2. CREATE EXTENSION 与依赖它的列/索引放在 DO 块里做能力探测。
--    目标库没有 pgvector（例如未装扩展的托管实例）时，迁移本身仍然成功，
--    应用会自动回退到分页精确扫描（见 server/services/rag/vector-store.ts），
--    而不是让整个部署因为一条 CREATE EXTENSION 卡死。
--    HNSW 索引无法在 Prisma schema 里表达（Prisma 只认 btree/hash/gin/gist/spgist/brin），
--    因此它只存在于这里；若今后执行 prisma migrate dev，diff 可能生成 DROP INDEX，
--    用 `pnpm rag:indexes` 可以重新补上（见 scripts/rag-indexes.ts）。

-- CreateExtension（能力探测）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector 不可用：跳过 embeddingVec 列与 HNSW 索引，检索将回退到应用层精确扫描';
  END IF;
END
$$;

-- AlterTable: KnowledgeDocument（异步入库状态 + 去重哈希 + 模型/维度 + 进度）
ALTER TABLE "KnowledgeDocument"
  ADD COLUMN IF NOT EXISTS "processedChunks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingDim" INTEGER;

-- 入库改为任务队列后，文档先以 pending 落库再入队；
-- 默认值必须从 ready 改掉，否则接口一返回就"看起来入库成功"。
ALTER TABLE "KnowledgeDocument" ALTER COLUMN "status" SET DEFAULT 'pending';

-- AlterTable: DocumentChunk（chunk 级模型/维度、内容哈希、BM25 词项与长度）
ALTER TABLE "DocumentChunk"
  ADD COLUMN IF NOT EXISTS "contentHash" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
  ADD COLUMN IF NOT EXISTS "embeddingDim" INTEGER,
  ADD COLUMN IF NOT EXISTS "tokenCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tsv" tsvector;

-- CreateTable: RagTask
CREATE TABLE IF NOT EXISTS "RagTask" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "userId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT,
    "documentId" TEXT,
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "workerId" TEXT,
    "lockedAt" TIMESTAMP(3),
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable: EmbeddingCache
CREATE TABLE IF NOT EXISTS "EmbeddingCache" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "hits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbeddingCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeDocument_knowledgeBaseId_contentHash_key" ON "KnowledgeDocument"("knowledgeBaseId", "contentHash");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_status_idx" ON "KnowledgeDocument"("status");

CREATE INDEX IF NOT EXISTS "DocumentChunk_contentHash_idx" ON "DocumentChunk"("contentHash");
CREATE INDEX IF NOT EXISTS "DocumentChunk_embeddingModel_idx" ON "DocumentChunk"("embeddingModel");

-- BM25 的倒排入口：tsv 上的 GIN 索引让 `tsv @@ to_tsquery(...)` 走索引而不是全表扫描
CREATE INDEX IF NOT EXISTS "DocumentChunk_tsv_idx" ON "DocumentChunk" USING GIN ("tsv");

CREATE UNIQUE INDEX IF NOT EXISTS "EmbeddingCache_contentHash_model_key" ON "EmbeddingCache"("contentHash", "model");
CREATE INDEX IF NOT EXISTS "EmbeddingCache_lastUsedAt_idx" ON "EmbeddingCache"("lastUsedAt");

CREATE INDEX IF NOT EXISTS "RagTask_status_priority_runAfter_idx" ON "RagTask"("status", "priority", "runAfter");
CREATE INDEX IF NOT EXISTS "RagTask_documentId_idx" ON "RagTask"("documentId");
CREATE INDEX IF NOT EXISTS "RagTask_knowledgeBaseId_createdAt_idx" ON "RagTask"("knowledgeBaseId", "createdAt");

-- CreateVectorIndex（能力探测：只有装了 pgvector 才有 vector 类型）
--
-- HNSW 而不是 IVFFlat：IVFFlat 需要先有数据才能训练聚类中心（空表建的索引没有意义，
-- 而且要手动 REINDEX），HNSW 可以随时增量插入，正好匹配"边入库边重建"的写入模式。
-- vector_cosine_ops 与检索用的 `<=>` 余弦距离算子配对；m=16 / ef_construction=64
-- 是 pgvector 的默认值，单机小语料下召回与建索引耗时的平衡点。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    EXECUTE 'ALTER TABLE "DocumentChunk" ADD COLUMN IF NOT EXISTS "embeddingVec" vector(1024)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS "DocumentChunk_embeddingVec_hnsw_idx" ON "DocumentChunk" USING hnsw ("embeddingVec" vector_cosine_ops) WITH (m = 16, ef_construction = 64)';
  END IF;
END
$$;

-- AddForeignKey
ALTER TABLE "RagTask" DROP CONSTRAINT IF EXISTS "RagTask_userId_fkey";
ALTER TABLE "RagTask" ADD CONSTRAINT "RagTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RagTask" DROP CONSTRAINT IF EXISTS "RagTask_knowledgeBaseId_fkey";
ALTER TABLE "RagTask" ADD CONSTRAINT "RagTask_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "KnowledgeBase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RagTask" DROP CONSTRAINT IF EXISTS "RagTask_documentId_fkey";
ALTER TABLE "RagTask" ADD CONSTRAINT "RagTask_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

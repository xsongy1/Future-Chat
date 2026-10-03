# RAG 私有知识库：检索链路与工程实现

本文记录 Future-Chat 私有知识库（`knowledge_search` 工具）的完整实现：为什么这么做、每一步的取舍、可调参数与运维命令。

对应代码：

| 关注点 | 位置 |
| --- | --- |
| 检索编排（召回 → 融合 → 精排 → 阈值） | `server/services/rag/index.ts` |
| 入库（切分 → 向量化 → 落库 → 建索引） | `server/services/rag/ingest.ts` |
| 分词（CJK 二元组 + 拉丁词） | `server/services/rag/tokenizer.ts` |
| BM25 常量、公式与取值理由 | `server/services/rag/lexical.ts`（生产实现就在 SQL 里） |
| 向量通道（pgvector / 精确扫描） | `server/services/rag/vector-store.ts` |
| RRF 融合与相对阈值 | `server/services/rag/fusion.ts` |
| cross-encoder 精排 | `server/services/rag/rerank.ts` |
| embedding 哈希 + 缓存 | `server/services/rag/embedding.ts` |
| 任务队列消费 | `server/services/rag/worker.ts` |
| 回填 / 重建 / 索引修复 | `server/services/rag/maintenance.ts` |
| SQL 与数据访问 | `server/repositories/knowledge.repository.ts`、`rag-task.repository.ts`、`embedding-cache.repository.ts` |

---

## 一、检索链路

```
query
 ├─ 向量通道 ── pgvector KNN（`<=>` 余弦距离，HNSW 索引）──┐
 │              └ 无扩展/维度不符 → 应用层分页精确扫描      ├─ RRF 融合 → cross-encoder 精排 → 相对阈值 → Top-K
 └─ 词法通道 ── BM25（CJK 二元组，GIN 索引，SQL 内算分）──┘
```

### 1.1 向量通道：相似度下推给数据库

- `DocumentChunk.embeddingVec` 是 `vector(1024)` 列，用 `ORDER BY "embeddingVec" <=> $1::vector LIMIT k` 走 HNSW 索引，相似度在数据库里算完再返回。
- Prisma 不支持 `vector` 类型，因此该列在 schema 里声明为 `Unsupported("vector(1024)")`，读写全部走 `$queryRaw` / `$executeRaw`。
- 同时保留 `DocumentChunk.embedding`（`double precision[]`）：它不是冗余，而是"没有 pgvector 的库"唯一的向量来源，也是灰度重建期旧模型向量的落点。
- 会话级参数（`hnsw.ef_search`、`hnsw.iterative_scan`）用 `SET LOCAL` 设置，并且**必须与 KNN 查询在同一个事务里**——否则 Prisma 连接池会把两条语句分到不同连接上，参数静默失效（查询结果"看起来对"，只是召回变差，极难排查）。

HNSW 是**近似**索引，两个后果必须知道：

1. 召回率由 `hnsw.ef_search` 决定（默认 100，`RAG_HNSW_EF_SEARCH` 可调）。它不是"正确性开关"，而是召回/延迟的权衡旋钮。
2. HNSW 的 `WHERE` 过滤是后置的：知识库范围、文档状态、模型这些条件下，候选可能凑不满 `LIMIT`。所以：
   - 调用方按倍数放宽候选数（`topK × 8`，下限 40）；
   - pgvector ≥ 0.8 时启用 `hnsw.iterative_scan = relaxed_order`，让索引在过滤场景下继续扫描直到凑够候选（探测到低版本会自动跳过，不会因为未知 GUC 让事务失败）。

### 1.2 词法通道：BM25 与中文分词

Postgres 默认分词器对中文会把整段当成一个词项，直接用 `to_tsvector` 等于没有索引。所以词项由我们自己的分词器生成：

- 汉字连续段 → **字符二元组**（`测试环境端口` → `测试 试环 环境 境端 端口`），单字段落退化为单字；
- 拉丁字母/数字连续段 → 整段小写化（`FC-6035` → `fc` + `6035`）；
- 其他字符一律作为分隔符。

这些词项经 `to_tsvector('simple', ...)` 写进 `DocumentChunk.tsv`（`tsvector` + GIN 索引），查询侧用同一分词器拼 `to_tsquery('simple', 'a | b | c')`。**两侧必须用同一个分词器**，否则永远匹配不上——`queryTerms()` 是唯一的词项来源，`toTsQueryInput()` 只是它的字符串形式。

BM25 打分写在 SQL 里（`KnowledgeRepository.searchChunksByLexical`），这是生产路径上唯一的实现；常量与取值理由见 `lexical.ts` 头注释：

```
score = Σ_t idf(t) · tf · (k1 + 1) / (tf + k1 · (1 − b + b · dl / avgdl))
idf(t) = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
```

> 这条公式**有数值交叉验证**：集成测试里有一份应用层 oracle，用数据库里真实的 tf / df / N / avgdl 算出期望分，
> 断言 SQL 的返回值逐位一致，并用"换一个 k1 就必须对不上"作为反向保险。
> （曾经存在过 `bm25.ts` 作为"参考实现"，但它只被自己的 24 个单测引用，真正要验证的 SQL 反而没被验证——
> 那 24 个用例全绿也说明不了线上分数是对的，所以那份实现搬进了测试，成为真正的 oracle。）

两个实现细节：

- **tf 直接从 tsvector 的 positions 取**（`cardinality(positions)` 就是词频），所以 `tsv` 一列同时承担"倒排索引"与"词频存储"，不需要额外的倒排表。
- **df 只在命中查询词的集合里统计**。看起来像"局部 df"，但因为匹配条件是查询词的 OR，任何包含某查询词的 chunk 必然出现在该集合里，所以它就是该词在检索范围内的真实 df。好处是不需要维护一张会随删除/重建漂移的全局统计表（那种表基本一定会漂）。

`idf` 里 `+1` 放在 log 内部，保证 IDF 恒非负：小知识库里"每个片段都含这个词"很常见，用经典公式会得到负 IDF，把包含该词的片段反而往下压。

### 1.3 融合：RRF 而不是加权求和

余弦相似度（0~1 的连续值）与 BM25 分（无上界、依赖语料统计）**不在同一个量纲上**，直接加权求和需要为每个语料重新标定权重。RRF 只看名次（`1/(k+rank)`，k=60），加通道不需要重新标定，单路召回失效时另一路仍能把结果顶上来。

各通道的原始分仍然保留在结果里（`vectorScore` / `lexicalScore`），便于排查"这条为什么排前面"。

### 1.4 精排与阈值：为什么删掉了绝对相似度阈值

原实现用一个标定出来的常数（余弦 0.45）过滤片段，标定记录很诚实：8 条相关查询的 Top-1 落在 0.4465~0.6320，10 条不相关查询落在 0.1970~0.4805——**两个分布重叠**。于是阈值怎么选都错：0.30 会放进 4/10 的噪声，0.50 会把实测 0.4510 的正确答案误杀（"这个知识库的负责人是谁？"就是这么被整条过滤掉的）。

这说明问题不是"阈值调得准不准"，而是**单路余弦分在小语料上分辨力不足**。现在的做法分两层：

1. **cross-encoder 精排**（`BAAI/bge-reranker-v2-m3`）把 query 与候选拼在一起逐对打分，直接解决"关键词命中但答非所问"；
2. **相对阈值**：只保留与"当前问题最好命中"差距不大的候选（`RAG_RERANK_MIN_RATIO`，默认 0.25），外加一个很低的绝对下限（`RAG_RERANK_MIN_SCORE`，默认 0.05）挡掉明显无关项。

精排是**加分项而不是依赖**：任何失败（超时、限流、返回异常、用户取消）都返回 `null` 并打中文 warn，检索沿用融合顺序继续返回结果；只有在这条兜底路径上才启用余弦绝对下限（`RAG_VECTOR_MIN_SCORE`，默认 0.35）——因为此时 RRF 只看名次，一条"排第一但显然不相关"的片段也会留在候选里。**精排生效时不使用余弦下限**，那正是"绝对阈值误杀正确答案"的老问题。

兜底路径用**名次截断**（`RAG_FUSION_TOP_N`）而不是 RRF 分的比例阈值，原因值得记一笔：RRF 分 = `Σ 1/(k+rank)`，数值被压缩在 `1/61` 附近，第 2 名与第 1 名的比值恒为 `61/62 ≈ 0.984`——也就是说任何 ≤0.98 的"比例阈值"在这条路径上等于没设（这一点是在测试里被算出来后修正的：原本默认的 0.5 实际上什么都没过滤）。名次才有稳定含义，所以默认按名次取前 N；比例阈值保留为 `RAG_FUSION_MIN_RATIO`，默认 0（不启用）。

### 1.5 灰度重建：换 embedding 模型时不中断检索

换模型后，旧向量与新 query 向量不在同一个语义空间，直接比对没有意义。以文档为单位全量重跑会让大库长时间不可用，不重建则检索静默变差。

现在的做法：

- 每个 chunk 记录 `embeddingModel` / `embeddingDim`；文档也记录一份（列表展示用）。
- 检索时按 `embeddingModel` **分区查询**：当前模型的片段走一次向量检索；若库里还有旧模型的片段（最多 `RAG_GRAY_MAX_LEGACY_MODELS`，默认 1 个，取片段最多的那个），就用旧模型**再算一次 query 向量**并单独检索，两路结果一起进 RRF。新旧向量各自只与同模型的查询向量比对，不会互相打分。
- 重建按 chunk 粒度、分批推进（`batchSize` 默认 32），中断可续跑，已换好的 chunk 不会重复向量化（省额度）。`embeddingModel` 是检索侧判断"这条是否已重建"的依据，所以它在写入顺序上放在**最后**：中途崩溃只会留下"仍被判定为旧模型"的记录，下次自然重做，而不会出现"标记为新模型但向量还是旧的"。
- 重建期间每次检索会多一次 embedding 调用；全部重建完成后自动回到单模型单次查询，不残留开销。

---

## 二、入库与去重

### 2.1 同步改异步

上传接口只做三件事：解析校验 → 落一条 `status=pending` 的文档 → 入队，然后返回 `202`。切分/向量化/建索引由 worker 执行，前端轮询 `GET /api/knowledge/{id}/documents` 看 `status` 与 `processedChunks`。

原来的同步实现要等全部 embedding 返回才响应，大文件卡几十秒，期间任何一环超时（网关、Serverless 执行上限、用户关页面）都会留下半成品记录。

状态机：`pending → processing → ready | failed`（失败原因写在 `error`，用户在知识库里看得到）。

### 2.2 内容哈希去重

- **文档级**：解析后的正文取 sha256，`(knowledgeBaseId, contentHash)` 上有唯一索引。同知识库内重传同一份文件不会产生第二条记录：已完成直接返回原记录（`deduplicated: true`），正在入库返回 202，失败则复用该记录重新入队。并发上传同一文件时，后到的那条会撞唯一索引，被当作去重命中处理而不是 500。
- **chunk 级**：`DocumentChunk.contentHash` 是 embedding 缓存的键，也是判断"这段文本是否算过"的依据。

### 2.3 embedding 缓存

`EmbeddingCache(contentHash, model)` 唯一，命中直接复用向量，不再调用 API。命中场景在这个项目里很常见：重复上传改了错别字的同一份文件、多个文档共用的模板段落/规范条文、相邻 chunk 的 100 字符重叠部分。缓存**不按用户隔离**：命中的对象是"某段文本的向量"，调用方拿不到别人的原文，向量也无法反推文本，而按用户隔离会让公共语料的命中率趋近于零。

### 2.4 任务队列

用 `RagTask` 表当队列，靠 `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` 原子领取：

- 多进程/多实例不会重复消费（不会重复付费）；进程内 worker 与 `pnpm rag:worker` 可以并存。
- `attempts` 在领取时自增（不是失败时才加）：任务执行中崩溃也不会无限重试。
- 失败按 `5s → 10s → 20s …`（上限 300s）退避重排，超过 `maxAttempts` 才置 `failed`，此时才把文档标成 `failed`——重试期间保持 `processing`，否则用户会看到"失败 → 重试中 → 成功"来回跳。
- 长任务每 15s 心跳续 `lockedAt`；`lockedAt` 超过 `RAG_WORKER_LOCK_TIMEOUT_MS`（默认 120s）没续的任务会被回收重排，避免部署重启后任务永久卡在 `running`。
- **每批向量化之间会确认"我还在为谁干活"**：心跳（`RagTaskRepository.heartbeat`）与文档进度写回
  （`KnowledgeRepository.updateDocumentProgress`）都会返回 `applied`。任一为 false 就抛
  `RagTaskAbortedError` 提前停手——用户删掉文档/知识库后任务行会被级联删除，
  继续跑只是在为一个不存在的目标付 embedding 费用。**中止不算失败**：不重试、不写失败状态
  （也写不上），只记一条日志。实测：131 个 chunk 的文档在跑完第 1 批后删库，实际只向量化了
  64 条就停手（省下约一半），日志出现"已中止…已处理 N/M 条"。
- **每批向量化完成后立刻回写 `EmbeddingCache`**（而不是等整个循环跑完）：这批向量已经付过钱了，
  攒到最后再写的话，一旦中途抛错（最典型就是上面的中止）这些向量会连同缓存一起丢掉，
  下次重传/重建还要再付一次。逐批写 + `skipDuplicates` 让中断可续、不重复付费。
- ⚠️ **生产日志里看不到 `console.log`**：`next.config.ts` 的 `removeConsole` 对**服务端代码同样生效**，
  只保留 `error` / `warn`（实测：`[RAG] 文档入库完成`、`检索完成`、`灰度期检索` 在生产构建里都被删除，
  而 `精排失败`、`不在本 worker 名下` 这类 warn 保留）。因此**运维必须看到的信息一律用 warn/error**
  （例如"入库已中止"）；常规运行日志只在 `pnpm dev` 下可见。需要生产也能看到常规日志时，
  改 `next.config.ts` 的 `removeConsole` 配置（会把客户端 console 一起放开，需权衡）。
- **为什么不引 Redis/BullMQ**：任务粒度是"一次上传/一次重建"，量级远达不到需要独立中间件的程度，而 `SKIP LOCKED` 已经提供了所需的原子领取语义，少一个有状态组件就少一套部署与运维成本。

### 2.5 worker 的启动方式（以及为什么不用 instrumentation）

1. 入队即拉起：上传/重建接口入队后立刻 kick，不等轮询周期；
2. 轮询接口保活：文档列表接口也会 kick（进程重启后，任何一次列表请求都能把排队的任务续上）；
3. 独立进程：`pnpm rag:worker`（多实例部署推荐；`RAG_WORKER_ONCE=1` 可跑空即退出，适合 cron）。

**不用 `instrumentation.ts` 自动启动**：该文件会被 Next 同时编译进 edge 层（项目里有 `middleware.ts`），而 worker 依赖 prisma / `crypto`，一旦进入 edge 的依赖图就是构建期报错（实测 `UnhandledSchemeError: node:crypto`，用 `NEXT_RUNTIME` 常量分支也摇不掉动态 import）。把 Node-only 代码藏进单独文件同样无效——打包器仍会跟随动态 import。所以改成上面三条不依赖打包器行为的路径。

---

## 三、修复记录：2000 上限导致的召回缺失

**缺陷**：早先的候选集获取是

```ts
prisma.documentChunk.findMany({ take: 2000, orderBy: { createdAt: 'desc' } })
```

先按创建时间取最新 2000 条，再在应用层算余弦相似度。chunk 总数一旦超过 2000，**只要正确答案不在"最新的 2000 条"里就永远不可能被召回**，而且失败是静默的：用户看到的是"知识库中没有相关内容"，不是报错。创建时间与相关性毫无关系，所以这不是"少召回一点"的性能取舍，而是明确的正确性缺陷。

**修复**（分两层）：

1. **pgvector 路径**（本机已启用）：相似度下推 SQL，`ORDER BY embeddingVec <=> query LIMIT k`，由索引决定候选，不存在"按时间截断"的问题。
2. **回退路径**（没有扩展 / 非 1024 维模型）：改成 keyset 分页（`id > cursor`，`ORDER BY id ASC`）**全量**扫描，用插入排序维护 O(k) 的有界 top-K。召回不再取决于语料规模，内存取决于 `batchSize` 而不是 chunk 总数。
   仍保留一个可选上限 `RAG_EXACT_SCAN_MAX_CHUNKS`（**默认不设**），设置后一旦触顶会打印警告并在 `debug.vector.truncated` 标记——即"截断必须是显式配置且可见的"，而不是默认行为。

**回归证据**（`server/services/rag/__tests__/indexing.integration.test.ts`，`RAG_DB_TEST=1` 时运行；同样的对比也用一次性脚本在真实库上跑过）：

| 场景（2401 条 chunk，答案是最早创建的那条） | 旧实现 | 现在 |
| --- | --- | --- |
| `take: 2000 + createdAt desc` 取候选 | 2000 条，**不含正确答案** | — |
| 分页精确扫描 | — | 扫描 2401 条，答案排名第 1 |
| pgvector KNN | — | 答案排名第 1（cos=1） |
| BM25（唯一字面词项） | — | 2401 条语料中答案排名第 1（并有数值交叉验证，见 §1.2） |

---

## 四、数据模型

```prisma
model KnowledgeDocument {
  status          String  @default("pending") // pending | processing | ready | failed
  processedChunks Int     @default(0)         // 进度
  contentHash     String?                     // 去重键（与 knowledgeBaseId 唯一）
  embeddingModel  String?                     // 文档级模型标记
  embeddingDim    Int?
  @@unique([knowledgeBaseId, contentHash])
}

model DocumentChunk {
  contentHash    String?
  embedding      Float[]                       // 回退路径 / 旧模型向量的来源
  embeddingModel String?                       // 灰度重建依据
  embeddingDim   Int?
  embeddingVec   Unsupported("vector(1024)")?  // pgvector 列（HNSW）
  tsv            Unsupported("tsvector")?      // BM25 词项（GIN）
  tokenCount     Int  @default(0)              // BM25 的 dl
}

model RagTask    { type status attempts runAfter lockedAt progress payload … }
model EmbeddingCache { contentHash model dim embedding hits @@unique([contentHash, model]) }
```

### 已知的迁移注意事项

> **实测结论（用 `prisma migrate diff --from-migrations ... --to-schema-datamodel ...` 跑出来的，不是推测）**：
> 当前 schema 与迁移历史之间有两处 drift，任何一次 `prisma migrate dev`（或它生成的迁移被 deploy）都会执行：
>
> ```sql
> DROP INDEX "DocumentChunk_embeddingVec_hnsw_idx";          -- ① RAG：HNSW 索引没了（向量检索退化为顺序扫描）
> ALTER TABLE "Conversation" DROP COLUMN "lastViewedAt",     -- ② 与本任务无关的既有问题：会丢数据
> DROP COLUMN "viewCount";
> ```
>
> - ① 是本任务引入的必然结果：HNSW 索引无法用 Prisma schema 表达。迁移后跑 `pnpm rag:indexes` 即可补回（`pnpm rag:status` 也会显示 HNSW 是否存在）。
> - ② 是**既有问题，不是本次改动造成的**：`20251112161305_add_pending_link_and_audit` 迁移加了 `lastViewedAt` / `viewCount` 两列，但 `Conversation` 模型里已经没有它们（代码里也没有任何引用）。`viewCount` 目前有实际数据。要避免丢列，把这两行补回 `Conversation` 模型即可：
>   ```prisma
>   lastViewedAt DateTime?
>   viewCount    Int      @default(0)
>   ```

- `DocumentChunk` 的 `embeddingVec` 与 `tsv` 是 Prisma 的 `Unsupported` 类型，**Prisma Client 无法读写、也无法用它们做 `where` 过滤**，相关过滤都必须走 `$queryRaw`（例如回填里"tsv 为空的 chunk"就是用原生 SQL 查的）。
- **HNSW 索引无法用 Prisma schema 表达**，只存在于手写迁移里。将来执行 `prisma migrate dev` 时，diff 有可能生成 `DROP INDEX "DocumentChunk_embeddingVec_hnsw_idx"`（Prisma 认为 schema 里没有这个索引）。迁移后请跑一次 `pnpm rag:indexes` 自检并补回；`pnpm rag:status` 也会显示 HNSW 是否存在。
- 迁移前的存量数据没有 `tsv` / `embeddingModel` / `embeddingVec`，它们**同时缺席两条通道**（等于查不到）。迁移后必须跑一次 `pnpm rag:backfill`：
  - `tsv` / `tokenCount` 由 JS 分词器生成（必须与查询侧同一个分词器，所以不能纯 SQL 做）；
  - `embeddingModel` 无法从向量反推，默认按当前 `EMBEDDING_MODEL` 标记；**历史上换过模型时必须显式传 `--model=`**，否则会把旧向量标成新模型，检索分数失去意义；
  - `embeddingVec` 由 SQL 侧把 `float8[]` 直接转成 `vector` 字面量，不经过 JS 搬运 1024 维向量。
- 检索会主动提示这种"未参与"的数据：`debug.degraded` 与工具返回文本里会出现"N 个片段未标注 embedding 模型…请执行 pnpm rag:backfill"，不会静默丢数据。

---

## 五、环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMBEDDING_MODEL` | 白名单默认（`BAAI/bge-m3`） | 换模型后需灰度重建 |
| `RAG_RERANK` | `1`（开） | `0`/`false`/`off` 关闭精排 |
| `RAG_RERANK_MODEL` | `BAAI/bge-reranker-v2-m3` | 白名单 `RERANK_MODELS` |
| `RAG_RERANK_TOP_N` | 候选数 | 送进精排的条数（成本/延迟闸门） |
| `RAG_RERANK_MIN_RATIO` | `0.25` | 相对最好命中的比例阈值 |
| `RAG_RERANK_MIN_SCORE` | `0.05` | 精排分绝对下限 |
| `RAG_FUSE_TOP` | `30` | 进入精排的融合候选数 |
| `RAG_FUSION_TOP_N` | `max(topK×3, 15)` | 无精排时的融合名次截断 |
| `RAG_FUSION_MIN_RATIO` | `0`（不用） | 无精排时的额外比例阈值；**默认关闭**，见下方说明 |
| `RAG_VECTOR_MIN_SCORE` | `0.35` | **仅**精排不可用时的余弦下限 |
| `RAG_MIN_SCORE` | 未设置 | 已废弃；设置后作为 `RAG_VECTOR_MIN_SCORE` 的别名 |
| `RAG_HNSW_EF_SEARCH` | `100` | HNSW 召回旋钮 |
| `RAG_HNSW_ITERATIVE_SCAN` | `relaxed_order` | pgvector ≥ 0.8；`off` 可关 |
| `RAG_VECTOR_BACKEND` | `auto` | `app` 可强制走应用层精确扫描（对照/排障） |
| `RAG_EXACT_SCAN_MAX_CHUNKS` | 无上限 | 回退路径扫描上限，触发时日志与 debug 会标记 |
| `RAG_GRAY_LEGACY_QUERY` | `1` | 灰度期是否为旧模型多查一次 |
| `RAG_GRAY_MAX_LEGACY_MODELS` | `1` | 灰度期最多为几个旧模型做查询 |
| `RAG_BM25_K1` / `RAG_BM25_B` | `1.2` / `0.75` | BM25 参数 |
| `RAG_WORKER_ENABLED` | `1` | 进程内 worker 开关 |
| `RAG_WORKER_POLL_MS` | `2000` | 轮询间隔 |
| `RAG_WORKER_LOCK_TIMEOUT_MS` | `120000` | 僵死任务回收阈值 |
| `RAG_WORKER_ONCE` | — | `1` = 跑空队列即退出 |

## 六、运维命令

```bash
pnpm rag:status            # pgvector / 索引 / chunk 统计 / 模型分布 / 队列 / 缓存 一览
pnpm rag:indexes           # 补回 HNSW、GIN 索引
pnpm rag:backfill          # 存量数据补齐（迁移后执行一次）
pnpm rag:backfill -- --model=<历史模型> --base=<knowledgeBaseId>
pnpm rag:rebuild -- --user=<userId|username> [--base=<id>] [--max-chunks=200]
pnpm rag:reindex-lexical   # 换分词策略后只重建词法索引
pnpm rag:documents -- --base=<knowledgeBaseId>   # 看每份文档的入库状态与索引情况
pnpm rag:worker            # 独立 worker 进程

# API：查看某个知识库的模型分布与待重建文档
GET  /api/knowledge/{id}/rebuild
# API：把该知识库的旧模型片段灰度重建到当前模型（可带 documentId / limit / batchSize / maxChunks）
POST /api/knowledge/{id}/rebuild
```

## 七、当前边界（诚实清单）

- **文件格式**：仍只支持 `.txt` / `.md`（≤ 1MB）。PDF/DOCX 需要新增解析依赖，未做。
- **入库载荷**：任务正文存在 `RagTask.payload`（JSONB），因此上限就是上传接口的 1MB。再大需要对象存储，当前项目没有。
- **中文分词**：二元组是"无词典"方案，对绝大多数检索场景够用，但没有词干化/同义词/停用词；`RAG_BM25_*` 可调，换分词器后需要 `pnpm rag:reindex-lexical`。
- **词项与 tsvector lexeme 的等价是硬约束**：分词器产出的 token 必须与 `to_tsvector('simple', toLexemeText(x))` 的 lexeme 逐一对应，否则会出现"应用层认为是词项、索引里根本不存在"的幽灵词（查询侧 `to_tsquery` 会把它解析成空 tsquery，而空 tsquery 匹配任何文档都为 false → 词法通道静默 0 命中）。为此有两条显式上限：`MAX_TOKENS`（8192，防超大 tsvector 与位置上限）与 `MAX_TOKEN_BYTES`（2046，实测 Postgres 会静默丢弃 ≥2047 字节的单个 lexeme）。边界行为已用真实数据库验证：2046 字节保留、2047 字节起丢弃，同段内的正常 token 不受影响，CJK bigram 固定 6 字节永不触发。
- **pgvector 列是定长 `vector(1024)`**：白名单里的模型都是 1024 维，所以够用；换成非 1024 维模型时该列不可用，会自动回退到应用层精确扫描（功能不受影响，性能退化，此时应改列定义或另开一列）。
- **HNSW 是近似的**：召回由 `ef_search` 与索引结构决定，不是精确 top-K；这是向量检索的固有取舍，靠"融合 + 精排 + 相对阈值"补足。
- **精排会计费**：每次检索多一次 `/v1/rerank` 调用（按 query-文档对计费），`RAG_FUSION`/`RAG_RERANK_TOP_N` 是成本闸门。
- **缓存无淘汰**：`EmbeddingCache` 只增不减，`lastUsedAt` 与 `hits` 已记录，但目前没有 TTL 清理任务（数据量级很小，暂不必要）。
- **前端**：知识库弹窗（`features/knowledge`）已适配异步入库——上传后立即轮询文档状态，
  把进度就地显示为"入库中 n/m"，到终态才提示"已入库 · N 个片段"或失败原因
  （`KnowledgeAPI.waitForDocument`）。注意 `pending`/`processing` 是正常中间态，不是失败。

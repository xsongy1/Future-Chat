# Future-Chat

AI 对话应用：多模型对话 + **Tool Calling**（联网搜索 / 图片生成 / **私有知识库 RAG**）+ 语音交互 + 全链路监控。

> 本文档已按当前源码逐一核对（框架版本、脚本、环境变量、接口、目录结构）。文中标注了与代码不一致的历史写法，请以本文为准。
>
> 命名说明：项目名为 **Future-Chat**；配套监控 SDK 名为 **Future-monitor-sdk**（工作区包 `packages/future-monitor-sdk`，包名 `future-monitor-sdk`）。

## 技术栈

| 项 | 实际情况 |
| --- | --- |
| 框架 | **Next.js 15.1.6**（App Router；生产构建为 `output: 'standalone'`） |
| 语言 | TypeScript 5 |
| UI | Tailwind CSS 3.4 + shadcn/ui（Radix UI 组件） |
| 状态管理 | Zustand 5（`features/*/store`） |
| 数据库 | PostgreSQL 16 + Prisma ORM 6.19 |
| 认证 | **NextAuth v4（4.24.11）**：Credentials（用户名/密码）+ Google + GitHub；另有自研 JWT（`auth-token` Cookie）作为并存方案 |
| AI 能力 | 硅基流动 SiliconFlow：对话 + Embedding + TTS/ASR |
| 联网搜索 | Tavily API |
| 监控 | Future-monitor-sdk（本仓库工作区包） |
| 流式协议 | SSE（`text/event-stream`） |

## 功能

### 对话
- 流式响应（SSE），支持中途停止
- 多模型切换：`Qwen/Qwen2.5-72B-Instruct`、`deepseek-ai/DeepSeek-V3.2`（**默认 DeepSeek-V3.2**，Function Calling 更稳定）
- 思考模式（推理过程可视化，仅支持该参数的模型显示）
- 会话管理（创建 / 删除 / 重命名 / 置顶）
- 消息操作（复制 / 朗读 / 重试 / 编辑）
- 分享链接（只读分享页）

### 工具调用（Function Calling）

| 工具 | 触发方式 | 说明 |
| --- | --- | --- |
| `knowledge_search` | 输入框「私有知识库」开关 | 检索私有知识库，可指定单个知识库或全部 |
| `web_search` | 输入框「联网搜索」开关 | Tavily 搜索，回答附带来源链接 |
| `generate_image` | 始终可用（AI 自行判断） | SiliconFlow 文生图，带进度条，可取消 |

- 多轮循环最多 5 轮（`MAX_TOOL_ROUNDS`），工具可并行执行
- **每次请求都有工具白名单**：由用户开关算出 `enabledTools`，贯穿每一轮下发，并在执行前二次校验——关闭知识库后，模型即使点名 `knowledge_search` 也会被拒绝执行
- `/api/chat/cancel-tool` 可按 `toolCallId` 取消正在执行的工具

### 私有知识库（RAG）

- 入口：聊天输入框内的「私有知识库」开关 + 旁边的知识库选择器（弹窗内可新建 / 删除知识库、上传 / 删除文档）
- 支持格式：**仅 `.txt` / `.md`，单文件 ≤ 1MB**（PDF/DOCX 未实现，无对应解析依赖）
- 入库链路（**异步任务队列**）：接口解析后立刻返回 `202 + status=pending`，后台 worker 执行 切分（目标 800 字符 / 重叠 100 字符）→ Embedding（`BAAI/bge-m3`，1024 维，带缓存）→ 落库 → 建词法索引；前端轮询 `GET /api/knowledge/{id}/documents` 看 `status` / `processedChunks`
- 检索链路（**混合检索 + 精排**）：向量召回（pgvector KNN，相似度下推 SQL、走 HNSW） + BM25 词法召回（CJK 二元组，走 GIN） → RRF 融合 → cross-encoder 精排（`BAAI/bge-reranker-v2-m3`，失败自动降级为融合顺序）→ 相对阈值（对"当前问题的最好命中"取比例，不再依赖全局绝对阈值）→ Top-5
- 向量存储：`DocumentChunk.embedding`（`double precision[]`，Prisma 可直接读写）+ `DocumentChunk.embeddingVec`（`vector(1024)`，HNSW 索引，读写走 `$queryRaw`）。**没有 pgvector 时自动回退**到分页精确扫描（keyset 分页全量扫描 + 有界 top-K，不再有 2000 条候选上限）
- 去重与缓存：同知识库内内容哈希（sha256）相同的文件不会重复入库；chunk 级内容哈希命中 `EmbeddingCache` 时不再调用 embedding API
- 权限：所有查询以服务端登录态（`getCurrentUserId`）收敛，客户端提交的 `userId` 一律不被信任；指定他人知识库只会得到「不存在或没有访问权限」
- 无结果时不伪造来源：明确返回"未检索到相关内容"，并要求模型如实告知；同时区分「库里没有文档」与「有文档但没匹配上/旧模型片段未参与检索」
- 换 embedding 模型：chunk 上记录了 `embeddingModel` / `embeddingDim`，可灰度重建（`pnpm rag:rebuild`），重建期间新旧模型的片段各自与同模型的查询向量比对，检索不中断

> 架构细节、阈值取舍、环境变量与运维命令见 [`server/services/rag/README.md`](server/services/rag/README.md)。

### 语音
- 语音输入：录音转文字（SenseVoice）
- 语音输出：文字转语音（CosyVoice2，8 种音色）
- 音色选择持久化

### 文件（对话附件）
- 上传 `.txt` / `.md`（最大 1MB），后端读取内容后拼进当前对话上下文
- 与知识库上传是两条独立链路：附件不进知识库、不做向量化

### 其他
- 深色模式、Markdown 导出、响应式布局
- Future-monitor-sdk：错误 / 性能 / 网络 / SSE 链路追踪 + Token 成本统计 + 离线队列上报；开发环境带调试面板（`future-monitor-sdk/debug`）
- 地区校验（GeoChecker）

## 环境要求

- Node.js ≥ 22.20.0
- pnpm ≥ 11.7.0（仓库固定 `packageManager: pnpm@11.7.0`）
- PostgreSQL 16（可用仓库自带 `docker-compose.yml`）

## 快速开始

```bash
pnpm install

# 生成 Prisma Client（改了 schema 之后必须执行）
pnpm db:generate

# 建表：本地开发用 migrate，快速同步用 db:push
pnpm db:migrate

# 可选：创建测试账号 admin / admin
pnpm db:seed

pnpm dev          # 开发模式 → http://localhost:3000
```

生产构建与运行：

```bash
pnpm build
pnpm start        # 注意：项目配置了 output: 'standalone'，
                  # 容器里的正式入口是 node .next/standalone/server.js
```

Docker 一键起（应用 + 数据库）：

```bash
pnpm docker:up                # 等价于 docker compose up -d
docker compose up -d --build  # 改了源码后必须带 --build，否则会复用旧镜像
pnpm docker:logs              # 跟踪 postgres 日志
pnpm docker:down
```

> ⚠️ Docker 相关注意点（真实行为，非理想状态）：
> - 应用容器跑的是**构建镜像时的源码**。`docker compose up -d`（不带 `--build`）不会重新构建，容易出现"改了代码但线上没变"。
> - postgres 镜像已从 `postgres:16-alpine` 换成 **`pgvector/pgvector:pg16`**（RAG 需要 `vector` 类型 + HNSW 索引）。镜像基于同一 PostgreSQL 16 大版本，数据卷可直接沿用；`docker compose up -d postgres` 重建容器后，用 `psql -c 'CREATE EXTENSION IF NOT EXISTS vector'`（或让 RAG 迁移里的 `DO` 块自动完成）即可。
> - 镜像里**不会自动执行 `prisma migrate deploy`**：数据卷为空时表不会被创建，需要手工 `docker compose exec app npx prisma migrate deploy`（或先在宿主迁移好再用同一数据卷）。
> - `docker-compose.yml` 里显式写了 `name: sky-chat`，用于保住既有数据卷（`sky-chat_postgres_data`）。**工作区目录已经改名为 `Future-Chat`，所以这一行现在是唯一把「新路径」和「旧数据卷」绑在一起的锚点——既不能删也不能改。** 删掉后 compose 会按目录名推断成 `future-chat`，转而去找并不存在的 `future-chat_postgres_data`，于是创建一个空卷：用户、会话、消息、RAG 文档会「看起来消失」（数据其实完好地留在旧卷里，只是没被挂载）。
> - 运行中的容器是从旧目录启动的，bind mount（`generated` 挂载点）与 `com.docker.compose.project.working_dir` 仍指向旧路径。**在 `Future-Chat` 目录下重新执行一次 `docker compose up -d` 即可修正**——因为有 `name: sky-chat`，compose 会复用既有容器与数据卷，不会丢数据。
> - 旧目录若已被删除，该挂载点会变成**死挂载**：容器里 `/app/public/generated` 根本不存在，AI 生成图片会**静默失败**（不报错，只是图没了）。核验与修复：
>   ```bash
>   # 看挂载点指向哪里（Source 应为 F:\desk\ChatAI\Future-Chat\generated）
>   docker inspect future-chat-app --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
>   # 在 Future-Chat 目录重新 up，重建容器即修正挂载
>   docker compose up -d
>   ```
>
> 真要改名，正确顺序是**先迁数据卷、再改 YAML**，而不是直接改 `name:`：
>
> ```bash
> docker compose -p sky-chat down                    # 停服务，保留数据卷
> docker volume create future-chat_postgres_data
> docker run --rm -v sky-chat_postgres_data:/from \
>                -v future-chat_postgres_data:/to alpine cp -av /from/. /to/
> # ↑ 到这里再改 docker-compose.yml 的 name: 为 future-chat
> docker compose up -d
> docker volume rm sky-chat_postgres_data            # 验证数据完好后再删旧卷
> ```

## 环境变量

仓库只提供 `.env`（`docker compose` 通过 `env_file` 读取；`.dockerignore` 已把 `.env*` 排除在镜像之外）。

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Prisma 连接串。本地默认 `postgresql://future_chat:password123@localhost:5433/future_chat` |
| `SILICONFLOW_API_KEY` | ✅ | 对话 / Embedding / 图片 / TTS / ASR；`generate_image` 与 embedding 依赖它 |
| `JWT_SECRET` | ✅ | 自研 `auth-token` JWT 签名（生产环境至少 32 字符，否则启动即报错） |
| `AUTH_SECRET` | ✅ | middleware 用 next-auth `getToken` 校验会话 |
| `AUTH_TRUST_HOST` | 建议 | NextAuth 反向代理场景 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 可选 | Google 登录 |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 可选 | GitHub 登录 |
| `TAVILY_API_KEY` | 可选 | `web_search` 工具；未配置则该工具不注册 |
| `NEXT_PUBLIC_APP_URL` | 可选 | 分享链接拼接，默认 `http://localhost:3000` |
| `RAG_MIN_SCORE` | 可选 | **已废弃**：旧的绝对余弦阈值。设置后会被当作 `RAG_VECTOR_MIN_SCORE` 处理（见 `server/services/rag/README.md`） |
| `EMBEDDING_MODEL` | 可选 | 覆盖 Embedding 模型，必须在 `shared/constants/models.ts` 白名单内 |
| `RAG_RERANK` | 可选 | 精排开关，默认开（`0`/`false`/`off` 关闭）；关闭后退化为 RRF 融合顺序 |
| `RAG_RERANK_MODEL` | 可选 | 精排模型，默认 `BAAI/bge-reranker-v2-m3`（白名单 `RERANK_MODELS`） |
| `RAG_RERANK_TOP_N` / `RAG_RERANK_MIN_RATIO` / `RAG_RERANK_MIN_SCORE` | 可选 | 精排条数上限 / 相对阈值比例（默认 0.25）/ 精排分绝对下限（默认 0.05） |
| `RAG_FUSE_TOP` / `RAG_FUSION_TOP_N` / `RAG_FUSION_MIN_RATIO` | 可选 | 进入精排的融合候选数（默认 30）/ 无精排时的名次截断（默认 `max(topK×3,15)`）/ 额外比例阈值（默认 0=不用） |
| `RAG_VECTOR_MIN_SCORE` | 可选 | 仅"精排不可用"时的余弦兜底下限（默认 0.35），精排生效时不参与判断 |
| `RAG_HNSW_EF_SEARCH` / `RAG_HNSW_ITERATIVE_SCAN` | 可选 | HNSW 召回旋钮（默认 100 / `relaxed_order`，pgvector ≥ 0.8） |
| `RAG_VECTOR_BACKEND` | 可选 | `auto`（默认）/ `pgvector` / `app`，可强制走应用层回退路径做对照 |
| `RAG_EXACT_SCAN_MAX_CHUNKS` | 可选 | 回退路径的扫描上限；**默认不设上限**（全量扫描），设置后会在日志里标记截断 |
| `RAG_GRAY_LEGACY_QUERY` / `RAG_GRAY_MAX_LEGACY_MODELS` | 可选 | 灰度重建期间是否为新旧模型各查一次（默认开 / 最多 1 个旧模型） |
| `RAG_WORKER_ENABLED` / `RAG_WORKER_POLL_MS` / `RAG_WORKER_LOCK_TIMEOUT_MS` / `RAG_WORKER_ONCE` | 可选 | 任务 worker 开关 / 轮询间隔（2000ms）/ 锁超时（120s）/ 跑空即退出 |
| `RAG_BM25_K1` / `RAG_BM25_B` | 可选 | BM25 参数，默认 1.2 / 0.75 |
| `TRUST_PROXY` | 可选 | 可信代理配置；未设置时**不启用**基于 IP 的登录限流，审计日志也不记录 IP |
| `IMAGE_STORAGE_DIR` / `IMAGE_URL_PREFIX` | 可选 | 生成图片的落盘目录与 URL 前缀 |
| `GEO_TEST_MODE` | 可选 | 设为 `block` 可模拟地区拦截 |
| `NEXT_PUBLIC_MONITOR_SAMPLE_RATE` | 可选 | 监控采样率，默认 1 |
| `ANALYZE` | 可选 | 设为 `true` 生成 bundle 分析报告 |
| `OPENAI_API_KEY` | 可选 | 仅作 SiliconFlow Key 缺失时的兜底 |

> 历史文档里出现过 `AUTH_GOOGLE_ID` / `AUTH_GITHUB_ID` / `.env.local`，**这些在当前代码中都不生效**：代码读取的是 `GOOGLE_CLIENT_ID` / `GITHUB_CLIENT_ID`，环境文件是 `.env`。
>
> 已知隐患：NextAuth v4 在 `server/auth/auth.ts` 中**没有显式配置 `secret`**（`.env` 里的 `AUTH_SECRET` 只被 middleware 使用），生产环境（`NODE_ENV=production`）可能因此启动失败，建议补上 `secret: process.env.AUTH_SECRET`。

## 脚本

```bash
pnpm dev / build / start     # 开发 / 构建 / 启动
pnpm lint                    # ESLint（next/core-web-vitals + typescript）
pnpm format / format:check   # Prettier
pnpm test                    # Vitest（服务端纯逻辑 + SDK 单测）

pnpm db:generate             # prisma generate
pnpm db:migrate              # prisma migrate dev
pnpm db:push                 # prisma db push
pnpm db:seed                 # 填充 admin/admin 测试账号
pnpm db:studio               # Prisma Studio

pnpm rag:status              # pgvector/索引/队列/缓存/模型分布 一览
pnpm rag:backfill            # 存量数据补齐 tsv / 模型标记 / embeddingVec（迁移后必须跑一次）
pnpm rag:indexes             # 补回 HNSW / GIN 索引（migrate dev 可能把 HNSW 索引 diff 掉）
pnpm rag:rebuild -- --user=admin --max-chunks=200   # 换 embedding 模型后的灰度重建
pnpm rag:reindex-lexical     # 只重建词法索引（换分词策略后用）
pnpm rag:worker              # 独立 worker 进程（多实例部署时把队列消费拆出来）

pnpm docker:up / down / logs / restart
pnpm clean:logs              # 预览待清理的 console.log
pnpm clean:logs --write      # 实际删除
```

> 历史文档中的 `pnpm db:reset` **不存在**；`pnpm test` 覆盖 `server/**/__tests__`（RAG chunker / tokenizer / BM25 / 融合 / 精排 / 检索编排）与 `packages/future-monitor-sdk/tests`，`features/**/__tests__` 尚未纳入。
> RAG 的数据库集成测试默认跳过，需要真实库时用 `RAG_DB_TEST=1 pnpm test`（会在库里建临时知识库并在结束时删除）。

## 项目结构

```
app/                          # Next.js App Router
├── api/chat/                 # 对话 SSE 入口（工具调用）、cancel-tool
├── api/knowledge/            # 知识库 / 文档 CRUD（含上传入库）
├── api/messages/ message/    # 消息增删改
├── api/auth/                 # 登录 / 注册 / OAuth 关联
├── api/upload/ speech/ tts/  # 附件解析 / 语音
├── api/monitor/ health/ geo/ # 监控上报 / 健康检查 / 地区
├── chat/[conversationId]/    # 会话页
└── share/[token]/            # 分享页

components/                   # 全局组件
├── ui/                       # shadcn/ui 基础组件
├── icons/FutureChatLogo.tsx  # 品牌 Logo
└── Sidebar / Header / LandingPage / MainLayout / Providers ...

features/                     # 按功能垂直切分
├── auth/                     # 认证（含 AuthGuard / LoginDialog）
├── chat/                     # 对话（store / services / utils / components）
├── conversation/             # 会话列表
├── knowledge/                # 知识库（services/knowledge-api.ts + 管理弹窗）
├── share/                    # 分享
└── voice/                    # 语音

lib/                          # 前端工具库（仅客户端）
├── hooks/ utils/ stores/
└── monitor/                  # 监控装配层（消费 future-monitor-sdk）

shared/                       # 中立共享层（前端与 server 均可引用）
├── constants/models.ts       # 对话模型 + Embedding 模型白名单
└── utils/sse.ts              # SSE 解析

server/                       # 服务端
├── auth/  db/  middleware/  utils/
├── repositories/             # conversation / message / user / knowledge / audit-log
└── services/
    ├── chat/                 # chat.service（工具白名单）/ stream.handler（多轮循环）/ sse-writer / prompt.builder
    ├── tools/                # ToolRegistry + web_search / generate_image / knowledge_search
    ├── rag/                  # parse / chunker / index（ingestDocument、retrieve）
    ├── ai/                   # SiliconFlow 对话与 Embedding 调用
    ├── image/  geo/  export/  conversation/

prisma/                       # schema.prisma + migrations
packages/future-monitor-sdk/  # 监控 SDK（工作区包，包名 future-monitor-sdk）
test-rag/                     # RAG 测试知识库 + 验收/回归脚本
```

## 分层规则

依赖方向（禁止反向依赖）：

- `features/ → lib/`、`features/ → shared/`
- `server/ → shared/`（仅限纯配置与纯函数）
- `app/api/ → server/ → shared/`
- 禁止 `server/` 依赖 `lib/` 与 `features/`
- 禁止 `features/` 依赖 `server/`

## RAG 自测工具（test-rag/）

```bash
node test-rag/run-tests.mjs      # 导入 3 个测试文档并跑 8 个 RAG 用例（23 项断言）
node test-rag/regression.mjs     # 全面回归（含工具开关、权限隔离、默认模型）
node test-rag/guard-check.mjs    # 定向验证「关闭知识库后工具被拒绝执行」
node --experimental-strip-types test-rag/merge-check.mjs   # 知识库来源合并逻辑单测

# 服务不在 3000 端口时（例如本地 dev 起在 3001）：
FC_BASE_URL=http://127.0.0.1:3001 node test-rag/run-tests.mjs --force
```

> 入库已改为异步：脚本上传后会轮询文档状态直到 `ready`（上限 `FC_WAIT_INGEST_MS`，默认 180 秒），
> 因此"上传返回 202"不再等于"可检索"，请以轮询结果为准。

## License

MIT

# Future-Chat

AI 对话应用：多模型流式对话 + 工具调用（联网搜索 / 文生图 / 私有知识库 RAG）+ 语音交互 + 全链路监控。

## 技术栈

| 分类     | 技术                                                               |
| -------- | ------------------------------------------------------------------ |
| 框架     | Next.js 15（App Router，生产构建 `output: 'standalone'`）          |
| 语言     | TypeScript 5                                                       |
| UI       | Tailwind CSS 3.4 + shadcn/ui（Radix UI）                           |
| 状态管理 | Zustand 5                                                          |
| 数据库   | PostgreSQL 16 + Prisma ORM 6（pgvector 向量检索）                  |
| 认证     | NextAuth v4（Credentials / Google / GitHub）+ 自研 JWT Cookie      |
| AI 能力  | 硅基流动 SiliconFlow：对话、Embedding、Rerank、TTS / ASR           |
| 联网搜索 | Tavily API                                                         |
| 流式协议 | SSE（`text/event-stream`）                                         |
| 监控     | Future-monitor-sdk（仓库内工作区包 `packages/future-monitor-sdk`） |
| 测试     | Vitest（服务端纯逻辑 + SDK 单测）                                  |

## 功能

### 对话

- SSE 流式响应，支持中途停止
- 多模型切换：`deepseek-ai/DeepSeek-V3.2`（默认，工具调用更稳定）、`Qwen/Qwen2.5-72B-Instruct`
- 思考模式（推理过程可视化）
- 会话管理：创建 / 删除 / 重命名 / 置顶
- 消息操作：复制 / 朗读 / 重试 / 编辑
- 分享链接（只读分享页）

### 工具调用（Function Calling）

| 工具               | 触发方式                 | 说明                   |
| ------------------ | ------------------------ | ---------------------- |
| `knowledge_search` | 输入框「私有知识库」开关 | 检索私有知识库         |
| `web_search`       | 输入框「联网搜索」开关   | Tavily 搜索并附带来源  |
| `generate_image`   | 始终可用（模型自判断）   | 文生图，带进度条可取消 |

- 最多 5 轮工具循环，工具可并行执行
- 每次请求按用户开关生成工具白名单，执行前二次校验（关闭后模型点名也不会执行）

### 私有知识库（RAG）

- 支持 `.txt` / `.md`，单文件 ≤ 1MB；上传后异步入库（切分 → Embedding → 落库 → 建索引）
- 混合检索：pgvector 向量召回 + BM25 词法召回 → RRF 融合 → cross-encoder 精排 → 绝对下限 + 相对阈值过滤 → Top-5
- 无 pgvector 时自动回退到应用层精确扫描
- 内容哈希去重、Embedding 缓存、按登录态收敛权限
- 检索状态区分 `matched` / `no_match` / `empty_knowledge_base` / `no_access` / `error`，无证据时不编造来源

### 上下文管理

- 按 token 预算分层构建（system / 当前消息 / 工具轮次 / 附件 / 历史）
- 按 token 保留最近窗口，历史盲区增量摘要并持久化
- 附件装不下时保留头尾并显式标注省略
- 超窗自动降级重试一次，逐请求输出 `[Context]` 结构化指标日志

### 语音与文件

- 语音输入 SenseVoice，语音输出 CosyVoice2（8 种音色，可持久化选择）
- 对话附件：上传 `.txt` / `.md`（≤ 1MB），内容拼进当前上下文（不进知识库）

### 其他

- 深色模式、Markdown 导出、响应式布局
- 监控 SDK：错误 / 性能 / 网络 / SSE 链路追踪、Token 成本统计、离线队列上报

## 使用方法

### 环境要求

- Node.js ≥ 22.20.0
- pnpm ≥ 11.7.0
- PostgreSQL 16（可用仓库内 `docker-compose.yml` 一键启动）

### 本地运行

```bash
pnpm install
pnpm db:generate        # 生成 Prisma Client（改了 schema 后必须执行）
pnpm db:migrate         # 建表（快速同步可用 pnpm db:push）
pnpm db:seed            # 可选：创建测试账号 admin / admin
pnpm dev                # http://localhost:3000
```

生产运行：

```bash
pnpm build
pnpm start
```

### 环境变量

仓库不提交 `.env`（在 `.gitignore` 内），请在根目录自建 `.env`。必填：

| 变量                  | 用途                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Prisma 连接串，本地默认 `postgresql://future_chat:password123@localhost:5433/future_chat` |
| `SILICONFLOW_API_KEY` | 对话 / Embedding / Rerank / 图片 / TTS / ASR                                              |
| `JWT_SECRET`          | 自研 `auth-token` 签名（生产环境至少 32 字符）                                            |
| `AUTH_SECRET`         | middleware 校验 NextAuth 会话                                                             |

可选：`TAVILY_API_KEY`（联网搜索）、`GOOGLE_CLIENT_*` / `GITHUB_CLIENT_*`（OAuth 登录）、`NEXT_PUBLIC_APP_URL`（分享链接）、
`RAG_*`（检索参数）、`CONTEXT_*`（上下文预算）、`LLM_INPUT_PRICE_PER_1M_TOKENS` / `LLM_OUTPUT_PRICE_PER_1M_TOKENS`（成本估算）。

### 常用脚本

```bash
pnpm dev / build / start     # 开发 / 构建 / 启动
pnpm lint / format / test    # ESLint / Prettier / Vitest

pnpm db:studio               # Prisma Studio
pnpm rag:status              # 向量库、索引、队列、缓存状态
pnpm rag:backfill            # 存量数据补齐索引（迁移后执行一次）
pnpm rag:rebuild             # 换 Embedding 模型后的灰度重建
pnpm rag:worker              # 独立入库 worker（多实例部署时拆分消费）
pnpm context:bench           # 上下文管理 Before/After 基准

pnpm docker:up / docker:down / docker:logs   # 应用 + 数据库
```

### Docker

```bash
pnpm docker:up                  # 启动应用与 pgvector/pgvector:pg16
docker compose up -d --build    # 改了源码后必须带 --build
docker compose exec app npx prisma migrate deploy   # 首次启动建表
```

## License

MIT

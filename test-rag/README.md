# Future-Chat RAG 测试知识库

这个目录是**用于验证 RAG（私有知识库检索）链路的极小测试数据集**，全部内容为虚构。

- 1 个知识库，3 个文档，合计约 1900 字
- 每个文档会各自被切成 1 个 chunk（项目的 chunk 上限是 800 字符），共 3 个 chunk
- 文档里埋了 7 组**模型凭常识绝对猜不到**的特殊事实，用来判断"AI 到底有没有真的读到我的私有文档"

| 文件 | 内容 |
| --- | --- |
| `project-overview.md` | 项目概览：代号、版本号、负责人、技术栈、测试角色 |
| `development-guide.md` | 开发规范：追踪头、质量门禁命令、联调角色 |
| `deployment-guide.md` | 部署说明：测试环境端口、数据重建时间、日志保留天数 |
| `run-tests.mjs` | 导入 + 8 个用例自动验收脚本（可选，也可手动测） |
| `upload-contract.mjs` | 上传契约核对：异步入库的状态机、响应字段、内容哈希去重 |

---

## 一、埋进文档的特殊事实（唯一正确答案）

| # | 事实 | 值 | 只出现在 |
| --- | --- | --- | --- |
| 1 | 项目内部代号 | `FC-6035` | 3 个文档都有（用于验证跨文档一致性） |
| 2 | 当前版本 | `v3.4.1-rc7` | project-overview.md |
| 3 | 知识库负责人 | `岑知远` | project-overview.md |
| 4 | 测试环境端口 | `34517` | deployment-guide.md |
| 5 | 测试环境角色 | `amber-ops` | project-overview.md、development-guide.md |
| 6 | 质量门禁命令 | `pnpm run fc:verify` | development-guide.md |
| 7 | 测试库每日重建时间 / 日志保留 | `03:47` / `45 天` | deployment-guide.md |

**故意没有写进去的**（用于"防编造"测试）：生产环境部署在哪个区域/机房。文档里明确写了"不属于本文档范围"。

---

## 二、怎么导入

本项目**没有知识库管理界面**：`features/` 下没有任何代码调用 `/api/knowledge`，全部知识库 API 只有后端实现。
所以导入只能走 **API / 脚本**，下面的方式 A 和 B 都是项目里真实存在的接口。

### 方式 A：一键脚本（推荐，导入 + 自动跑 8 个用例）

```powershell
# 在项目根目录执行；要求服务已在 127.0.0.1:3000 运行
node test-rag/run-tests.mjs

# 推荐：用函数调用更稳的模型跑（见第五节"必须知道的问题"）
node test-rag/run-tests.mjs "--model=deepseek-ai/DeepSeek-V3.2"

# 重新导入（会先删掉同名知识库）
node test-rag/run-tests.mjs --force

# 服务不在 3000 端口时（例如本地 dev 起在 3001）
$env:FC_BASE_URL='http://127.0.0.1:3001'; node test-rag/run-tests.mjs --force
```

脚本做的事：`POST /api/knowledge` 建库 → 3 次 `POST /api/knowledge/{id}/documents` 上传 → **轮询等待异步入库完成** → 查库核对 → 跑用例。

> ⚠️ 上传接口是**异步**的：返回 `202 + status=pending`，向量化在后台 worker 里执行。
> 脚本会自动轮询 `GET /api/knowledge/{id}/documents` 直到全部 `ready`（上限 `FC_WAIT_INGEST_MS`，默认 180 秒）。
> 手动测试时也一样：**上传返回成功 ≠ 已经可以检索**，要等 `status=ready`。

### 方式 B：纯 API（用 curl / Postman）

```bash
# 1) 拿到登录 Cookie（auth-token）
curl -i -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"admin\"}"
# 从 Set-Cookie 里取出 auth-token=...，下面用 $TOKEN 代替

# 2) 创建知识库 → 返回 knowledgeBase.id
curl -X POST http://127.0.0.1:3000/api/knowledge \
  -H "Content-Type: application/json" -H "Cookie: auth-token=$TOKEN" \
  -d "{\"name\":\"Future-Chat 内部技术知识库（RAG 测试）\"}"

# 3) 上传 3 个文档（multipart，字段名必须是 file）
curl -X POST http://127.0.0.1:3000/api/knowledge/<KB_ID>/documents \
  -H "Cookie: auth-token=$TOKEN" \
  -F "file=@test-rag/project-overview.md;type=text/markdown"
# 对 development-guide.md / deployment-guide.md 重复

# 4) 查看知识库与文档列表
curl -H "Cookie: auth-token=$TOKEN" http://127.0.0.1:3000/api/knowledge
curl -H "Cookie: auth-token=$TOKEN" http://127.0.0.1:3000/api/knowledge/<KB_ID>
```

> ⚠️ 只支持 `.txt` 和 `.md`（单文件 ≤ 1MB）。上传 PDF/DOCX 会被 `parseUploadedDocument` 直接拒绝。

### 方式 C / D（不推荐）

- **前端上传**：❌ 当前项目没有这个 UI，无法用页面导入。
- **直接写数据库**：❌ 不建议。`DocumentChunk.embedding` 必须是真实的 1024 维向量，手工插入等于用假数据冒充 RAG，会让测试结论失效。

---

## 三、导入后的预期状态

真实导入（已验证）后应当是：

```text
KnowledgeBase        1 条   name = Future-Chat 内部技术知识库（RAG 测试）
KnowledgeDocument    3 条   status = ready，chunkCount = 1（每个文档 1 个 chunk）
DocumentChunk        3 条   embedding 维度 = 1024（double precision[]），L2 范数 ≈ 1.0
                            embeddingVec 非空（vector(1024)，走 HNSW 的镜像列）
                            tsv 非空（BM25 词项 + tokenCount），embeddingModel = BAAI/bge-m3
RagTask              3 条   status = succeeded（异步入库的任务记录）
```

上传接口本身就会把结果返回给你（入队时 `status=pending`），真正的"切分 + 向量化 + 落库"结果要看
`GET /api/knowledge/{id}/documents` 里的 `status` / `chunkCount` / `processedChunks`——
"上传返回 202"只说明任务已入队，不等于已经可以检索。

想直接看索引状态：`pnpm rag:status`（pgvector、HNSW/GIN 索引、模型分布、队列、embedding 缓存一览）。

---

## 四、8 个测试用例与正确答案

**每次测试都要开一个新对话**，否则历史消息里已经出现过答案，会污染结果。

| # | 问题 | 期望答案 | 验证点 |
| --- | --- | --- | --- |
| 1 | Future-Chat 项目的内部代号是什么？ | `FC-6035` | 精确事实 + tool_call |
| 2 | Future-Chat 的测试环境使用哪个端口？ | `34517` | 特殊数字 |
| 3 | 这个知识库的负责人是谁？ | `岑知远` | 特殊人名 |
| 4 | 测试环境使用哪个端口？同时告诉我这个知识库的负责人是谁？ | `34517` + `岑知远` | **跨文档**（部署说明 + 项目概览） |
| 5 | Future-Chat 的生产环境部署在东京还是新加坡？ | "知识库中没有该信息" | **防编造** |
| 6 | （关闭私有知识库开关）Future-Chat 项目的内部代号是什么？ | 不应调用 `knowledge_search`；答不出 `FC-6035` | 开关是否生效 |
| 7 | （开启开关）同用例 1 | 调用了 `knowledge_search` 且答出 `FC-6035` | 完整链路 |
| 8 | 用另一个账号问"B 部门独占代号是什么？" | A 账号答不出；B 账号能答出 `SEC-B-99` | 权限隔离 |

---

## 五、⚠️ 必须知道的真实问题（本次测试过程中实际发现）

### 1. 模型选错，RAG 会"看起来完全没实现"（最重要）

同一个知识库、同一批问题，只换模型，结果差别巨大（各跑多次实测）：

| 模型 | 通过项 | 现象 |
| --- | --- | --- |
| `Qwen/Qwen2.5-72B-Instruct`（**项目默认模型**） | 第 1 次 **13/23**，第 2 次 **18/23**，不稳定 | 有时把工具调用**写成正文文本**（回答里直接出现 `{"name": "knowledge_search", ...}`）；有时明明开关是开的却说"私有知识库功能未开启，请在输入框开启后重试" |
| `deepseek-ai/DeepSeek-V3.2` | **23/23 全部通过**（8 个用例全绿） | 每次都正确发出 function call，检索 → 回灌 → 依据片段作答并标注来源文件 |

结论：**测 RAG 时请在模型选择器里切到 `DeepSeek-V3.2`**（两个模型都在 `shared/constants/models.ts` 白名单里，页面上可选）。
默认模型不稳定不是 RAG 链路的问题，而是模型 function calling 能力的问题；但用户第一次进来看到的就是默认模型，所以体感上就是"RAG 是坏的"。

### 2. 关掉开关不代表工具一定不会被执行

前端开关只决定 `knowledge_search` **是否进入第一轮请求的 tools**（`server/services/chat/chat.service.ts:96`）。
但服务端执行工具时**不校验这个名字是否在本次下发的 tools 里**（`server/services/chat/stream.handler.ts:226` → `tools/registry.ts:94`），
而且第二轮起会用 `toolRegistry.getToolDefinitions()` **把所有已注册工具全部下发**（`stream.handler.ts:405`）。
实测：两个开关都关闭时，模型点名 `web_search` / `knowledge_search`，后端照样执行并返回了真实结果。
→ 用例 6 在"模型正常作答"的路径上能通过；如果你在问题里直接点名工具名，就可能复现出被绕过的情况。

### 3. 阈值不再是"一个全局常数"（这段历史值得看）

早期实现用一个标定出来的绝对相似度阈值（余弦 0.45 / 0.5）。本知识库的实测很能说明问题：

- 明确问题（内部代号 / 端口）：0.62 ~ 0.79，稳过
- 含糊问题（"这个知识库的负责人是谁？"）：最高只有 **0.451** → 在 0.5 阈值下被整条过滤，**用例 3 检索到 0 条**

相关查询的 Top-1 落在 0.4465~0.6320，不相关查询落在 0.1970~0.4805，**两个分布重叠**——也就是说阈值怎么选都错：
调低放进噪声，调高误杀正解。问题不在"阈值调得准不准"，而在单路余弦分在小语料上分辨力不足。

现在改成：向量（pgvector）**+** BM25 词法两路召回 → RRF 融合 → cross-encoder 精排 → 按"当前问题的最好命中"
取相对比例切尾。效果（同一知识库、同一问题实测）：

| 用例 3「这个知识库的负责人是谁？」 | 结果 |
| --- | --- |
| 旧实现（绝对阈值 0.5） | 检索 **0 条** → 答不出 |
| 现在 | 检索 **1 条**（`project-overview.md`，精排分 0.59+）→ 正确答出 岑知远 |

`RAG_MIN_SCORE` 已废弃（仅作为 `RAG_VECTOR_MIN_SCORE` 的别名，且只在精排不可用时生效）；
要调检索行为请看 `server/services/rag/README.md` 里的环境变量表。

### 4. 其它

- **有知识库管理 UI**：输入框旁的知识库弹窗可建库 / 删库 / 上传 / 删文档，也可指定"只检索某个知识库"。
- **运行中的容器可能落后于源码**：本次测试的 3000 端口是 Docker 镜像（`docker-compose.yml` 里 `NODE_ENV: production`），改完源码需要重新 `docker compose up -d --build` 才生效。
- **入库是异步的**：上传接口只解析并入队（`202 + status=pending`），切分 / 向量化 / 建索引由后台 worker 执行；
  弹窗会在上传后轮询并显示"入库中 n/m"，也可以直接看 `GET /api/knowledge/{id}/documents`。

---

## 六、在哪看"RAG 真的被调用了"

| 位置 | 看什么 |
| --- | --- |
| 浏览器 Network | `POST /api/chat`（响应类型 `text/event-stream`），在 EventStream/响应体里找 `"type":"tool_call"`、`"name":"knowledge_search"`、`"type":"tool_result"`、`"knowledgeSources"`、`"type":"answer"` |
| 浏览器界面 | 回答上方出现"正在查询知识库..."（带旋转图标）→ 完成后变成"已检索 N 个知识片段" + `来源:` 后面的文件名标签（如 `project-overview.md`） |
| 服务端日志 | `[ToolRegistry] Registered tool: knowledge_search`、`[ChatService] Enabled tools: [...]`、`[Stream] 启动工具: knowledge_search`、`[RAG] 文档入库完成: xxx.md → N 个片段 (BAAI/bge-m3)` |
| 数据库 | `KnowledgeBase` / `KnowledgeDocument` / `DocumentChunk`：`embedding`（1024 维 `double precision[]`）+ `embeddingVec`（`vector(1024)`，走 HNSW 的镜像列）+ `tsv`（BM25 词项，GIN）。一句话概览用 `pnpm rag:status` |

---

## 七、最小验收标准

```text
① 文档成功导入（3 个文档 status=ready）
② Chunk / Embedding 成功（3 个 chunk，1024 维，非零向量）
③ SSE 中出现 knowledge_search 的 tool_call
④ tool_result 真正进入第二轮 LLM（回答里出现 FC-6035）
⑤ AI 答出只存在于私有文档的特殊事实（FC-6035 / 34517 / 岑知远）
```

五条全部成立 → **RAG 基础功能验证通过**（用 `DeepSeek-V3.2` 实测 23/23 项通过，满足全部 5 条）。

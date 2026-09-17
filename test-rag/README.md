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
```

脚本做的事：`POST /api/knowledge` 建库 → 3 次 `POST /api/knowledge/{id}/documents` 上传 → 查库核对 → 跑用例。

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
DocumentChunk        3 条   embedding 维度 = 1024，L2 范数 ≈ 1.0
```

上传接口本身就会把结果返回给你（`status` 和 `chunkCount` 字段），这两个字段就是"切分 + 向量化 + 落库"是否成功的直接证据。

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

### 3. 相似度阈值是个真实取舍

`RAG_MIN_SCORE` 默认 0.5（`server/services/rag/index.ts:54`）。本知识库实测：
- 明确问题（内部代号 / 端口）：0.62 ~ 0.79，稳过
- 含糊问题（"这个知识库的负责人是谁？"）：最高只有 **0.451**，在 0.5 阈值下会被过滤掉 → 用例 3 可能检索到 0 条

可用环境变量微调，不用改代码：在 `.env` 里加 `RAG_MIN_SCORE=0.45` 后重启应用即可。

### 4. 其它

- **没有知识库管理 UI**：不能建库、不能上传、不能删文档，也不能指定"只检索某个知识库"（开关是"全部我的知识库"）。
- **运行中的容器可能落后于源码**：本次测试的 3000 端口是 Docker 镜像（`docker-compose.yml` 里 `NODE_ENV: production`），改完源码需要重新 `docker compose up -d --build` 才生效。
- **入库是同步的**：上传接口要等 embedding 全部返回才响应，大文件会卡几十秒。

---

## 六、在哪看"RAG 真的被调用了"

| 位置 | 看什么 |
| --- | --- |
| 浏览器 Network | `POST /api/chat`（响应类型 `text/event-stream`），在 EventStream/响应体里找 `"type":"tool_call"`、`"name":"knowledge_search"`、`"type":"tool_result"`、`"knowledgeSources"`、`"type":"answer"` |
| 浏览器界面 | 回答上方出现"正在查询知识库..."（带旋转图标）→ 完成后变成"已检索 N 个知识片段" + `来源:` 后面的文件名标签（如 `project-overview.md`） |
| 服务端日志 | `[ToolRegistry] Registered tool: knowledge_search`、`[ChatService] Enabled tools: [...]`、`[Stream] 启动工具: knowledge_search`、`[RAG] 文档入库完成: xxx.md → N 个片段 (BAAI/bge-m3)` |
| 数据库 | `KnowledgeBase` / `KnowledgeDocument` / `DocumentChunk.embedding`（1024 维 `double precision[]`）；本项目的相似度是在 Node 应用层算的，**没有 pgvector** |

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

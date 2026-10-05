# 对话上下文管理（Context Management）

把 Future-Chat 从「历史有多长就发送多长」升级为「有明确 token 预算、自动压缩历史、
保留近期上下文、持久化 Summary、控制附件与 RAG 占用，并且能用真实 benchmark
证明收益」的上下文管理。

- 可复现基准：`pnpm context:bench`（离线）/ `pnpm context:bench -- --live`（含真实 API）。
  报告写到 `docs/context-benchmark.{md,json}`；**`docs/` 在 .gitignore 内**，
  报告是生成物所以不入库——本文里的对照表就是那次运行的结论，需要原始报告时重新跑一次即可。

---

## 1. 改造前是什么样（Before 是真实代码，不是假想基线）

```ts
const historyMessages = await MessageRepository.findByConversationId(
  conversation.id
)
const currentUserMessage = appendAttachments(content, attachments)
const contextMessages = buildContextMessages(
  historyMessages,
  currentUserMessage,
  imageAvailable
)
```

`findByConversationId(conversationId, limit?)` 本身支持 `limit`，但对话主链路**没传**，
于是：

```text
数据库完整历史 ──► buildContextMessages ──► system + 全部历史 + 当前消息 ──► SiliconFlow
```

不存在 token 预算、窗口、摘要、超窗降级、附件限制、上下文指标。

具体后果（都在真实接口上复现过，不是推测。窗口按 provider 声明的
`max_prompt_tokens = 163840` 计）：

| 场景                     | Before 实际发送                                 | 后果                                                                 |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------- |
| 2000 条消息              | 253,770 token（真实发出 249,319）               | **被真实拒绝**：`code 20015 ... exceeded max_prompt_tokens (163840)` |
| 1000 条消息              | 127,770 token                                   | 逼近上限（163,840），再聊几十轮就发不出去                            |
| 一个 900KB 的 `.md` 附件 | 304,280 token（≈ 2 个窗口）                     | **必然失败**：上传上限是 1MB，全文直接进 prompt                      |
| 连续 1200 轮会话         | 累计 183,504,000 token，其中 **691 轮会被拒绝** | 会话越长越贵，最后直接不可用                                         |

同时 `partial` 的既有局部限制（`MAX_TOOL_ROUNDS=5`、RAG `TOP_K=5` × `MAX_SNIPPET_CHARS=600`、
`RERANK_MAX_CHARS`）都不是上下文管理：它们只管自己那一段，管不住"历史整体无上限"这个主问题。

---

## 2. 链路（After）

```text
system prompt｜历史消息｜当前消息｜附件｜本轮启用的工具｜已持久化摘要
      │
      ├─ 1. planContextBudget()      算各层上限（附件截断之前）
      ├─ 2. applyAttachmentBudget()  附件：装得下则全量，装不下则头+尾截断 / 整份丢弃并告知
      ├─ 3. finalizeContextBudget()  得出 history 预算
      ├─ 4. selectRecentMessages()   按 token 预算取最近窗口（保证整轮、不出现孤立 tool）
      ├─ 5. shouldCompactHistory()?  盲区攒够阈值才压缩（低频事件）
      │        └─ summarizeHistory()  增量摘要：旧摘要 + 新缺口 → 新摘要（落库，CAS 写入）
      ├─ 6. 用新摘要重算一次窗口      （摘要大小会直接影响窗口大小）
      ├─ 7. assembleMessages()       system → 摘要 → 最近消息 → 当前消息
      └─ 8. 发送前最终校验            超硬上限则逐条丢历史 → 再截断用户消息
                                        （provider 仍报超窗时，用降级上下文重试一次）
```

主链路调用点：`server/services/chat/chat.service.ts`。
对外只有两个入口：`buildManagedContext()` 与 `ContextBudgetExceededError`。

### 模块划分

| 文件             | 职责                                                |
| ---------------- | --------------------------------------------------- |
| `config.ts`      | **所有** context 相关数字与开关（含环境变量解析）   |
| `tokens.ts`      | 保守 token 估算（单遍遍历，无依赖）                 |
| `budget.ts`      | 分层预算：窗口 → 输出预留 → 安全边际 → 各层分配     |
| `window.ts`      | 最近窗口选择（按 token，对齐整轮，不产生孤立 tool） |
| `compactor.ts`   | 压缩触发判据、摘要提示词、分块增量摘要、摘要硬上限  |
| `truncate.ts`    | 确定性文本截断（头+尾+显式省略标记）                |
| `attachments.ts` | 附件预算与截断/丢弃                                 |
| `manager.ts`     | 编排、降级、指标装配                                |
| `metrics.ts`     | 指标结构、成本估算、估算 vs 实测对照、日志          |

---

## 3. 分层预算

```text
contextWindow                       模型窗口（见 shared/constants/models.ts）
├── outputReserve                   completion 预留（与真实下发的 max_tokens 同源）
├── safetyMargin                    估算误差边际（默认 10%）
└── availableContext                可分配给输入的软预算
    ├── system                      system prompt
    ├── currentUser                 当前用户消息（含附件与附件说明）
    ├── toolReserve                 工具轮次预留（只按**实际启用**的工具累加）
    ├── attachment                  附件（截断后的实际占用）
    └── history                     历史区
        ├── summary                 已持久化摘要
        └── recent                  最近若干条消息
```

两条约定：

1. **只有一份预算实现**（`budget.ts`）。`manager` / `window` / `attachments` / `compactor`
   一律接收算好的数字，不允许自己再算一遍——重复实现必然导致两处口径漂移。
2. **软预算与硬上限分开**。窗口选择为了保住"整轮对话"允许小幅超出软预算
   （见 `window.ts` 的 `PAIR_OVERSHOOT_TOLERANCE`），这点超出由安全边际吸收；
   发送前的最终校验按**硬上限** `contextWindow - outputReserve` 判
   （provider 真正会拒绝的那条线）。若按软预算判，一次轻微的整轮补齐就会触发
   "把所有历史丢光"的降级，那是比超预算更糟的结果。

### 工具预留不是"预留 5 轮"

`MAX_TOOL_ROUNDS = 5`，但按 5 轮预留会白吃掉一大块历史预算。实际做法：

- 只给**会产出大载荷的工具**预留（`knowledge_search` 3,200 / `web_search` 2,000），
  `generate_image` 只回一句话，不占预留；
- 只按 **2 轮**预留（后续轮次多为重复调用或小结果）；
- 总预留封顶在可用上下文的 25%，避免工具把历史挤没。

知识库那一份单独记为 `ragReserveTokens`（RAG 独立成账，不混进 history）。
预留值是**从各工具真实输出上限推出来的**，并由 `budget.test.ts` 的守卫测试锁住：
RAG 的 `TOP_K` / `MAX_SNIPPET_CHARS` 一旦变大而预留没跟着改，测试会失败。

### 输出预留与请求参数同源

`resolveMaxOutputTokens(model, enableThinking)` 同时被
`ai/siliconflow.ts`（下发给 provider 的 `max_tokens`）和预算（`outputReserve`）使用。
预算按 1024 留位置、请求却按 4096 发，那"预算合法"就只是纸面上的合法。

---

## 4. token 估算

**不复用 `rag/tokenizer.ts`**：它是 BM25 词法检索的 CJK bigram 分词器，词项必须与
Postgres `to_tsvector('simple', ...)` 的 lexeme 逐字对齐，与 LLM 的 BPE 词表无关；
拿它算上下文预算会系统性低估。

**也不引入 tiktoken / 官方 tokenizer**：这里只要"预算判断"，为了精确值引入一个
WASM/原生依赖，换来的只是少压缩一点点。

实现是 `tokens.ts` 里的保守上界估算：ASCII 4 字符/token、CJK 1 字符/token、
其他 2 字符/token，单遍遍历、无正则、无中间数组。**保守方向是刻意的**：

- 高估 → 提前压缩（多花一点摘要成本）
- 低估 → 真的撞上 `context_length_exceeded`（用户直接看到失败）

实测校准（`--live`，真实 `prompt_tokens`）：

| 规模                      | 估算    | 实测    | 误差                 |
| ------------------------- | ------- | ------- | -------------------- |
| 10 条消息                 | 3,018   | 2,542   | −18.7%（偏高，安全） |
| 200 条消息                | 26,978  | 26,118  | −3.3%（偏高，安全）  |
| 2000 条（受管上下文）     | 116,962 | 114,648 | −2.0%（偏高，安全）  |
| 2000 条（全量历史，超限） | 253,778 | —       | 被拒绝：实测 249,319 |

方向一致为"偏高"（安全侧）。运行时会持续校验：偏差超过 25% 时打一条
`[Context] 估算偏差超出容忍` 的 warn，供事后收敛系数。

最后一行还顺带给出了**估算误差的上界证据**：估算 253,778、provider 实测 249,319，
差 1.8%——估算偏高一点，正好落在安全侧。

---

## 5. 最近窗口

不是 `history.slice(-20)`。按条数截断有两个问题：条数不等于 token；
而且会切出"半轮对话"（窗口第一句是回答、用户问了什么却不在上下文里）。

规则：

1. 从**最新**往前按 token 累加，取连续后缀（不抽样）；
2. 窗口必须以 `user` 开头——必要时向前扩一轮；
3. 扩一轮的溢出超过 15% 就不再扩，改为向前丢掉那半轮；
4. 后面已经没有 `user` 边界时退化为无条件向前扩（宁可略超预算，也不给模型一个空窗口）；
5. 至少保留一个用户轮次。

`tool` 消息不会被放在窗口开头（孤立的 tool 结果是 OpenAI 兼容协议下的非法序列）。
当前链路落库的历史只有 `user` / `assistant`，且**只回放 role + content**
（与改造前一致，不把 `toolCalls` 从历史里翻出来——那要求同时补齐配对的 tool 消息，
跨轮次配对很容易拼出非法序列）。规则 5 是对"历史里混进 tool 消息"的防御。

---

## 6. 压缩（Recent Window + Summary）

### 触发判据：盲区，而不是"历史有多长"

**盲区** = 既不在摘要里、也不在最近窗口里的消息。它是唯一真正会丢信息的部分。

```ts
shouldCompactHistory({ uncoveredTokens, historyBudgetTokens, thresholdRatio })
// uncoveredTokens >= ceil(historyBudgetTokens * thresholdRatio)
```

如果按"历史长度"判，会话一旦超过窗口就会每轮都压缩（既慢又贵，摘要还会反复重写）。
按盲区判才能让它成为低频事件。

默认阈值 `0.1`，由 `pnpm context:bench` 的阈值扫描定出（见 `config.ts` 里的对照表）。
两个实测结论（1200 轮会话、四档阈值都确实触发过压缩）：

| 阈值 | 稳定态压缩间隔 | 会话总 token | 盲区峰值（占 115,206 的历史预算） |
| ---- | -------------- | ------------ | --------------------------------- |
| 0.1  | 约 46 轮       | 114,352,050  | 11,340（9.8%）                    |
| 0.25 | 约 114 轮      | 114,315,765  | 28,728（24.9%）                   |
| 0.5  | 约 229 轮      | 114,272,505  | 57,456（49.9%）                   |
| 0.75 | 约 343 轮      | 114,216,450  | 86,184（74.8%）                   |

1. **成本几乎与阈值无关**（四档总 token 差 0.12%）。摘要是增量的，
   每条消息只被摘要一次，阈值只影响"旧摘要被重复喂入"的次数。
   「把阈值调高省钱」是错觉。
2. **盲区峰值与阈值近似成正比**：0.75 会让最多 **74.8%** 的历史预算处于"暂时不可见"
   状态，0.1 只有 **9.8%**。用户问"我最开始说的名字是什么"时，答案很可能正好落在盲区里。

注意"占预算的比例"这一列与窗口大小无关（峰值 ≈ 阈值 × 历史预算），
所以这两次窗口修正（64K → 128K → 160K）都没有推翻这个结论，只是绝对数字变大。

因此判据是：先设一条"平均每 20 轮最多压缩一次"的产品红线（压缩同步发生在首 token
之前，频率直接等于"用户多等一次摘要"的次数），再在红线内选盲区峰值最小的。

### 增量摘要 + 水位线

```text
新摘要 = 摘要模型(旧摘要 + 自水位线以来的新缺口)
```

而不是"旧摘要 + 旧摘要 + 新摘要"的拼接——那样摘要会线性膨胀，最终比它替代掉的
历史还占地方。输出侧还有 `capSummaryToTokens()` 硬上限兜底：**不能依赖模型遵守提示**。

水位线（`Conversation.summaryUpToMessageId`）= 摘要已覆盖到的最后一条消息。
关键细节：**水位线只推进"本次真正并入摘要的条数"**（`consumedCount`），
不推进 `gapMessages.length`。分块上限或超时会只处理一部分，推早了那段历史就永久消失。

水位线消息被删除时找不到 → 缺口起点退回 0，把整段旧历史重新并入摘要。
代价是重复摘要（浪费一点 token），收益是**绝不会因为删消息而永久丢掉中间那一段**。

### 分块与「追赶式压缩」

首次压缩时缺口可能极大（600 条消息 ≈ 75K token），一次请求放不下。所以：

- 按 `summaryChunkMaxTokens`（默认 4,000）切块，从旧到新顺序滚动摘要；
- 单次请求最多 3 块（`MAX_SUMMARY_CHUNKS_PER_REQUEST`），限制尾延迟；
- 整步有总超时（默认 15,000ms）；
- 没处理完的部分留到后续轮次继续追赶。

**这条是实测倒逼出来的**：最初按"可用上下文的 70%"切块（约 20K token），
真实调用在 8 秒内跑不完（`--live` 测到 TTLB 恰好 8015ms），于是首次压缩静默降级、
长期记忆一直建不起来。修法不是"把超时调大"（那只会让用户等更久），
而是**限制单次请求要干多少活**。

### 摘要以 `system` 角色注入，不伪装成用户发言

```text
system: <base system prompt>
system: 【历史对话摘要】…（明确说明这不是逐字原文）
...最近消息...
user:   <当前消息>
```

伪装成 `user` 会让模型把摘要当成用户的原话。放在 base system 之后也兼顾了前缀缓存：
base system prompt 是稳定前缀，摘要只在压缩时变化。

### 并发：CAS 写入，不需要分布式锁

用户连发 A/B/C 时会有多个请求并发压缩。`ConversationRepository.saveSummary()` 用
`summaryUpdatedAt` 当版本号做条件更新（compare-and-swap）：

```ts
updateMany({ where: { id, summaryUpdatedAt: expectedUpdatedAt }, data: { ... } })
```

只有读到同一个旧值的那个请求能写成功，其余 update 到 0 行。Postgres 在 READ COMMITTED
下会对被并发修改的行重新求值 WHERE，所以不需要事务、也不需要分布式锁。
CAS 失败时本次仍使用内存里的摘要服务当前请求，不覆盖对方更新的结果。

### 失败必须无害

摘要超时 / 5xx / 返回空 → 返回 `ok:false`，调用方退回纯窗口截断，**聊天照常进行**，
只记 `compactionFailed=true`。用户主动取消（AbortSignal）时直接跳过压缩，
不做任何摘要、不落库。长期记忆系统挂掉不能把聊天一起带下去。

---

## 7. 附件

附件走的是"解析后全文拼进当前消息"，上传上限 1MB（约 100 万 token）——
**一个附件就能把上下文彻底打爆**，而且发送前就已经注定失败。

- 预算充足 → 原文全量，**一个字符都不改**
- 预算不足 → 保留**文件头 + 文件尾**，中间插入显式省略标记
  （只留头会丢结尾的结论/汇总，模型读到被切断的文档还会自信地补完）
- 连保底尺寸（`attachmentMinTokens`，默认 120）都放不下 → 整份丢弃，
  并在当前消息里写明**哪些附件没有被包含**，让模型能如实告知用户

不做 RAG 化：附件是"用户当轮贴给你看的东西"，丢进向量库既改变产品语义，
又引入一次 embedding 成本与时延。

另一个事实（写在这里以免误判）：**只有当前轮的附件会进入上下文**。
历史消息里存的 `attachments` 不会被回放，所以附件预算只针对当前消息。

---

## 8. 超窗降级（两层）

1. **发送前**（`manager.ts`）：逐条从最旧一端丢历史直到装得下 →
   仍超则确定性截断当前用户消息。逐条丢而不是"一超就全丢"：
   后者会让一次轻微超预算直接把模型打回失忆状态。
2. **provider 仍报超窗时**（`chat.service.ts`）：用降级上下文
   （system + 摘要 + 当前消息）重试**一次**。绝不无限重试——那会把一次失败
   变成一串计费请求。重试用的上下文由 `buildContextResult.degradedMessages` 提供，
   与工具多轮循环共用同一个基准。

---

## 9. 指标与成本

每次构建产出一份 `ContextMetrics`，并以**单行 JSON** 打到 `console.warn`：

```bash
grep '\[Context\]' app.log | jq '{historyMessageCount, retainedMessageCount, estimatedInputTokens, wasCompacted}'
```

为什么是 `warn`：`next.config.ts` 配了 `compiler.removeConsole = { exclude: ['error','warn'] }`，
生产构建会把 `console.log` **整段删掉**（已实测：构建产物里连既有业务日志字符串都不存在）。
指标日志如果被删掉，"可观测"就只是开发机上的错觉。
可用 `CONTEXT_METRICS_LOG=off` 关闭。

关于成本：**不写死任何价格**。单价只从
`LLM_INPUT_PRICE_PER_1M_TOKENS` / `LLM_OUTPUT_PRICE_PER_1M_TOKENS` 读，
未配置时成本字段一律为 `null`，报告里就写"未配置价格，不做成本估算"。
在代码里硬编码一个数字，等于把一条会过期的错误信息伪装成事实。

两个单价的**实际生效范围不同**，别误读：

- `LLM_INPUT_PRICE_PER_1M_TOKENS`：驱动指标里的 `estimatedInputCost`
  （用构建时就能确定的估算输入 token 换算）。
- `LLM_OUTPUT_PRICE_PER_1M_TOKENS`：服务端**不自动**使用它——输出 token 要等模型答完
  才知道，不属于上下文构建的职责。它连同 `estimateCost()` 一起提供给运维/外部
  按同一个函数换算真实总成本（前端监控 SDK 有自己的价目表，这里刻意不重复维护一套）。

---

## 10. 环境变量

| 变量                               | 默认    | 说明                                         |
| ---------------------------------- | ------- | -------------------------------------------- |
| `CONTEXT_WINDOW_OVERRIDE`          | 未设置  | 覆盖模型声明的窗口；核对 provider 文档后设置 |
| `CONTEXT_COMPACT_THRESHOLD_RATIO`  | `0.1`   | 盲区达到历史预算的这个比例时压缩             |
| `CONTEXT_SUMMARY_MAX_TOKENS`       | `800`   | 摘要自身硬上限                               |
| `CONTEXT_SUMMARY_CHUNK_MAX_TOKENS` | `4000`  | 单次摘要调用的输入上限（限制首字延迟）       |
| `CONTEXT_SUMMARY_TIMEOUT_MS`       | `15000` | 一次压缩（含所有分块）的总超时               |
| `CONTEXT_ATTACHMENT_SHARE_RATIO`   | `0.5`   | 附件最多占剩余可用上下文的比例               |
| `CONTEXT_ATTACHMENT_MAX_TOKENS`    | `12000` | 附件整体上限                                 |
| `CONTEXT_ATTACHMENT_MIN_TOKENS`    | `120`   | 单个附件被截断后的保底尺寸                   |
| `CONTEXT_SAFETY_MARGIN_RATIO`      | `0.1`   | 估算误差边际                                 |
| `CONTEXT_MIN_RECENT_USER_TURNS`    | `1`     | 至少保留的用户轮次                           |
| `CONTEXT_METRICS_LOG`              | 未设置  | 设为 `off` 关闭逐请求指标日志                |
| `LLM_INPUT_PRICE_PER_1M_TOKENS`    | 未设置  | 输入单价；未配置则不做成本估算               |
| `LLM_OUTPUT_PRICE_PER_1M_TOKENS`   | 未设置  | 输出单价                                     |

非法值（空串、非数字、比例越界）一律**回退到默认值并打一条 warn**，
不让一个写错的环境变量把聊天接口打成 500。

---

## 11. 已知限制（都是实测出来的，不掩饰）

1. **窗口取的是 provider 明确给出的数字，但仍应随模型/供应商复核。**
   `deepseek-ai/DeepSeek-V3.2` 取 163,840 —— 依据是 provider 自己返回的
   `max_prompt_tokens (163840) limit`（原样报文见 `shared/constants/models.ts`），
   并有 70K/100K/130K 三档被受理作为下界验证；`Qwen/Qwen2.5-72B-Instruct` 取 32768
   （依据是 `-128K` 是一个独立模型 id）。换模型或换供应商后请重新核对，
   或用 `CONTEXT_WINDOW_OVERRIDE` 覆盖。
   注意这里曾经写过两次过小的值（65536、131072），代价是**无谓地多压缩**——
   所以宁可花一次实测的 token 把它定准。

2. **首次压缩一个超大历史会很慢，且需要多轮才能追平。**
   实测 1600 条消息时，单轮最多消化 12,000 token 的缺口，剩余 75,105 token
   需要约 7 轮才能追平（15s 总超时内只跑完 3 次摘要调用）。
   好消息是水位线只推进实际处理量，剩下的会在后续轮次继续——不会丢，只是慢。
   新会话不会遇到这个问题（缺口从 0 开始缓慢增长，每轮只需处理约 11.5K token）。

3. **provider 延迟方差极大，TTFT/TTLB 在本项目里测不出可靠结论。**
   同一档位（约 26K token）两次请求的 TTFT 分别是 769ms 与 7,271ms；
   500 条消息那一档跑了两次 `--live`，一次 After 快 3 倍、一次慢 7 倍
   ——**同一份代码、相近的 token 数，结论相反**。
   所以本模块的性能收益只用确定性的 token 数与消息条数来证明；
   延迟收益需要几十次采样 + 同时段对照才能下结论，本次没有做，报告里如实标注为无法测量。

   另一个**确定**的延迟事实值得记下来：输入越大越慢。实测 114,648 token 的受管上下文
   TTFT 67.6s / TTLB 72.6s。也就是说窗口放宽到 160K 之后，"能答"和"答得快"是两件事——
   如果产品更在意响应速度，把 `CONTEXT_WINDOW_OVERRIDE` 调小即可（代价是更早开始压缩）。

4. **摘要是同步的，会占用首 token 前的等待时间。**
   这是选择"阻塞式压缩"（确定性、可测试）而不是后台压缩的代价。
   已经在三处做了限制：单块上限、单请求块数上限、总超时；
   并靠阈值把频率压到"平均 20 轮以上一次"。

5. **摘要是有损的。** 盲区峰值被压到历史预算的 9.8%，但它不是 0；
   摘要本身也可能漏掉细节。因此 system 提示里明确要求模型"摘要中没有的细节
   要如实说明，不要编造"。保留性验证只覆盖了固定的几个关键实体（确定性断言），
   没有做 LLM 评测（那样会产生不可控的测试成本）。

---

## 12. 测试与复现

```bash
pnpm test                              # 单元 + 集成 + 回归
CONTEXT_DB_TEST=1 pnpm test            # 追加摘要持久化 / 并发 CAS 的真库用例（需要库）
pnpm context:bench                     # 离线基准 → docs/context-benchmark.{md,json}（docs/ 不入库）
pnpm context:bench -- --live           # 追加真实 API 测量（TTFT/TTLB + 估算校准）
npx tsc --noEmit --incremental false
pnpm lint
```

测试分布（`context/__tests__/`）：

| 文件                                        | 覆盖                                                         |
| ------------------------------------------- | ------------------------------------------------------------ |
| `tokens.test.ts`                            | 估算方向（只许高估）、可加性、确定性、包装开销               |
| `budget.test.ts`                            | 各层计算、不变量、边界（恰好/超出/零预算）、工具预留守卫     |
| `window.test.ts`                            | 按 token 取窗口、整轮对齐、不产生孤立 tool、至少一个用户轮次 |
| `attachments.test.ts`                       | 全量/截断/丢弃、确定性、与拼装格式一致                       |
| `compactor.test.ts`                         | 触发判据、水位线语义、分块、失败与取消、摘要硬上限           |
| `manager.test.ts`                           | 编排全链路 + 降级 + 指标自洽 + **语义保留**（确定性断言）    |
| `metrics.test.ts`                           | 不编造价格、误差方向、日志级别与开关                         |
| `../__tests__/chat-service-context.test.ts` | 集成：chat.service → manager → prompt.builder → siliconflow  |

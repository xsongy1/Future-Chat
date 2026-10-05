/**
 * 上下文管理的全部可调参数
 *
 * 单一职责：**新增的 context 相关数字只能出现在这里**。
 * 不散落到 manager / budget / window 里，否则调阈值要改三个文件，
 * 而且改漏一个就会出现"预算按 0.75 算、窗口按 0.8 裁"这种自相矛盾。
 *
 * 两类参数刻意分开：
 * - 代码常量：语义稳定、改它必须同时改测试与文档的（如预留轮数、比例分配）
 * - 环境变量：部署环境相关、需要运维按实际模型/价格调整的（窗口覆盖、阈值、价格）
 *
 * 原有的业务常量不搬进来、也不重复定义：RAG 的 TOP_K / MAX_SNIPPET_CHARS 留在
 * rag/index.ts，工具轮数上限 MAX_TOOL_ROUNDS 留在 stream.handler.ts，
 * 这里只引用它们的**语义**（在注释里写清对应关系，并由守卫测试锁住）。
 */

/**
 * 预留几个"工具轮次"的上下文空间
 *
 * 工具结果是在首轮请求之后才进入上下文的，无法在构建期精确测量，只能预留。
 * 取 2 而不是 MAX_TOOL_ROUNDS(5)：多轮里后续轮次往往是同一工具的重复调用或小结果，
 * 按 5 轮预留会白吃掉大量 history 预算。
 * 剩下的尾部风险由两道保险兜住：发送前的最终预算校验，以及 provider 报错后的单次 fallback。
 */
const TOOL_RESERVE_ROUNDS = 2

/**
 * 单个工具**单轮**可能产出的 token 预留
 *
 * 数字来自各工具真实存在的输出上限，不是拍脑袋：
 * - knowledge_search：TOP_K(5) × MAX_SNIPPET_CHARS(600) = 3000 字符（见 rag/index.ts）。
 *   按 CJK 1 token/字的上界估即 3000，再留一点格式化开销 → 3200。
 * - web_search：5 条结果 ×（标题 + URL + 正文截断 200 字符）+ 摘要（见 web-search.ts）≈ 2000。
 * - 其余工具（如 generate_image 只回一句"图片已生成完成。"）→ 不在表里，预留 0。
 *
 * 这张表由 budget 的守卫测试锁住：知识库的真实上限一旦变大，测试会失败。
 */
export const TOOL_PAYLOAD_RESERVE_TOKENS: Readonly<Record<string, number>> = {
  knowledge_search: 3200,
  web_search: 2000,
}

/** 工具轮次预留的硬上限：最多只能吃掉可用上下文的这个比例，避免工具把 history 挤没 */
const MAX_TOOL_RESERVE_RATIO = 0.25

/** 安全边际比例：可用上下文再打九折，用来吸收估算误差（估算本身已是保守上界） */
const DEFAULT_SAFETY_MARGIN_RATIO = 0.1

/**
 * 触发压缩的阈值比例
 *
 * 语义：不是"历史用到 N% 就压缩"，而是"**未被摘要覆盖的盲区**（既不在摘要里、
 * 也不在最近窗口里）占历史预算的比例超过它"才压缩
 * （见 compactor.ts 的 shouldCompactHistory 与 manager 的缺口计算）。
 *
 * ## 0.1 是 benchmark 跑出来的，不是拍的
 *
 * `pnpm context:bench` 在 600 轮会话上扫描四档阈值，结果（见 docs/context-benchmark.md）：
 *
 * | 阈值 | 稳定态压缩间隔 | 会话总 token | 盲区峰值 token（占预算） |
 * | --- | --- | --- | --- |
 * | 0.1  | 约 22 轮 | 28,694,529 | 5,544（9.9%） |
 * | 0.25 | 约 56 轮 | 28,683,214 | 13,860（24.7%） |
 * | 0.5  | 约 112 轮 | 28,648,944 | 27,972（49.8%） |
 * | 0.75 | 约 167 轮 | 28,627,469 | 42,084（74.9%） |
 *
 * 两个结论：
 *
 * 1. **成本几乎与阈值无关**（四档总 token 差 0.23%）。因为摘要是增量的：
 *    每条消息只会被摘要一次，阈值只影响"已有摘要被重复喂入"的次数，那部分很小。
 *    所以"把阈值调高省钱"是错觉。
 * 2. **盲区与阈值强相关**：0.75 会让最多 74.9% 的历史预算落在"暂时不可见"的盲区里，
 *    用户问"我最开始说的名字是什么"时答案很可能正好在盲区。0.1 把这个峰值压到 9.9%。
 *
 * 所以阈值应该定在"盲区尽量小、压缩频率又不至于打扰用户"的位置：压缩是**同步发生在
 * 首 token 之前**的，间隔太短会让用户频繁遇到"这次回答先卡一下"。取"平均每 20 轮
 * 最多压缩一次"作为红线，实测 0.1 的稳定态间隔为 22 轮，仍在红线之上，
 * 于是它就是红线内盲区最小的选择。
 *
 * 想用延迟换记忆保真度（或反过来）时，改这一个值即可；
 * 环境变量 `CONTEXT_COMPACT_THRESHOLD_RATIO` 可在不改代码的情况下覆盖。
 */
const DEFAULT_COMPACT_THRESHOLD_RATIO = 0.1

/** 摘要自身的 token 上限：摘要必须比它替代掉的历史小得多，否则压缩没有意义 */
const DEFAULT_SUMMARY_MAX_TOKENS = 800

/**
 * 单次摘要调用的输入上限
 *
 * 实测教训：冷压缩最初按"可用上下文的 70%"切块（32K 窗口下约 20K token），
 * 真实调用**在 8 秒总超时内没跑完**（`--live` 测到的 TTLB 正好 8015ms），
 * 于是首次压缩静默降级成窗口截断、长期记忆一直建不起来。
 *
 * 修法不是"把超时调大"（那只会让用户多等更久），而是**限制单次请求要干多少活**：
 * 把每块压到 4K token 量级，单次调用 1~3 秒能完成，超出的部分由后续轮次继续追赶
 * （水位线只推进实际处理掉的量，没摘完的不会被当成已覆盖）。
 * 代价是冷启动需要几轮才能追平，换来的是首字延迟可控。
 */
const SUMMARY_CHUNK_MAX_TOKENS = 4000

/** 附件最多可占"剩余可用上下文"的比例，其余留给历史对话 */
const DEFAULT_ATTACHMENT_SHARE_RATIO = 0.5

/** 附件整体 token 上限（绝对闸门：单个 1MB 文本约数十万 token，必须封顶） */
const DEFAULT_ATTACHMENT_MAX_TOKENS = 12000

/** 单个附件被截断后的保底 token 数，低于这个值就不值得保留（宁可整份丢弃并告知） */
const DEFAULT_ATTACHMENT_MIN_TOKENS = 120

/**
 * 摘要调用的总超时（毫秒）：覆盖一次压缩里的所有分块调用
 *
 * 15 秒是"单块 4K token、最多 3 块"下的合理上限。
 * 摘要失败不能拖垮聊天——超时后一律退回确定性窗口截断，聊天照常。
 */
const DEFAULT_SUMMARY_TIMEOUT_MS = 15000

/** 历史窗口至少要保留的用户轮次（软下限，避免"预算刚好卡死"时窗口被裁成空） */
const DEFAULT_MIN_RECENT_USER_TURNS = 1

export interface ContextConfig {
  /** 覆盖模型声明的上下文窗口（未设置时为 null，用模型配置里的保守值） */
  contextWindowOverride: number | null
  safetyMarginRatio: number
  compactThresholdRatio: number
  summaryMaxTokens: number
  /** 单次摘要调用的输入上限（token）：限制一次请求要干的活，从而限制首字延迟 */
  summaryChunkMaxTokens: number
  attachmentShareRatio: number
  attachmentMaxTokens: number
  attachmentMinTokens: number
  summaryTimeoutMs: number
  minRecentUserTurns: number
  /** 输入 token 单价（每 100 万 token）；未配置为 null，此时不做成本估算 */
  inputPricePer1MTokens: number | null
  /** 输出 token 单价（每 100 万 token）；未配置为 null */
  outputPricePer1MTokens: number | null
}

/**
 * 解析正整数环境变量
 *
 * 非法值（空串、非数字、负数、0）一律回退到默认值而不是抛错：
 * 一个写错的环境变量不该让聊天接口 500。但会打一条 warn 让配置错误可见。
 */
function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `[Context] 环境变量 ${name}="${raw}" 不是正数，忽略并使用默认值 ${fallback}`
    )
    return fallback
  }
  return value
}

/** 解析可选的正整数环境变量：未配置或非法时返回 null */
function readOptionalNumberEnv(name: string): number | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`[Context] 环境变量 ${name}="${raw}" 不是正数，按未配置处理`)
    return null
  }
  return value
}

/** 解析 0~1 之间的比例环境变量 */
function readRatioEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    console.warn(
      `[Context] 环境变量 ${name}="${raw}" 不在 (0,1) 区间，忽略并使用默认值 ${fallback}`
    )
    return fallback
  }
  return value
}

/** 解析价格环境变量：未配置或非法时返回 null（**不编造价格**） */
function readPriceEnv(name: string): number | null {
  const raw = process.env[name]?.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    console.warn(
      `[Context] 环境变量 ${name}="${raw}" 不是非负数，按未配置处理（不做成本估算）`
    )
    return null
  }
  return value
}

export function getContextConfig(): ContextConfig {
  return {
    contextWindowOverride: readOptionalNumberEnv('CONTEXT_WINDOW_OVERRIDE'),
    safetyMarginRatio: readRatioEnv(
      'CONTEXT_SAFETY_MARGIN_RATIO',
      DEFAULT_SAFETY_MARGIN_RATIO
    ),
    compactThresholdRatio: readRatioEnv(
      'CONTEXT_COMPACT_THRESHOLD_RATIO',
      DEFAULT_COMPACT_THRESHOLD_RATIO
    ),
    summaryMaxTokens: readNumberEnv(
      'CONTEXT_SUMMARY_MAX_TOKENS',
      DEFAULT_SUMMARY_MAX_TOKENS
    ),
    summaryChunkMaxTokens: readNumberEnv(
      'CONTEXT_SUMMARY_CHUNK_MAX_TOKENS',
      SUMMARY_CHUNK_MAX_TOKENS
    ),
    attachmentShareRatio: readRatioEnv(
      'CONTEXT_ATTACHMENT_SHARE_RATIO',
      DEFAULT_ATTACHMENT_SHARE_RATIO
    ),
    attachmentMaxTokens: readNumberEnv(
      'CONTEXT_ATTACHMENT_MAX_TOKENS',
      DEFAULT_ATTACHMENT_MAX_TOKENS
    ),
    attachmentMinTokens: readNumberEnv(
      'CONTEXT_ATTACHMENT_MIN_TOKENS',
      DEFAULT_ATTACHMENT_MIN_TOKENS
    ),
    summaryTimeoutMs: readNumberEnv(
      'CONTEXT_SUMMARY_TIMEOUT_MS',
      DEFAULT_SUMMARY_TIMEOUT_MS
    ),
    minRecentUserTurns: readNumberEnv(
      'CONTEXT_MIN_RECENT_USER_TURNS',
      DEFAULT_MIN_RECENT_USER_TURNS
    ),
    inputPricePer1MTokens: readPriceEnv('LLM_INPUT_PRICE_PER_1M_TOKENS'),
    outputPricePer1MTokens: readPriceEnv('LLM_OUTPUT_PRICE_PER_1M_TOKENS'),
  }
}

/**
 * 工具轮次预留
 *
 * 只按**实际启用的工具**累加：没开知识库就不为知识库预留，
 * 避免"用户什么都没开，history 却被预留吃掉 1/4"。
 *
 * @returns total 及按工具拆分的明细（明细用于 metrics 里单独报 RAG 预留）
 */
export function calculateToolReserveTokens(
  enabledToolNames: readonly string[],
  availableContextTokens: number
): { total: number; perTool: Record<string, number> } {
  const perTool: Record<string, number> = {}
  let total = 0

  for (const name of enabledToolNames) {
    const perRound = TOOL_PAYLOAD_RESERVE_TOKENS[name]
    if (!perRound) continue
    const reserved = perRound * TOOL_RESERVE_ROUNDS
    perTool[name] = reserved
    total += reserved
  }

  const cap = Math.floor(availableContextTokens * MAX_TOOL_RESERVE_RATIO)
  if (total <= cap) return { total, perTool }

  // 超出上限时按同一比例缩放，保持各工具之间的相对权重
  const scale = cap / total
  for (const name of Object.keys(perTool)) {
    perTool[name] = Math.floor(perTool[name] * scale)
  }
  return { total: Math.floor(total * scale), perTool }
}

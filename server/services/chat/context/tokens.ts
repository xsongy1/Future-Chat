/**
 * LLM token 估算
 *
 * ## 为什么不复用 rag/tokenizer.ts
 *
 * `rag/tokenizer.ts` 是 **BM25 词法检索**的分词器（CJK bigram + 拉丁词），
 * 它的词项必须与 Postgres `to_tsvector('simple', ...)` 的 lexeme 逐字对齐，
 * 与 LLM 的 BPE 词表没有任何关系。拿它算上下文预算会系统性低估（bigram 把
 * 汉字按 2 字一组切，而 BPE 对汉字通常接近 1 字 1 token 甚至更多）。
 *
 * ## 为什么不引入 tiktoken / 官方 tokenizer
 *
 * 这里的用途只是**预算判断**，不需要精确值：为了精确值引入一个 WASM/原生依赖，
 * 换来的只是"少压缩一点点"，代价却是多一个需要跟模型版本对齐的运行时依赖。
 *
 * ## 保守方向是刻意的
 *
 * **高估**只让我们提前压缩（多花一点摘要成本）；
 * **低估**会让请求真的撞上 context_length_exceeded（用户直接看到失败）。
 * 所以所有规则都取上界口径。
 */

/**
 * 估算一段文本的 token 数（保守上界）
 *
 * 计量规则：
 * - ASCII：4 字符/token（英文实际约 4 字符/token，上取整即上界）
 * - CJK / 假名 / 全角标点：1 字符/token（实际约 0.6~0.7）
 * - 其他（emoji、其他文字）：2 字符/token（emoji 常被切成 2~3 个 token）
 *
 * 单次遍历、无正则、无中间数组：热路径上最贵的操作就是 charCodeAt。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  let ascii = 0
  let cjk = 0
  let other = 0

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      ascii++
    } else if (isCjkOrFullWidth(code)) {
      cjk++
    } else {
      other++
    }
  }

  return Math.ceil(ascii / 4) + cjk + other * 2
}

/**
 * 是否属于 CJK 汉字 / 假名 / 谚文 / 全角标点区间
 *
 * 用区间比较而不是 `/\p{Script=Han}/u`：后者每次调用都要编译与回溯，
 * 而这条路径对每条消息、每个字符都要走到。
 */
function isCjkOrFullWidth(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点
    (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  )
}

/**
 * 每条消息的固定包装开销
 *
 * OpenAI 兼容的 chat 模板每条消息大约贡献 3~4 个 token（role 名 + 起止分隔符），
 * 这里按 4 记（上界口径）。
 */
export const MESSAGE_OVERHEAD_TOKENS = 4

/** 整个请求的固定开销：模板起始标记 + 结尾的 assistant 引导标记，取上界 */
export const REQUEST_OVERHEAD_TOKENS = 8

/** 单条消息的估算 token 数（只算真正会下发的 role + content） */
export function estimateMessageTokens(message: {
  role: string
  content: string | null
}): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.content ?? '')
}

/** 一组消息的估算结果 */
export interface HistoryTokenBreakdown {
  /** 与输入顺序对齐的逐条 token 数（窗口从后往前累加时直接查表，避免重复估算） */
  perMessage: number[]
  /** 含逐条包装开销的合计 */
  total: number
}

/**
 * 一次遍历算完所有历史消息的 token 数
 *
 * 返回 perMessage 而不是只返回 total：选最近窗口需要"从最新往前累加"，
 * 只给 total 的话调用方得在循环里再对每条消息估一次（同一段文本估两遍）。
 */
export function estimateHistoryTokens(
  messages: readonly { role: string; content: string | null }[]
): HistoryTokenBreakdown {
  const perMessage: number[] = new Array(messages.length)
  let total = 0

  for (let i = 0; i < messages.length; i++) {
    const tokens = estimateMessageTokens(messages[i])
    perMessage[i] = tokens
    total += tokens
  }

  return { perMessage, total }
}

/**
 * 估算一次完整请求的输入 token（system + 历史 + 当前消息）
 *
 * 发送前最终校验用。口径必须与真实请求体一致：
 * 多算会让预算过早收紧，少算会让校验形同虚设。
 */
export function estimateRequestTokens(
  systemPrompt: string,
  currentUserContent: string,
  history: readonly { role: string; content: string | null }[]
): number {
  return (
    REQUEST_OVERHEAD_TOKENS +
    estimateMessageTokens({ role: 'system', content: systemPrompt }) +
    estimateHistoryTokens(history).total +
    estimateMessageTokens({ role: 'user', content: currentUserContent })
  )
}

/**
 * 估算器的性质
 *
 * 写进 benchmark 报告用：真实的 prompt_tokens 与这里的估计值必然有差异，
 * 报告里必须区分二者，不能把估计值当成实测值。
 */
export const TOKEN_ESTIMATOR_KIND = 'conservative-heuristic' as const

export type TokenEstimatorKind = typeof TOKEN_ESTIMATOR_KIND

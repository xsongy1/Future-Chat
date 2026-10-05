/**
 * 确定性文本截断（按 token 预算）
 *
 * ## 为什么不是 `text.slice(0, 10000)`
 *
 * 按**字符数**截断对中英文是完全不同的两件事：10000 字符的中文约 1 万 token，
 * 10000 字符的英文只有 2.5 千 token。而预算的单位是 token，所以字符数根本不是预算。
 *
 * ## 为什么保留"头 + 尾"
 *
 * 只留头会丢掉结尾处的关键信息（规范文档的结论、配置文件的默认值、汇总表格的合计），
 * 模型读到中间被切断的文档，往往还会自信地补完——比明确告诉它"这里省略了"更危险。
 * 头尾都留 + 中间插入显式标记，模型能知道自己少看了什么。
 *
 * ## 为什么需要迭代
 *
 * token/字符的换算比例取决于文本构成（中文≈1 字符/token，英文≈4 字符/token），
 * 无法一步算出"多少字符等于 N token"。所以先按乐观值起步，用实测值收缩，
 * 直到真的落进预算。截断只发生在超预算这条冷路径上，迭代成本可忽略。
 */

import { estimateTokens } from './tokens'

/** 默认保留给头部的比例 */
const DEFAULT_HEAD_SHARE = 0.6

/** 迭代上限（几何收缩，实际 2~3 轮收敛） */
const DEFAULT_MAX_ITERATIONS = 8

/** ASCII 乐观起步值：4 字符/token */
const CHARS_PER_TOKEN_GUESS = 4

export interface TruncateTextOptions {
  /** 保留给头部的比例（其余给尾部，标记本身不占这个比例） */
  headShare?: number
  /** 头部占比之外留给省略标记的空间会从总长度里自动扣除 */
  renderNotice?: (omittedChars: number) => string
  /** 迭代上限 */
  maxIterations?: number
  /**
   * 用于校验结果长度的估算函数
   *
   * 默认按纯文本估算。附件需要连同包装格式（文件名 + 代码围栏）一起估算，
   * 所以开放这个注入点而不是在函数里硬编码包装格式。
   */
  measure?: (text: string) => number
}

/** 默认的省略标记：中英文都可读，且"已省略"这个词是显式的（下游与测试都依赖它） */
export function defaultOmissionNotice(omittedChars: number): string {
  return `\n\n[... 因超出上下文预算，此处已省略 ${omittedChars} 字符 ...]\n\n`
}

/**
 * 把文本压到 `targetTokens` 以内
 *
 * @returns 截断后的文本；连标记都放不下（目标过小）时返回 null，由调用方决定丢弃还是报错
 */
export function truncateTextToTokenBudget(
  text: string,
  targetTokens: number,
  options: TruncateTextOptions = {}
): string | null {
  if (targetTokens <= 0) return null
  if (!text) return ''

  const headShare = options.headShare ?? DEFAULT_HEAD_SHARE
  const renderNotice = options.renderNotice ?? defaultOmissionNotice
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS
  const measure = options.measure ?? estimateTokens

  // 已经装得下：一个字符都不动（避免"无意义的重写"）
  if (measure(text) <= targetTokens) return text

  let keepChars = Math.min(text.length, targetTokens * CHARS_PER_TOKEN_GUESS)

  for (let i = 0; i < maxIterations; i++) {
    if (keepChars <= 0) return null

    const headChars = Math.floor(keepChars * headShare)
    const tailChars = Math.max(0, keepChars - headChars)
    const omittedChars = Math.max(0, text.length - headChars - tailChars)

    if (omittedChars === 0) return text

    const candidate =
      text.slice(0, headChars) +
      renderNotice(omittedChars) +
      (tailChars > 0 ? text.slice(text.length - tailChars) : '')

    const tokens = measure(candidate)
    if (tokens <= targetTokens) return candidate

    // 严格单调收缩：next 一定小于当前 keepChars，循环必然终止
    keepChars = Math.min(
      keepChars - 1,
      Math.floor((keepChars * targetTokens) / tokens)
    )
  }

  return null
}

/**
 * 上下文管理 Before / After 基准
 *
 * ## 为什么 Before 不是"我编的一个基线"
 *
 * Before 直接调用**改造前的生产代码路径**：`buildContextMessages`（整段历史）
 * + `appendAttachments`（附件全文）。这就是改造前 chat.service 真正在做的事，
 * 所以它的数字代表真实的历史行为，而不是一个为了衬托 After 而造出来的稻草人。
 * （回归测试里也用它做对照，见 manager.test.ts 的说明。）
 *
 * ## 三类测量
 *
 * 1. **单轮构建**：固定数据的 7 个场景（10 / 50 / 200 / 500 / 1000 条消息、超长附件、
 *    RAG + 工具调用），比较输入 token、消息条数、溢出、构建耗时。
 * 2. **会话级模拟**：连续多轮的真实使用形态。单轮对比看不出关键差别——
 *    真正的差别是 Before 的**每轮输入随会话长度线性增长**，所以整场会话的总输入
 *    是 O(n²)，而 After 把它压成 O(n)。同时扫描压缩阈值，用数据决定默认值。
 * 3. **真实 API 测量（`--live`）**：用真实 SiliconFlow 调用测 TTFT / TTLB，
 *    并拿真实 `prompt_tokens` 校准估算器。没有 key 时如实标注为"未测量"。
 *
 * ## 可复现性
 *
 * 数据全部由固定公式生成（无随机、无时间依赖），同一版本代码每次跑出的 token 数完全一致。
 * 耗时会波动，所以报告里给的是多次重复的中位数。
 *
 * ## 用法
 *
 *   pnpm context:bench                      # 离线（不需要网络与数据库）
 *   pnpm context:bench -- --live            # 追加真实 API 测量
 *   pnpm context:bench -- --live --live-repeats=1   # 降低真实调用量（provider 有 TPM 限流）
 *   pnpm context:bench -- --turns=600       # 调整会话模拟轮数
 *
 * ⚠️ 报告是**整体覆盖写**的：跑一次不带 `--live` 的基准，会把上次含真实测量的报告
 * 替换成"未测量"版本。想同时保留两份就用 `--out=<目录>` 分开存。
 * 另外真实 API 测量很费 token（D 档一次 6 万 token 起），provider 的 TPM 限流
 * 跑几次就会触发 429——报告会如实记录 429，不会假装成功。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  getModelById,
  resolveMaxOutputTokens,
} from '../shared/constants/models'
import {
  buildContextMessages,
  appendAttachments,
} from '../server/services/chat/prompt.builder'
import {
  buildManagedContext,
  type ConversationSummaryState,
} from '../server/services/chat/context/manager'
import {
  MAX_SUMMARY_CHUNKS_PER_REQUEST,
  summarizeHistory,
} from '../server/services/chat/context/compactor'
import {
  TOKEN_ESTIMATOR_KIND,
  estimateHistoryTokens,
  estimateTokens,
} from '../server/services/chat/context/tokens'
import { getContextConfig } from '../server/services/chat/context/config'
import type {
  ContextAttachment,
  ContextHistoryMessage,
} from '../server/services/chat/context/types'
import { createChatCompletion } from '../server/services/ai/siliconflow'
import { parseSSELine, splitSSEBuffer } from '../shared/utils/sse'

// ============================================================
// 配置与固定数据
// ============================================================

const MODEL_ID = 'deepseek-ai/DeepSeek-V3.2'
const MODEL = getModelById(MODEL_ID)!

/** 输出预留与真实请求下发的 max_tokens 同源（非思考模式 → 1024） */
const OUTPUT_RESERVE = resolveMaxOutputTokens(MODEL, false)

/**
 * 基准使用的上下文配置 = **生产默认值**
 *
 * 刻意不在这里重复写一份常量：那样一旦改了 config.ts 的默认值，基准会继续用旧值跑，
 * 报告与实际行为就悄悄脱节了。直接读 getContextConfig()，环境变量覆盖也一并生效
 * （实际取值会打印在报告头部）。
 */
const BENCH_CONFIG = getContextConfig()

/** 每条消息正文的目标 token 数（汉字 1 token/字，便于精确控制规模） */
const TOKENS_PER_MESSAGE = 120

/** 每轮重复测量次数：单次计时抖动大，取中位数 */
const TIMING_REPEATS = 25

/** 场景 E 的附件规模：30 万汉字 ≈ 900KB UTF-8，接近上传上限 1MB */
const HUGE_ATTACHMENT_CHARS = 300_000

/** 稳定态摘要的大小（模拟一次真实压缩的产物） */
const STEADY_STATE_SUMMARY_TOKENS = 400

interface CliOptions {
  live: boolean
  turns: number
  outDir: string
  /** 真实 API 测量的重复采样次数（每个档位） */
  liveRepeats: number
}

function parseArgs(): CliOptions {
  const arg = (name: string): string | undefined => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : undefined
  }
  return {
    live: process.argv.includes('--live'),
    // 默认 600 轮：会话必须长到窗口被撑满、并且之后还滑动了很久，
    // 才能显出"Before 每轮输入线性增长（整场 O(n²)）vs After 被钉在预算上（O(n)）"的差别。
    // 轮数太少时两边都还没溢出，对比只会看到持平。
    turns: Number(arg('turns') ?? 600),
    outDir: arg('out') ?? 'docs',
    // 真实 API 测量很费 token（D 档一次就是 6 万 token），provider 有 TPM 限流，
    // 连跑几次基准就会撞 429。默认 3 次采样；跑不完时用 --live-repeats=1 降量。
    liveRepeats: Math.max(1, Number(arg('live-repeats') ?? 3)),
  }
}

/** 生成恰好 n 个 token 的确定性正文 */
function filler(tokens: number): string {
  return '测'.repeat(Math.max(0, tokens))
}

/**
 * 生成一段确定性的多轮对话
 *
 * 每轮固定 1 条 user + 1 条 assistant，并按确定性规则在第 1 / 31 / 61 轮注入关键信息
 * （姓名、代号、事实、决定），用于检查压缩后这些信息是否还在摘要里。
 */
function makeConversation(turns: number): ContextHistoryMessage[] {
  const messages: ContextHistoryMessage[] = []

  for (let turn = 0; turn < turns; turn++) {
    const prefix = `第${turn + 1}轮：`
    const userExtra =
      turn === 0
        ? '我叫 Alice，项目代号 FC-6035。'
        : turn === 30
          ? '决定: 数据库使用 PostgreSQL。'
          : turn === 60
            ? '事实: 部署在 Docker 上。'
            : ''
    const assistantExtra =
      turn === 0 ? '好的 Alice，已记下项目代号 FC-6035。' : ''

    messages.push({
      id: `u-${turn}`,
      role: 'user',
      content: prefix + userExtra + filler(TOKENS_PER_MESSAGE),
    })
    messages.push({
      id: `a-${turn}`,
      role: 'assistant',
      content:
        filler(TOKENS_PER_MESSAGE) +
        (assistantExtra ? ` ${assistantExtra}` : ''),
    })
  }

  return messages
}

/** 稳定态摘要：模拟一次真实压缩的产物（含关键实体，用于验证长期记忆没丢） */
function makeSteadyStateSummary(): string {
  return [
    '# 用户目标',
    '长期推进一个多轮技术对话',
    '# 已确认的事实',
    '部署在 Docker 上',
    '# 关键实体（人名 / 文件名 / 编号 / 参数）',
    'Alice、FC-6035',
    '# 用户偏好与约束（仅限用户明确说过的）',
    '无',
    '# 已做出的决定',
    '数据库使用 PostgreSQL',
    '# 未解决的问题',
    '无',
    '# 工具调用得出的重要结论',
    '无',
    filler(STEADY_STATE_SUMMARY_TOKENS),
  ].join('\n')
}

// ============================================================
// 通用工具
// ============================================================

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percent(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : -100
  return round(((after - before) / before) * 100, 2)
}

/** 一次请求是否会被 provider 拒绝（输入 + 输出预留 > 窗口） */
function overflows(
  inputTokens: number,
  outputReserve: number,
  contextWindow: number
): boolean {
  return inputTokens + outputReserve > contextWindow
}

// ============================================================
// 1. 单轮构建对比
// ============================================================

interface BuildMeasurement {
  historyMessages: number
  finalMessages: number
  estimatedInputTokens: number
  summaryTokens: number
  historyTokens: number
  attachmentTokens: number
  toolReserveTokens: number
  retainedMessages: number
  overflows: boolean
  buildMsMedian: number
  wasCompacted: boolean
  wasTruncated: boolean
  uncoveredTokens: number
  /** 该场景是否按事实应当已经存在摘要（由历史是否超预算推断） */
  hadSummary?: boolean
}

interface Scenario {
  id: string
  label: string
  historyTurns: number
  attachments?: ContextAttachment[]
  enabledTools?: string[]
  /** 工具轮次追加到上下文里的大小（模拟一次 knowledge_search / web_search 的结果） */
  toolResultTokens?: number
  note?: string
}

const SYSTEM_PROMPT = buildContextMessages([], 'x', true)[0].content

const SCENARIOS: Scenario[] = [
  { id: 'A', label: '短对话（10 条）', historyTurns: 5 },
  { id: 'B', label: '中等对话（50 条）', historyTurns: 25 },
  { id: 'C', label: '长对话（200 条）', historyTurns: 100 },
  { id: 'D', label: '超长对话（500 条）', historyTurns: 250 },
  { id: 'D2', label: '超长对话（1000 条）', historyTurns: 500 },
  {
    id: 'E',
    label: '超长附件（约 900KB）+ 20 条历史',
    historyTurns: 10,
    attachments: [
      {
        name: 'handbook.md',
        content: filler(HUGE_ATTACHMENT_CHARS),
        type: 'md',
        size: HUGE_ATTACHMENT_CHARS * 3,
      },
    ],
    note: '附件走"解析后全文进当前消息"的链路，改造前会被原样塞进请求',
  },
  {
    id: 'F',
    label: 'RAG + Tool Calling + 长历史（200 条）',
    historyTurns: 100,
    enabledTools: ['knowledge_search', 'web_search', 'generate_image'],
    toolResultTokens: 3200,
    note: 'toolResultTokens 模拟首轮 knowledge_search 的结果（5 条 × 600 字符上限）',
  },
]

function measureBefore(
  scenario: Scenario,
  history: ContextHistoryMessage[]
): BuildMeasurement {
  const currentUserMessage = '继续'

  const timings: number[] = []
  let finalMessages: ContextHistoryMessage[] = []

  for (let i = 0; i < TIMING_REPEATS; i++) {
    const started = performance.now()
    const withAttachments = appendAttachments(
      currentUserMessage,
      scenario.attachments ?? []
    )
    finalMessages = buildContextMessages(
      history.map((m) => ({ role: m.role, content: m.content ?? '' })),
      withAttachments
    ) as ContextHistoryMessage[]
    timings.push(performance.now() - started)
  }

  // Before 没有附件预算：附件原样进去，所以附件 token 单独记账以便解释溢出原因
  const attachmentTokens = (scenario.attachments ?? []).reduce(
    (sum, file) =>
      sum +
      estimateTokens(
        `\n\n---\n**附件: ${file.name}**\n\`\`\`\n${file.content}\n\`\`\``
      ),
    0
  )

  const estimatedInputTokens =
    finalMessages.reduce(
      (sum, m) => sum + 4 + estimateTokens(m.content ?? ''),
      0
    ) + 8

  return {
    historyMessages: history.length,
    finalMessages: finalMessages.length,
    estimatedInputTokens,
    summaryTokens: 0,
    historyTokens: estimatedInputTokens - attachmentTokens,
    attachmentTokens,
    toolReserveTokens: 0,
    retainedMessages: history.length,
    // Before 连"工具结果进来之后"的空间都没留，所以按加上工具结果后判断
    overflows: overflows(
      estimatedInputTokens + (scenario.toolResultTokens ?? 0),
      OUTPUT_RESERVE,
      MODEL.contextWindow
    ),
    buildMsMedian: round(median(timings), 3),
    wasCompacted: false,
    wasTruncated: false,
    uncoveredTokens: 0,
  }
}

async function measureAfter(
  scenario: Scenario,
  history: ContextHistoryMessage[],
  summaryState: ConversationSummaryState
): Promise<BuildMeasurement> {
  const build = () =>
    buildManagedContext({
      systemPrompt: SYSTEM_PROMPT,
      historyMessages: history,
      currentUserMessage: '继续',
      attachments: scenario.attachments,
      model: MODEL,
      enableThinking: false,
      enabledToolNames: scenario.enabledTools ?? [],
      summaryState,
      // 不提供 compaction：这里测的是**稳定态**（摘要已存在、本轮不再压缩）的构建开销
      config: BENCH_CONFIG,
    })

  let last = await build()
  const timings: number[] = []
  for (let i = 0; i < TIMING_REPEATS; i++) {
    const started = performance.now()
    last = await build()
    timings.push(performance.now() - started)
  }

  return {
    historyMessages: last.metrics.historyMessageCount,
    finalMessages: last.messages.length,
    estimatedInputTokens: last.metrics.estimatedInputTokens,
    summaryTokens: last.metrics.summaryTokens,
    historyTokens: last.metrics.historyTokens,
    attachmentTokens: last.metrics.attachmentTokens,
    toolReserveTokens: last.metrics.toolReserveTokens,
    retainedMessages: last.metrics.retainedMessageCount,
    overflows: overflows(
      last.metrics.estimatedInputTokens + (scenario.toolResultTokens ?? 0),
      last.metrics.outputReserveTokens,
      last.metrics.contextWindow
    ),
    buildMsMedian: round(median(timings), 3),
    wasCompacted: last.metrics.wasCompacted,
    wasTruncated: last.metrics.wasTruncated,
    uncoveredTokens: last.metrics.uncoveredTokens,
  }
}

// ============================================================
// 2. 会话级模拟（含阈值扫描）
// ============================================================

interface SessionResult {
  turns: number
  threshold: number
  /** 整场会话所有请求的输入 token 合计 */
  totalInputTokens: number
  requests: number
  /** 没被 provider 拒绝、真正拿到回答的轮数 */
  successfulTurns: number
  /** 平均每轮输入 token（分母是全部轮数） */
  avgInputTokensPerTurn: number
  /** 每**成功**一轮的输入 token —— Before 有一批请求会被拒绝，这个指标才可公平对比 */
  inputTokensPerSuccessfulTurn: number
  peakInputTokens: number
  overflowRequests: number
  compactions: number
  summaryInputTokens: number
  summaryOutputTokens: number
  /**
   * 盲区 token **累计**
   *
   * 只能当"平均不可见程度"的代理：它随轮数单调增长，读不出真实的信息损失。
   */
  totalUncoveredTokens: number
  /**
   * 盲区峰值：任何时刻"既不在摘要也不在窗口"的历史最多有多少 token
   *
   * 这才是用户能感知的量——问"我最开始说的名字是什么"时，
   * 答案所在的那些消息会不会正好落在盲区里。
   */
  peakUncoveredTokens: number
  totalBuildMs: number
  /** 每轮追加进历史的 token 数（= 一轮对话的体量） */
  tokensPerTurn: number
  /** 历史区预算（同一配置下每轮都一样） */
  historyBudgetTokens: number
}

/**
 * 会话进入稳定态后，相邻两次压缩之间隔多少轮
 *
 * 阈值 × 历史预算 ÷ 每轮新增 token。这个数直接等于"用户每多少轮要多等一次摘要"，
 * 是选择默认阈值时真正该看的量（压缩同步发生在首 token 之前）。
 *
 * 不能拿"整场会话的压缩总次数"来判频率：会话前段窗口还没被撑满、根本不会压缩，
 * 用总次数会把频率算得偏乐观。
 */
function compactionIntervalTurns(result: SessionResult): number {
  if (result.tokensPerTurn <= 0) return Number.POSITIVE_INFINITY
  return round(
    (result.threshold * result.historyBudgetTokens) / result.tokensPerTurn,
    1
  )
}

/**
 * 模拟连续多轮的会话
 *
 * 这是本基准里最关键的一段：单轮对比只能证明"这一轮少了多少 token"，
 * 而真实成本是**一整场会话所有轮次的和**。Before 的每轮输入随会话长度线性增长，
 * 于是整场会话的输入量是 O(n²)；After 把每轮输入钉在窗口预算上，于是变成 O(n)。
 */
async function simulateSession(options: {
  turns: number
  mode: 'before' | 'after'
  threshold?: number
  replyTokens?: number
}): Promise<SessionResult> {
  const { turns, mode } = options
  const replyTokens = options.replyTokens ?? TOKENS_PER_MESSAGE
  const history: ContextHistoryMessage[] = []

  let totalInputTokens = 0
  let peakInputTokens = 0
  let overflowRequests = 0
  let compactions = 0
  let summaryInputTokens = 0
  let summaryOutputTokens = 0
  let totalUncoveredTokens = 0
  let peakUncoveredTokens = 0
  let totalBuildMs = 0
  let tokensPerTurn = 0
  let historyBudgetTokens = 0

  // 会话级摘要状态：压缩结果在轮次之间传递（等价于数据库里那一行）
  let summaryState: ConversationSummaryState = {
    summary: null,
    summaryUpdatedAt: null,
    summaryUpToMessageId: null,
  }

  for (let turn = 0; turn < turns; turn++) {
    const userMessage: ContextHistoryMessage = {
      id: `u-${turn}`,
      role: 'user',
      content: `第${turn + 1}轮：` + filler(TOKENS_PER_MESSAGE),
    }

    const buildStarted = performance.now()

    if (mode === 'before') {
      const messages = buildContextMessages(
        history.map((m) => ({ role: m.role, content: m.content ?? '' })),
        userMessage.content ?? ''
      )
      const inputTokens =
        messages.reduce(
          (sum, m) => sum + 4 + estimateTokens(m.content ?? ''),
          0
        ) + 8
      totalInputTokens += inputTokens
      peakInputTokens = Math.max(peakInputTokens, inputTokens)
      if (overflows(inputTokens, OUTPUT_RESERVE, MODEL.contextWindow))
        overflowRequests++
    } else {
      const result = await buildManagedContext({
        systemPrompt: SYSTEM_PROMPT,
        historyMessages: history,
        currentUserMessage: userMessage.content ?? '',
        model: MODEL,
        enableThinking: false,
        enabledToolNames: [],
        summaryState,
        compaction: {
          apiKey: 'benchmark',
          model: MODEL_ID,
          save: async (summary, watermarkMessageId) => {
            summaryState = {
              summary,
              summaryUpToMessageId: watermarkMessageId,
              summaryUpdatedAt: new Date(turn + 1),
            }
            return true
          },
        },
        // 摘要实现由脚本的确定性摘要器提供，并按"估算 token"记账
        complete: async (input) => {
          const promptTokens = input.messages.reduce(
            (sum, m) => sum + 4 + estimateTokens(m.content),
            0
          )
          summaryInputTokens += promptTokens
          const text = extractiveSummary(
            input.messages.map((m) => m.content).join('\n')
          )
          summaryOutputTokens += estimateTokens(text)
          compactions += 1
          return { text, usage: null }
        },
        config: options.threshold
          ? { ...BENCH_CONFIG, compactThresholdRatio: options.threshold }
          : BENCH_CONFIG,
      })

      totalInputTokens += result.metrics.estimatedInputTokens
      peakInputTokens = Math.max(
        peakInputTokens,
        result.metrics.estimatedInputTokens
      )
      totalUncoveredTokens += result.metrics.uncoveredTokens
      peakUncoveredTokens = Math.max(
        peakUncoveredTokens,
        result.metrics.uncoveredTokens
      )
      historyBudgetTokens = result.metrics.historyBudgetTokens
      if (
        overflows(
          result.metrics.estimatedInputTokens,
          result.metrics.outputReserveTokens,
          result.metrics.contextWindow
        )
      ) {
        overflowRequests++
      }
    }

    totalBuildMs += performance.now() - buildStarted

    // 追加这一轮的消息（模型回复用固定大小模拟，保证可复现）
    history.push(userMessage)
    history.push({
      id: `a-${turn}`,
      role: 'assistant',
      content: filler(replyTokens),
    })
    tokensPerTurn = round(
      history.reduce((sum, m) => sum + 4 + estimateTokens(m.content ?? ''), 0) /
        (turn + 1)
    )
  }

  const successfulTurns = turns - overflowRequests
  return {
    turns,
    threshold: options.threshold ?? BENCH_CONFIG.compactThresholdRatio,
    totalInputTokens,
    requests: turns,
    successfulTurns,
    avgInputTokensPerTurn: round(totalInputTokens / turns),
    inputTokensPerSuccessfulTurn:
      successfulTurns > 0 ? round(totalInputTokens / successfulTurns) : 0,
    peakInputTokens,
    overflowRequests,
    compactions,
    summaryInputTokens,
    summaryOutputTokens,
    totalUncoveredTokens,
    peakUncoveredTokens,
    totalBuildMs: round(totalBuildMs, 2),
    tokensPerTurn,
    historyBudgetTokens,
  }
}

/**
 * 基准用的确定性摘要器
 *
 * 与单测里的桩同一个思路：忠实地把旧摘要的各个小节取出来、与新发现的值求并集。
 * 目的是让"压缩是否真的保住了长期信息"这件事在基准里也可验证，
 * 同时让摘要的 token 成本可被估算（不需要真实 API）。
 */
function extractiveSummary(corpus: string): string {
  const section = (summary: string, title: string): string[] => {
    const match = new RegExp(`# ${title}[^\\n]*\\n([^\\n]*)`).exec(summary)
    const value = match?.[1]?.trim()
    if (!value) return []
    return value
      .split('、')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const previous =
    /【已有摘要[^\n]*】\n([\s\S]*?)\n\n【新增对话】/.exec(corpus)?.[1] ?? ''

  const entities = new Set(section(previous, '关键实体'))
  for (const match of corpus.matchAll(/我叫\s*([A-Za-z\u4e00-\u9fff]{1,12})/g))
    entities.add(match[1])
  for (const match of corpus.matchAll(/代号\s*([A-Za-z0-9-]{2,20})/g))
    entities.add(match[1])

  const facts = new Set(section(previous, '已确认的事实'))
  for (const match of corpus.matchAll(/事实[:：]\s*([^\n]{1,40})/g))
    facts.add(match[1].trim())

  const decisions = new Set(section(previous, '已做出的决定'))
  for (const match of corpus.matchAll(/决定[:：]\s*([^\n]{1,40})/g))
    decisions.add(match[1].trim())

  const join = (values: Set<string>) =>
    values.size ? [...values].join('、') : '无'

  return [
    '# 用户目标',
    '长期推进一个多轮技术对话',
    '# 已确认的事实',
    join(facts),
    '# 关键实体（人名 / 文件名 / 编号 / 参数）',
    join(entities),
    '# 用户偏好与约束（仅限用户明确说过的）',
    '无',
    '# 已做出的决定',
    join(decisions),
    '# 未解决的问题',
    '无',
    '# 工具调用得出的重要结论',
    '无',
  ].join('\n')
}

// ============================================================
// 3. 真实 API 测量（可选）
// ============================================================

interface LiveMeasurement {
  scenario: string
  /** 采样次数：单次采样无法区分"我们的优化"与"provider 排队抖动" */
  samples: number
  inputTokensReported: number | null
  outputTokens: number | null
  ttftMs: number | null
  ttlbMs: number | null
  totalMs: number | null
  /**
   * 该行的**聊天请求**输入估算
   *
   * 冷压缩那一档不是聊天请求（它测的是摘要调用），这里必须是 null——
   * 否则报告里会拿"缺口大小"去和"单块大小"算估算误差，打印出一个毫无意义的
   * -1752.7%，让整张表失去可信度。
   */
  estimatedInputTokens: number | null
  error?: string
  note?: string
}

/** 消费一次真实流式响应，测出 TTFT / TTLB 与真实 token 用量（重复采样取中位数） */
async function measureLiveRequest(
  label: string,
  apiKey: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  estimatedInputTokens: number | null,
  repeats = 1
): Promise<LiveMeasurement> {
  const samples: LiveMeasurement[] = []
  for (let i = 0; i < repeats; i++) {
    samples.push(
      await measureLiveOnce(label, apiKey, messages, estimatedInputTokens)
    )
  }

  const pick = (values: Array<number | null>): number | null => {
    const present = values.filter((v): v is number => v !== null)
    return present.length > 0 ? round(median(present), 1) : null
  }

  return {
    scenario: label,
    samples: repeats,
    inputTokensReported: pick(samples.map((s) => s.inputTokensReported)),
    outputTokens: pick(samples.map((s) => s.outputTokens)),
    ttftMs: pick(samples.map((s) => s.ttftMs)),
    ttlbMs: pick(samples.map((s) => s.ttlbMs)),
    totalMs: pick(samples.map((s) => s.totalMs)),
    estimatedInputTokens,
    error: samples.find((s) => s.error)?.error,
  }
}

async function measureLiveOnce(
  label: string,
  apiKey: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  estimatedInputTokens: number | null
): Promise<LiveMeasurement> {
  const started = performance.now()
  let ttft: number | null = null
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null =
    null

  try {
    const { reader } = await createChatCompletion(apiKey, {
      model: MODEL_ID,
      messages,
      enableThinking: false,
    })

    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { lines, remaining } = splitSSEBuffer(buffer)
      buffer = remaining
      for (const line of lines) {
        const data = parseSSELine(line)
        if (!data) continue
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          if (ttft === null && parsed.choices?.[0]?.delta?.content) {
            ttft = performance.now() - started
          }
          if (parsed.usage) usage = parsed.usage
        } catch {
          /* 非 JSON 行（心跳等）忽略 */
        }
      }
    }

    const totalMs = round(performance.now() - started, 1)
    return {
      scenario: label,
      samples: 1,
      inputTokensReported: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      ttftMs: ttft === null ? null : round(ttft, 1),
      ttlbMs: totalMs,
      totalMs,
      estimatedInputTokens,
    }
  } catch (error) {
    return {
      scenario: label,
      samples: 1,
      inputTokensReported: null,
      outputTokens: null,
      ttftMs: null,
      ttlbMs: null,
      totalMs: null,
      estimatedInputTokens,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 从 .env 里读一个变量（不引入 dotenv 依赖；已存在的环境变量优先） */
function readEnvFile(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  try {
    const content = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      return trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 没有 .env 就当作未配置 */
  }
  return undefined
}

/** 真实 API 测量：Before（全量历史）vs After（受管上下文）+ 一次冷压缩 */
async function runLiveMeasurements(repeats: number): Promise<{
  measurements: LiveMeasurement[]
  note: string
}> {
  const apiKey = readEnvFile('SILICONFLOW_API_KEY')
  if (!apiKey) {
    return {
      measurements: [],
      note: '未配置 SILICONFLOW_API_KEY，跳过真实 API 测量',
    }
  }

  const measurements: LiveMeasurement[] = []
  const instruction = '请只回复"好"一个字。'

  const estimate = (messages: Array<{ content: string | null }>): number =>
    messages.reduce((sum, m) => sum + 4 + estimateTokens(m.content ?? ''), 0) +
    8

  const asChatMessages = (
    messages: Array<{ role: string; content: string | null }>
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =>
    messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content ?? '',
    }))

  const managed = (
    history: ContextHistoryMessage[],
    summaryState: ConversationSummaryState
  ) =>
    buildManagedContext({
      systemPrompt: SYSTEM_PROMPT,
      historyMessages: history,
      currentUserMessage: instruction,
      model: MODEL,
      enableThinking: false,
      enabledToolNames: [],
      summaryState,
      config: BENCH_CONFIG,
    })

  const noSummary: ConversationSummaryState = {
    summary: null,
    summaryUpdatedAt: null,
    summaryUpToMessageId: null,
  }

  const warmSummary = (
    history: ContextHistoryMessage[]
  ): ConversationSummaryState => ({
    summary: makeSteadyStateSummary(),
    summaryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    summaryUpToMessageId: history[Math.max(0, history.length - 60)]?.id ?? null,
  })

  // 短对话：Before（全量历史）与 After 应当几乎一致
  const shortHistory = makeConversation(5)
  const shortBefore = buildContextMessages(
    shortHistory.map((m) => ({ role: m.role, content: m.content ?? '' })),
    instruction
  ) as Array<{ role: string; content: string | null }>
  measurements.push(
    await measureLiveRequest(
      'A/Before 10 条消息（全量历史）',
      apiKey,
      asChatMessages(shortBefore),
      estimate(shortBefore)
    )
  )

  const shortManaged = await managed(shortHistory, noSummary)
  measurements.push(
    await measureLiveRequest(
      'A/After 10 条消息（受管上下文）',
      apiKey,
      asChatMessages(shortManaged.messages),
      shortManaged.metrics.estimatedInputTokens
    )
  )

  // 长对话：Before 全量历史 vs After 稳定态（摘要已存在）
  const longHistory = makeConversation(100) // 200 条消息
  const longBefore = buildContextMessages(
    longHistory.map((m) => ({ role: m.role, content: m.content ?? '' })),
    instruction
  ) as Array<{ role: string; content: string | null }>
  measurements.push(
    await measureLiveRequest(
      'C/Before 200 条消息（全量历史）',
      apiKey,
      asChatMessages(longBefore),
      estimate(longBefore)
    )
  )

  const longManaged = await managed(longHistory, warmSummary(longHistory))
  measurements.push(
    await measureLiveRequest(
      'C/After 200 条消息（稳定态：摘要 + 窗口）',
      apiKey,
      asChatMessages(longManaged.messages),
      longManaged.metrics.estimatedInputTokens
    )
  )

  // D 档是唯一"输入 token 差异足够大"的一档，因此 TTFT/TTLB 只在这一档做重复采样
  const hugeHistory = makeConversation(250) // 500 条消息
  const hugeBefore = buildContextMessages(
    hugeHistory.map((m) => ({ role: m.role, content: m.content ?? '' })),
    instruction
  ) as Array<{ role: string; content: string | null }>
  measurements.push(
    await measureLiveRequest(
      'D/Before 500 条消息（全量历史）',
      apiKey,
      asChatMessages(hugeBefore),
      estimate(hugeBefore),
      repeats
    )
  )

  const hugeManaged = await managed(hugeHistory, warmSummary(hugeHistory))
  measurements.push(
    await measureLiveRequest(
      'D/After 500 条消息（稳定态：摘要 + 窗口）',
      apiKey,
      asChatMessages(hugeManaged.messages),
      hugeManaged.metrics.estimatedInputTokens,
      repeats
    )
  )

  // 冷压缩：直接调 summarizeHistory，才能拿到"几次调用 / 处理了多少条 / 还剩多少条"的细节
  const coldHistory = makeConversation(300) // 600 条消息
  const coldBreakdown = estimateHistoryTokens(coldHistory)
  const coldStarted = performance.now()
  const coldOutcome = await summarizeHistory({
    apiKey,
    model: MODEL_ID,
    previousSummary: null,
    gapMessages: coldHistory,
    chunkBudgetTokens: BENCH_CONFIG.summaryChunkMaxTokens,
    summaryMaxTokens: BENCH_CONFIG.summaryMaxTokens,
    totalTimeoutMs: BENCH_CONFIG.summaryTimeoutMs,
  })
  const coldMs = round(performance.now() - coldStarted, 0)

  measurements.push({
    scenario: '冷压缩（首次压缩，缺口 = 600 条消息）',
    samples: 1,
    inputTokensReported: coldOutcome.usage?.inputTokens ?? null,
    outputTokens: coldOutcome.usage?.outputTokens ?? null,
    ttftMs: null,
    ttlbMs: coldMs,
    totalMs: coldMs,
    // 刻意留空：这一档不是聊天请求，没有"聊天输入估算"可比
    estimatedInputTokens: null,
    note:
      `缺口按估算共 ${coldBreakdown.total} token；单块上限 ${BENCH_CONFIG.summaryChunkMaxTokens}、` +
      `最多 ${MAX_SUMMARY_CHUNKS_PER_REQUEST} 块、总超时 ${BENCH_CONFIG.summaryTimeoutMs}ms`,
    error: coldOutcome.ok
      ? undefined
      : `未跑完：${coldOutcome.error ?? 'cancelled'}（水位线只推进已处理的部分，剩余 ${
          coldOutcome.remainingCount
        } 条留到后续轮次继续追赶）`,
  })

  return {
    measurements,
    note:
      `真实 API 测量完成。冷压缩这一档：耗时 ${coldMs} ms，已并入 ${
        coldOutcome.consumedCount
      }/${coldHistory.length} 条，剩余 ${coldOutcome.remainingCount} 条由后续轮次继续追赶。` +
      `D 档为 ${repeats} 次采样中位数，其余为单次采样。`,
  }
}

// ============================================================
// 报告渲染
// ============================================================

function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = []
  const pct = (v: number) => `${v > 0 ? '+' : ''}${v}%`
  /** 分母为 0 时百分比没有意义（例如 压缩次数 0 → 3），别印一个 -100% 出来冒充降幅 */
  const pctOrDash = (before: number, after: number) =>
    before === 0 ? '—' : pct(percent(before, after))

  lines.push('# 上下文管理 Before / After 基准报告')
  lines.push('')
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(
    `- 模式：${report.mode === 'live' ? '离线 + 真实 API' : '离线（不联网、不连数据库）'}`
  )
  lines.push(
    `- 模型：\`${report.model.id}\`（窗口 ${report.model.contextWindow}，输出预留 ${report.model.outputReserve}）`
  )
  lines.push(
    `- token 估算器：\`${report.estimator}\` —— **估算值，不是精确 tokenizer**`
  )
  lines.push(`- Before：\`${report.beforeImplementation}\``)
  lines.push(
    `- 生效配置：安全边际 ${report.contextConfig.safetyMarginRatio}｜压缩阈值 ${report.contextConfig.compactThresholdRatio}｜` +
      `摘要上限 ${report.contextConfig.summaryMaxTokens} token｜附件上限 ${report.contextConfig.attachmentMaxTokens} token`
  )
  if (report.costNote) lines.push(`- 成本：${report.costNote}`)
  lines.push('')

  lines.push('## 1. 单轮构建对比（稳定态：本轮不发生压缩）')
  lines.push('')
  lines.push('Before 走的是改造前的真实代码路径（整段历史 + 附件全文）。')
  lines.push(
    '"已有摘要"只在**历史确实超过预算**的场景里才给 After —— 一段从没超过预算的对话，'
  )
  lines.push('在真实使用里不会产生摘要，硬塞一份会让短对话的对比失真。')
  lines.push('')
  lines.push(
    '| 场景 | 历史条数 | Before 输入 | After 输入 | 降幅 | Before 最终条数 | After 最终条数 | Before 溢出 | After 溢出 | Before 构建 | After 构建 |'
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const row of report.singleTurn) {
    lines.push(
      `| ${row.label} | ${row.before.historyMessages} | ${row.before.estimatedInputTokens} | ${row.after.estimatedInputTokens} | ${pctOrDash(row.before.estimatedInputTokens, row.after.estimatedInputTokens)} | ${row.before.finalMessages} | ${row.after.finalMessages} | ${row.before.overflows ? '❌ 会失败' : '✅'} | ${row.after.overflows ? '❌' : '✅'} | ${row.before.buildMsMedian} ms | ${row.after.buildMsMedian} ms |`
    )
  }
  lines.push('')

  lines.push('## 2. 会话级模拟（连续多轮，累计成本）')
  lines.push('')
  lines.push(
    '单轮对比只能说明"这一轮少了多少 token"。真实成本是**一整场会话所有轮次的和**：'
  )
  lines.push('Before 的每轮输入随会话变长而线性增长，所以整场会话是 O(n²)；')
  lines.push('After 把每轮输入钉在窗口预算上，于是变成 O(n)。')
  lines.push('')
  const b = report.session.before
  const a = report.session.after
  lines.push('| 指标 | Before | After | 变化 |')
  lines.push('| --- | --- | --- | --- |')
  const row = (name: string, bv: number, av: number, unit = '') =>
    lines.push(
      `| ${name} | ${bv}${unit} | ${av}${unit} | ${pctOrDash(bv, av)} |`
    )

  row('会话轮数', b.turns, a.turns)
  row('成功拿到回答的轮数', b.successfulTurns, a.successfulTurns)
  row(
    '溢出（会被 provider 拒绝）的轮数',
    b.overflowRequests,
    a.overflowRequests
  )
  row('累计输入 token', b.totalInputTokens, a.totalInputTokens)
  row('平均每轮输入 token', b.avgInputTokensPerTurn, a.avgInputTokensPerTurn)
  row(
    '**每成功一轮**的输入 token',
    b.inputTokensPerSuccessfulTurn,
    a.inputTokensPerSuccessfulTurn
  )
  row('峰值单轮输入 token', b.peakInputTokens, a.peakInputTokens)
  row('压缩次数', b.compactions, a.compactions)
  row(
    '摘要调用输入 token（额外成本）',
    b.summaryInputTokens,
    a.summaryInputTokens
  )
  row(
    '摘要调用输出 token（额外成本）',
    b.summaryOutputTokens,
    a.summaryOutputTokens
  )
  row(
    '盲区峰值 token（任何时刻暂时不可见的旧对话）',
    b.peakUncoveredTokens,
    a.peakUncoveredTokens
  )
  row('上下文构建总耗时', b.totalBuildMs, a.totalBuildMs, ' ms')
  lines.push('')
  lines.push(
    `> Before 在 ${b.turns} 轮里有 **${b.overflowRequests} 轮会被 provider 拒绝**（历史长过窗口之后就再也发不出去），` +
      `所以它的累计 token 只统计了发得出去的那些轮；要公平比较，看"每成功一轮的输入 token"这一行。`
  )
  lines.push('>')
  lines.push(
    `> After 的**总**输入量 = 累计输入 + 摘要调用输入 = ${a.totalInputTokens + a.summaryInputTokens}，` +
      `相对 Before 的 ${b.totalInputTokens} ${percent(b.totalInputTokens, a.totalInputTokens + a.summaryInputTokens) < 0 ? '仍是净节省' : '更高'}（摘要成本已计入）。`
  )
  lines.push('')

  lines.push('## 3. 压缩阈值扫描（用数据选默认值）')
  lines.push('')
  lines.push(
    '阈值越高 → 压缩越少（省一点钱）但"既不在摘要也不在窗口"的盲区越大（丢信息）；'
  )
  lines.push('阈值越低 → 信息保留更好，代价是更频繁地把已有摘要重喂一遍。')
  lines.push('')
  lines.push(
    '`稳定态压缩间隔` = 阈值 × 历史预算 ÷ 每轮新增 token，也就是**用户每多少轮会多等一次摘要**。'
  )
  lines.push(
    '这个数才是选择默认阈值时该看的量：压缩是同步发生在首 token 之前的。'
  )
  lines.push('')
  lines.push(
    '| 阈值 | 压缩次数 | 稳定态压缩间隔 | 累计输入 token | 摘要输入 token | 合计 | 盲区峰值 token | 盲区峰值占预算 |'
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const sweep of report.thresholdSweep) {
    const peakShare = round(
      (sweep.peakUncoveredTokens / Math.max(1, a.historyBudgetTokens)) * 100,
      1
    )
    lines.push(
      `| ${sweep.threshold} | ${sweep.compactions} | 约 ${sweep.compactionIntervalTurns} 轮 | ${sweep.totalInputTokens} | ${sweep.summaryInputTokens} | ${sweep.totalInputTokens + sweep.summaryInputTokens} | ${sweep.peakUncoveredTokens} | ${peakShare}% |`
    )
  }
  lines.push('')
  lines.push(
    '`盲区峰值` = 任何时刻"既不在摘要、也不在窗口里"的历史最多有多少 token。' +
      '用峰值而不是累计：累计值随轮数单调增长（等于"轮数 × 平均盲区"），读不出信息损失；' +
      '峰值才对应得上用户感受——问"我最开始说的名字是什么"时，那条消息会不会正好落在盲区里。'
  )
  lines.push('')
  if (report.thresholdChoice) {
    lines.push(`**结论**：${report.thresholdChoice}`)
    lines.push('')
  }

  lines.push('## 4. 冷压缩 vs 稳定态')
  lines.push('')
  lines.push('| 状态 | 摘要调用 | 摘要输入 token | 摘要输出 token | 说明 |')
  lines.push('| --- | --- | --- | --- | --- |')
  lines.push(
    `| 冷压缩（首次触发） | ${report.coldWarm.coldSummaryCalls} 次（单次请求最多 ${report.coldWarm.maxChunksPerRequest} 块） | ${report.coldWarm.coldSummaryInputTokens} | ${report.coldWarm.coldSummaryOutputTokens} | ${report.coldWarm.wasCompacted ? '一次性成本，之后不再重复' : '⚠️ 未触发（历史规模不足以跨过阈值）'} |`
  )
  lines.push('| 稳定态（摘要已缓存） | 0 次 | 0 | 0 | 每轮只付窗口那部分 |')
  lines.push('')
  lines.push(
    `> 冷压缩的额外成本只发生在**首次跨过阈值**以及之后每次**缺口攒够**时；` +
      `按本基准的会话形态，${a.turns} 轮里发生了 ${a.compactions} 次。`
  )
  lines.push('')

  lines.push('## 5. 真实 API 测量')
  lines.push('')
  if (report.live.measurements.length === 0) {
    lines.push(`**Not measured**：${report.live.note}`)
    lines.push('')
    lines.push('重跑方式：')
    lines.push('')
    lines.push('```bash')
    lines.push('pnpm context:bench -- --live')
    lines.push('```')
  } else {
    lines.push(
      '| 场景 | 采样 | 估算输入 | 真实 prompt_tokens | 估算误差 | TTFT | TTLB | 输出 token | 备注 |'
    )
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const m of report.live.measurements) {
      const error =
        m.inputTokensReported && m.estimatedInputTokens
          ? `${round(((m.inputTokensReported - m.estimatedInputTokens) / m.inputTokensReported) * 100, 1)}%`
          : '—'
      lines.push(
        `| ${m.scenario} | ${m.samples} | ${m.estimatedInputTokens ?? '—'} | ${m.inputTokensReported ?? '—'} | ${error} | ${m.ttftMs ?? '—'} ms | ${m.ttlbMs ?? '—'} ms | ${m.outputTokens ?? '—'} | ${[m.note, m.error].filter(Boolean).join('；')} |`
      )
    }
    lines.push('')
    lines.push(`> ${report.live.note}`)
    lines.push('>')
    lines.push(
      '> 估算误差为负数表示估算偏高（安全方向，不会撞窗口），正数表示估算偏低（需要收紧系数）。'
    )
    lines.push('>')
    lines.push(
      '> ⚠️ **TTFT / TTLB 在本基准里不足以支撑性能结论。** 同一个档位（D 档，输入 token 相近）' +
        '在不同次运行中给出了**相反**的结果：一次 After 比 Before 快约 3 倍，另一次 After 比 Before 慢约 7 倍。' +
        '也就是说该 provider 的首字延迟方差远大于 token 差异带来的影响，3 次采样取中位数也压不住。' +
        '要得到可信的延迟结论需要几十次采样并在同一时段做对照，本次没有做——' +
        '**本报告的性能结论只建立在 token 数与消息条数这类确定性指标上**。'
    )
  }
  lines.push('')

  lines.push('## 6. 语义保留验证（确定性断言）')
  lines.push('')
  lines.push('| 检查项 | 结果 |')
  lines.push('| --- | --- |')
  for (const check of report.retention) {
    lines.push(`| ${check.label} | ${check.passed ? '✅ 通过' : '❌ 失败'} |`)
  }
  lines.push('')

  lines.push('## 复现方式')
  lines.push('')
  lines.push('```bash')
  lines.push(
    'pnpm context:bench              # 离线基准（生成 docs/context-benchmark.md 与 .json）'
  )
  lines.push('pnpm context:bench -- --live    # 追加真实 API 测量')
  lines.push('pnpm test                       # 单元 + 集成 + 回归测试')
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

// ============================================================
// 报告类型
// ============================================================

interface SingleTurnRow {
  id: string
  label: string
  note?: string
  before: BuildMeasurement
  after: BuildMeasurement
}

interface RetentionCheck {
  label: string
  passed: boolean
}

interface BenchmarkReport {
  generatedAt: string
  mode: 'offline' | 'live'
  model: { id: string; contextWindow: number; outputReserve: number }
  estimator: string
  beforeImplementation: string
  contextConfig: {
    safetyMarginRatio: number
    compactThresholdRatio: number
    summaryMaxTokens: number
    attachmentMaxTokens: number
    attachmentShareRatio: number
  }
  costNote: string | null
  singleTurn: SingleTurnRow[]
  session: { before: SessionResult; after: SessionResult }
  thresholdSweep: Array<{
    threshold: number
    compactions: number
    totalInputTokens: number
    summaryInputTokens: number
    totalUncoveredTokens: number
    peakUncoveredTokens: number
    compactionIntervalTurns: number
  }>
  thresholdChoice: string | null
  coldWarm: {
    maxChunksPerRequest: number
    coldSummaryInputTokens: number
    coldSummaryOutputTokens: number
    coldSummaryCalls: number
    wasCompacted: boolean
  }
  live: { measurements: LiveMeasurement[]; note: string }
  retention: RetentionCheck[]
}

/** 冷压缩的累计器 */
const coldAccumulator = { input: 0, output: 0, calls: 0 }

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  // 基准自己会输出完整报告，不需要每次构建都往 stdout 打一行 JSON 指标
  //（这正是 metrics 里留 CONTEXT_METRICS_LOG 开关的原因）
  process.env.CONTEXT_METRICS_LOG = 'off'

  const options = parseArgs()
  const say = (line = '') => console.log(line)

  say('='.repeat(78))
  say('上下文管理 Before / After 基准')
  say('='.repeat(78))
  say(
    `模型窗口 ${MODEL.contextWindow}（未设置 CONTEXT_WINDOW_OVERRIDE 时使用仓库保守值）`
  )
  say(`估算器 ${TOKEN_ESTIMATOR_KIND}（估算值，非精确 tokenizer）`)
  say(
    `生效配置：压缩阈值 ${BENCH_CONFIG.compactThresholdRatio}｜摘要上限 ${BENCH_CONFIG.summaryMaxTokens}｜` +
      `附件上限 ${BENCH_CONFIG.attachmentMaxTokens}`
  )
  say('')

  // ---------- 1. 单轮构建 ----------
  say('【1】单轮构建对比（稳定态）')
  const singleTurn: SingleTurnRow[] = []

  for (const scenario of SCENARIOS) {
    const history = makeConversation(scenario.historyTurns)
    const before = measureBefore(scenario, history)

    // 是否"已经发生过一次压缩"要按事实判断，不能一律塞一份摘要进去：
    // 一段根本没超过预算的历史，在真实使用里不会产生摘要——
    // 给它硬塞一份，等于让 After 凭空多付几百 token，短对话的对比就失真了
    //（第一版就是这么错的：短对话显示 After 反而贵 18.94%，全部来自那份假摘要）。
    const rawHistoryTokens = estimateHistoryTokens(
      history.map((m) => ({ role: m.role, content: m.content ?? '' }))
    ).total
    const compactedBefore = rawHistoryTokens > before.estimatedInputTokens * 0.9

    const after = await measureAfter(
      scenario,
      history,
      compactedBefore
        ? {
            summary: makeSteadyStateSummary(),
            summaryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
            summaryUpToMessageId:
              history[Math.max(0, history.length - 60)]?.id ?? null,
          }
        : { summary: null, summaryUpdatedAt: null, summaryUpToMessageId: null }
    )
    after.hadSummary = compactedBefore

    singleTurn.push({
      id: scenario.id,
      label: scenario.label,
      note: scenario.note,
      before,
      after,
    })

    const reduction = percent(
      before.estimatedInputTokens,
      after.estimatedInputTokens
    )
    say(
      `  ${scenario.id.padEnd(3)} ${scenario.label.padEnd(36)} ` +
        `Before ${String(before.estimatedInputTokens).padStart(7)} → After ${String(after.estimatedInputTokens).padStart(6)} token ` +
        `(${reduction > 0 ? '+' : ''}${reduction}%)  ` +
        `溢出 ${before.overflows ? '有' : '无'} → ${after.overflows ? '有' : '无'}`
    )
  }
  say('')

  // ---------- 2. 会话级模拟 ----------
  say(
    `【2】会话级模拟（连续 ${options.turns} 轮，After 使用生产默认阈值 ${BENCH_CONFIG.compactThresholdRatio}）`
  )
  const sessionBefore = await simulateSession({
    turns: options.turns,
    mode: 'before',
  })
  const sessionAfter = await simulateSession({
    turns: options.turns,
    mode: 'after',
  })

  say(
    `  Before：累计输入 ${sessionBefore.totalInputTokens} token，峰值单轮 ${sessionBefore.peakInputTokens}，` +
      `溢出（会被拒绝）${sessionBefore.overflowRequests} 轮，每成功一轮 ${sessionBefore.inputTokensPerSuccessfulTurn} token`
  )
  say(
    `  After ：累计输入 ${sessionAfter.totalInputTokens} token，峰值单轮 ${sessionAfter.peakInputTokens}，` +
      `溢出 ${sessionAfter.overflowRequests} 轮，每成功一轮 ${sessionAfter.inputTokensPerSuccessfulTurn} token`
  )
  say(
    `          摘要额外成本 ${sessionAfter.summaryInputTokens} 输入 / ${sessionAfter.summaryOutputTokens} 输出 token，` +
      `压缩 ${sessionAfter.compactions} 次，盲区峰值 ${sessionAfter.peakUncoveredTokens} token`
  )
  say(
    `  每成功一轮的输入量变化：${percent(sessionBefore.inputTokensPerSuccessfulTurn, sessionAfter.inputTokensPerSuccessfulTurn)}%`
  )
  say('')

  // ---------- 3. 阈值扫描 ----------
  //
  // 扫描必须让窗口**真的被撑满**，否则四个阈值全都是"一次也不压缩"，扫描等于没做
  //（把保守窗口从 32K 提到 64K 之后，第一版扫描就是这样静默退化的）。
  // 先用一次空历史的构建探出历史预算，再据此算出"撑满 + 再滑动一段"需要的轮数。
  const probe = await buildManagedContext({
    systemPrompt: SYSTEM_PROMPT,
    historyMessages: [],
    currentUserMessage: '探针',
    model: MODEL,
    enableThinking: false,
    enabledToolNames: [],
    config: BENCH_CONFIG,
  })
  const fillTurns = Math.ceil(
    probe.metrics.historyBudgetTokens / Math.max(1, sessionAfter.tokensPerTurn)
  )
  const sweepTurns = Math.max(options.turns, fillTurns + 150)

  say(
    `【3】压缩阈值扫描（${sweepTurns} 轮：窗口约在第 ${fillTurns} 轮被撑满，之后还会滑动 ~150 轮）`
  )
  const thresholdSweep: BenchmarkReport['thresholdSweep'] = []
  const sweepResults: SessionResult[] = []
  for (const threshold of [0.1, 0.25, 0.5, 0.75]) {
    const result = await simulateSession({
      turns: sweepTurns,
      mode: 'after',
      threshold,
    })
    sweepResults.push(result)
    thresholdSweep.push({
      threshold,
      compactions: result.compactions,
      totalInputTokens: result.totalInputTokens,
      summaryInputTokens: result.summaryInputTokens,
      totalUncoveredTokens: result.totalUncoveredTokens,
      peakUncoveredTokens: result.peakUncoveredTokens,
      compactionIntervalTurns: compactionIntervalTurns(result),
    })
    say(
      `  阈值 ${String(threshold).padEnd(5)} 压缩 ${String(result.compactions).padStart(3)} 次（稳定态约每 ${String(compactionIntervalTurns(result)).padStart(5)} 轮一次），` +
        `累计输入 ${String(result.totalInputTokens).padStart(8)}，摘要输入 ${String(result.summaryInputTokens).padStart(7)}，` +
        `盲区峰值 ${String(result.peakUncoveredTokens).padStart(8)}`
    )
  }

  // 用数据选阈值。两条依据，缺一不可：
  //   1) 产品红线：压缩是**同步发生在首 token 之前**的，压缩频率直接等于
  //      "用户每多少轮要多等一次摘要"，先设一条频率红线
  //   2) token 账：在红线内选盲区**峰值**最小的那个
  //
  // 为什么用峰值而不是累计：累计值随轮数单调增长，纯粹是"轮数 × 平均盲区"，
  // 读不出信息损失。峰值才是能对应到用户感受的量。
  const MIN_TURNS_PER_COMPACTION = 20
  const minRatio = round(
    (MIN_TURNS_PER_COMPACTION * sweepResults[0].tokensPerTurn) /
      sweepResults[0].historyBudgetTokens,
    3
  )
  const eligible = thresholdSweep.filter(
    (s) => s.compactionIntervalTurns >= MIN_TURNS_PER_COMPACTION
  )
  const pool = eligible.length > 0 ? eligible : thresholdSweep
  const best = pool.reduce((a, b) =>
    b.peakUncoveredTokens < a.peakUncoveredTokens ? b : a
  )
  const lowest = thresholdSweep[0]
  const mostConservative = thresholdSweep[thresholdSweep.length - 1]
  const costOf = (s: BenchmarkReport['thresholdSweep'][number]) =>
    s.totalInputTokens + s.summaryInputTokens
  const costDeltaPct = round(
    ((costOf(best) - costOf(lowest)) / Math.max(1, costOf(lowest))) * 100,
    3
  )
  const peakReductionPct = round(
    (1 -
      best.peakUncoveredTokens /
        Math.max(1, mostConservative.peakUncoveredTokens)) *
      100,
    1
  )

  const aggressiveComparison =
    best.threshold === lowest.threshold
      ? `它本身就是被测阈值里最激进的一个（更低的阈值需要重跑扫描），且稳定态间隔 ${best.compactionIntervalTurns} 轮仍在红线之上`
      : `比更激进的 ${lowest.threshold}（每 ${lowest.compactionIntervalTurns} 轮一次、盲区峰值 ${lowest.peakUncoveredTokens}）` +
        `总 token ${costDeltaPct >= 0 ? '反而少' : '只多'} ${Math.abs(costDeltaPct)}%，` +
        `代价是盲区峰值大了 ${round((best.peakUncoveredTokens / Math.max(1, lowest.peakUncoveredTokens) - 1) * 100, 1)}%`

  const thresholdChoice =
    `默认阈值取 **${best.threshold}**。判据分两步：` +
    `① 产品红线——压缩同步发生在首 token 之前，稳定态间隔不能太短，` +
    `取"平均每 ${MIN_TURNS_PER_COMPACTION} 轮最多一次"，在本基准的每轮体量（${sweepResults[0].tokensPerTurn} token/轮）` +
    `与历史预算（${sweepResults[0].historyBudgetTokens}）下，阈值须 ≥ ${minRatio}；` +
    `② 在红线内取**盲区峰值最小**的：${best.threshold} 的间隔约 ${best.compactionIntervalTurns} 轮，` +
    `盲区峰值 ${best.peakUncoveredTokens} token（占历史预算约 ${round((best.peakUncoveredTokens / Math.max(1, sweepResults[0].historyBudgetTokens)) * 100, 1)}%）。` +
    `对比：${aggressiveComparison}；` +
    `比最保守的 ${mostConservative.threshold}（每 ${mostConservative.compactionIntervalTurns} 轮一次、盲区峰值 ${mostConservative.peakUncoveredTokens}，` +
    `占预算约 ${round((mostConservative.peakUncoveredTokens / Math.max(1, sweepResults[0].historyBudgetTokens)) * 100, 1)}%）盲区峰值小 ${peakReductionPct}%，` +
    `而总 token 只差 ${Math.abs(round(((costOf(mostConservative) - costOf(best)) / Math.max(1, costOf(best))) * 100, 3))}%——` +
    `注意成本几乎与阈值无关（摘要是增量的，每条消息只被摘要一次），所以"把阈值调高省钱"是错觉，` +
    `真正付出的是"越多旧对话暂时不可见"。`
  say(`  → ${thresholdChoice}`)
  say('')

  // ---------- 4. 冷压缩 ----------
  //
  // 必须用**确实会触发压缩**的历史规模，否则这里会静默地测出 0 —— 第一版就是这样：
  // 240 条消息在 32K 窗口下缺口还不到阈值，冷压缩根本没发生，"冷 vs 稳定态"整节变成空的。
  say('【4】冷压缩 vs 稳定态')
  const coldHistory = makeConversation(300) // 600 条消息：缺口必然远超阈值
  coldAccumulator.input = 0
  coldAccumulator.output = 0
  coldAccumulator.calls = 0
  const coldResult = await buildManagedContext({
    systemPrompt: SYSTEM_PROMPT,
    historyMessages: coldHistory,
    currentUserMessage: '继续',
    model: MODEL,
    enableThinking: false,
    enabledToolNames: [],
    summaryState: {
      summary: null,
      summaryUpdatedAt: null,
      summaryUpToMessageId: null,
    },
    compaction: {
      apiKey: 'benchmark',
      model: MODEL_ID,
      save: async () => true,
    },
    complete: async (input) => {
      const promptTokens = input.messages.reduce(
        (sum, m) => sum + 4 + estimateTokens(m.content),
        0
      )
      coldAccumulator.input += promptTokens
      const text = extractiveSummary(
        input.messages.map((m) => m.content).join('\n')
      )
      coldAccumulator.output += estimateTokens(text)
      coldAccumulator.calls += 1
      return { text, usage: null }
    },
    config: BENCH_CONFIG,
  })
  const coldWarm = {
    maxChunksPerRequest: MAX_SUMMARY_CHUNKS_PER_REQUEST,
    coldSummaryInputTokens: coldAccumulator.input,
    coldSummaryOutputTokens: coldAccumulator.output,
    coldSummaryCalls: coldAccumulator.calls,
    wasCompacted: coldResult.metrics.wasCompacted,
  }
  say(
    `  冷压缩：${coldAccumulator.calls} 次摘要调用，输入 ${coldAccumulator.input} token，输出 ${coldAccumulator.output} token` +
      `（历史 ${coldHistory.length} 条 → 压缩后上下文 ${coldResult.metrics.estimatedInputTokens} token / 保留 ${coldResult.metrics.retainedMessageCount} 条）`
  )
  say('  稳定态：0 次摘要调用，0 额外 token（后面每一轮都复用这份摘要）')
  say('')

  // ---------- 5. 保留性验证 ----------
  //
  // 用足够长的历史让压缩**真的发生**（否则就是在验证一个没跑过的分支），
  // 再检查第 1 轮的关键信息是否被摘要带到了最终上下文里。
  say('【5】语义保留验证')
  const retention: RetentionCheck[] = []
  const longHistory = makeConversation(300) // 600 条消息
  const managed = await buildManagedContext({
    systemPrompt: SYSTEM_PROMPT,
    historyMessages: longHistory,
    currentUserMessage: '我最开始告诉你的名字和项目代号是什么？',
    model: MODEL,
    enableThinking: false,
    enabledToolNames: [],
    compaction: {
      apiKey: 'benchmark',
      model: MODEL_ID,
      save: async () => true,
    },
    complete: async (input) => ({
      text: extractiveSummary(input.messages.map((m) => m.content).join('\n')),
      usage: null,
    }),
    config: BENCH_CONFIG,
  })
  const flat = managed.messages.map((m) => m.content ?? '').join('\n')

  retention.push({
    label: '压缩确实发生了（否则下面的保留性断言没有意义）',
    passed: managed.metrics.wasCompacted,
  })
  retention.push({
    label: '压缩后上下文里仍有第 1 轮的用户名「Alice」',
    passed: flat.includes('Alice'),
  })
  retention.push({
    label: '压缩后上下文里仍有项目代号「FC-6035」',
    passed: flat.includes('FC-6035'),
  })
  retention.push({
    label: '第 31 轮的实体「PostgreSQL」被保留（说明是增量合并而非覆盖）',
    passed: flat.includes('PostgreSQL'),
  })
  retention.push({
    label: '第 1 轮的原始消息本身已不在窗口里（确认信息是靠摘要活下来的）',
    passed: !managed.messages.some((m) => m.content?.includes('我叫 Alice')),
  })
  for (const check of retention) {
    say(`  ${check.passed ? '✅' : '❌'} ${check.label}`)
  }
  say('')

  // ---------- 6. 真实 API（可选） ----------
  let live: BenchmarkReport['live'] = {
    measurements: [],
    note: '未启用（加 --live 开启）',
  }
  if (options.live) {
    say('【6】真实 API 测量（会产生少量真实调用费用）')
    live = await runLiveMeasurements(options.liveRepeats)
    for (const m of live.measurements) {
      say(
        `  ${m.scenario.padEnd(44)} 估算 ${String(m.estimatedInputTokens ?? '—').padStart(6)} / 实测 ` +
          `${String(m.inputTokensReported ?? '—').padStart(6)} token  TTFT ${m.ttftMs ?? '—'} ms  TTLB ${m.ttlbMs ?? '—'} ms` +
          (m.error ? `  ⚠️ ${m.error}` : '')
      )
    }
    say(`  ${live.note}`)
    say('')
  } else {
    say('【6】真实 API 测量：未启用（`pnpm context:bench -- --live` 可开启）')
    say('')
  }

  // ---------- 输出 ----------
  const report: BenchmarkReport = {
    generatedAt: new Date().toISOString(),
    mode: options.live ? 'live' : 'offline',
    model: {
      id: MODEL.id,
      contextWindow: MODEL.contextWindow,
      outputReserve: OUTPUT_RESERVE,
    },
    estimator: TOKEN_ESTIMATOR_KIND,
    beforeImplementation:
      'buildContextMessages（整段历史）+ appendAttachments（附件全文）',
    contextConfig: {
      safetyMarginRatio: BENCH_CONFIG.safetyMarginRatio,
      compactThresholdRatio: BENCH_CONFIG.compactThresholdRatio,
      summaryMaxTokens: BENCH_CONFIG.summaryMaxTokens,
      attachmentMaxTokens: BENCH_CONFIG.attachmentMaxTokens,
      attachmentShareRatio: BENCH_CONFIG.attachmentShareRatio,
    },
    costNote:
      readEnvFile('LLM_INPUT_PRICE_PER_1M_TOKENS') === undefined
        ? '未配置 LLM_INPUT_PRICE_PER_1M_TOKENS / LLM_OUTPUT_PRICE_PER_1M_TOKENS，因此本报告只给 token 与相对降幅，不给货币金额'
        : '已配置单价，可按 token 数直接换算货币成本',
    singleTurn,
    session: { before: sessionBefore, after: sessionAfter },
    thresholdSweep,
    thresholdChoice,
    coldWarm,
    live,
    retention,
  }

  const mdPath = resolve(process.cwd(), options.outDir, 'context-benchmark.md')
  const jsonPath = resolve(
    process.cwd(),
    options.outDir,
    'context-benchmark.json'
  )
  mkdirSync(dirname(mdPath), { recursive: true })
  writeFileSync(mdPath, renderMarkdown(report), 'utf8')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')

  say('='.repeat(78))
  say('报告已写入：')
  say(`  ${mdPath}`)
  say(`  ${jsonPath}`)
  say('='.repeat(78))
}

main().catch((error) => {
  console.error('[benchmark] 失败：', error)
  process.exitCode = 1
})

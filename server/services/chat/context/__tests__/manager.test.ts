/**
 * 上下文管理器编排测试（本模块的核心用例）
 *
 * 用**极小窗口 + 显式配置**把每种路径都压到确定性的规模上，于是断言可以写精确值：
 *   contextWindowOverride = 4000 → 输出预留 1024 → 软预算 2679 / 硬上限 2976
 *   每条消息 cost = 4(包装) + 正文字数
 *
 * 关于"软预算 vs 硬上限"：规划时按软预算（已扣掉安全边际）分配各层，
 * 但窗口选择为了保住"整轮对话"允许小幅超出软预算（见 window.ts 的容差），
 * 所以**合法性断言一律对硬上限**（contextWindow - outputReserve，
 * 也就是 provider 真正会拒绝的那条线）。
 *
 * 覆盖：短对话零开销、长对话窗口化、压缩触发、摘要复用、附件超限、
 * 降级路径、消息序列合法性，以及"摘要确实保住了长期信息"的保留性验证。
 */

import { describe, expect, it } from 'vitest'
import { getModelById } from '@/shared/constants/models'
import {
  REQUEST_OVERHEAD_TOKENS,
  estimateHistoryTokens,
  estimateTokens,
} from '../tokens'
import {
  ContextBudgetExceededError,
  buildManagedContext,
  type BuildManagedContextInput,
  type ConversationSummaryState,
} from '../manager'
import { filler, makeContextConfig, makeHistory } from './fixtures'
import type { ContextHistoryMessage } from '../types'

const MODEL = getModelById('deepseek-ai/DeepSeek-V3.2')!
const SYSTEM_PROMPT = 'SYS'
const USER_MESSAGE = 'hi'

/** 极小窗口：让"长对话"在几十条消息内就发生，跑得快且数字稳定 */
const SMALL_WINDOW_CONFIG = makeContextConfig({
  contextWindowOverride: 4000,
  attachmentMaxTokens: 1000,
})

/**
 * 假摘要实现：**确定性**地"忠实合并"旧摘要与新增对话
 *
 * 这不是在假装调用模型，而是把"一个会照做的摘要器"的下界行为固化下来：
 * 提示词要求它"与已有摘要合并、不要丢失其中的信息"，这个桩就真的照做
 * （从旧摘要的对应小节里把值取出来，与新发现的值求并集）。
 *
 * 这样断言才有意义：只要管线正确（缺口内容真的进了摘要提示、分块真的带上了旧摘要、
 * 摘要真的被写回并复用），第 1 轮的名字就一定会一路活到后续请求的上下文里。
 * 任何一环断掉（缺口算错 / 水位线推错 / 分块没带旧摘要 / 摘要没落库），断言都会失败。
 */
function extractingSummarizer() {
  /** 从摘要文本里取某个小节的值（小节标题形如 `# 标题`，值在下一行） */
  function readSection(summary: string, title: string): string[] {
    const match = new RegExp(`# ${title}[^\\n]*\\n([^\\n]*)`).exec(summary)
    const value = match?.[1]?.trim()
    if (!value || value === '无') return []
    return value
      .split('、')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  return async (input: {
    messages: Array<{ role: string; content: string }>
  }): Promise<{
    text: string
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  }> => {
    const corpus = input.messages.map((message) => message.content).join('\n')
    // 上一份摘要就在本次提示的正文里（【已有摘要】段落）
    const previous =
      /【已有摘要[^\n]*】\n([\s\S]*?)\n\n【新增对话】/.exec(corpus)?.[1] ?? ''

    const names = new Set(readSection(previous, '关键实体'))
    for (const match of corpus.matchAll(
      /我叫\s*([A-Za-z\u4e00-\u9fff]{1,12})/g
    )) {
      names.add(match[1])
    }

    const facts = new Set(readSection(previous, '已确认的事实'))
    for (const match of corpus.matchAll(/事实[:：]\s*([^\n]{1,40})/g)) {
      facts.add(match[1].trim())
    }

    const decisions = new Set(readSection(previous, '已做出的决定'))
    for (const match of corpus.matchAll(/决定[:：]\s*([^\n]{1,40})/g)) {
      decisions.add(match[1].trim())
    }

    const join = (values: Set<string>) =>
      values.size ? [...values].join('、') : '无'

    return {
      text: [
        '# 用户目标',
        '继续完成多轮对话任务',
        '# 已确认的事实',
        join(facts),
        '# 关键实体（人名 / 文件名 / 编号 / 参数）',
        join(names),
        '# 用户偏好与约束（仅限用户明确说过的）',
        '无',
        '# 已做出的决定',
        join(decisions),
        '# 未解决的问题',
        '无',
        '# 工具调用得出的重要结论',
        '无',
      ].join('\n'),
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    }
  }
}

/** 构造一个把摘要"存起来"的持久化桩，模拟 ConversationRepository.saveSummary */
function makeSummaryStore(
  initial: ConversationSummaryState = {
    summary: null,
    summaryUpdatedAt: null,
    summaryUpToMessageId: null,
  }
) {
  const state: ConversationSummaryState = { ...initial }
  const saveCalls: Array<{ summary: string; watermark: string | null }> = []

  return {
    state,
    saveCalls,
    /** 当前持久化状态（下一次请求会读到的值） */
    read: (): ConversationSummaryState => ({ ...state }),
    save: async (summary: string, watermarkMessageId: string | null) => {
      saveCalls.push({ summary, watermark: watermarkMessageId })
      state.summary = summary
      state.summaryUpToMessageId = watermarkMessageId
      state.summaryUpdatedAt = new Date(
        (state.summaryUpdatedAt?.getTime() ?? 0) + 1
      )
      return true
    },
  }
}

function baseInput(
  overrides: Partial<BuildManagedContextInput> = {}
): BuildManagedContextInput {
  return {
    systemPrompt: SYSTEM_PROMPT,
    historyMessages: [],
    currentUserMessage: USER_MESSAGE,
    model: MODEL,
    enableThinking: false,
    enabledToolNames: [],
    config: SMALL_WINDOW_CONFIG,
    ...overrides,
  }
}

describe('短对话：几乎不增加开销', () => {
  it('历史完全装得下时，一条不丢、不做压缩', async () => {
    const history = makeHistory({ turns: 5, tokensPerMessage: 100 }) // 10 条 = 1040 token
    const result = await buildManagedContext(
      baseInput({ historyMessages: history })
    )

    expect(result.metrics.retainedMessageCount).toBe(history.length)
    expect(result.metrics.historyMessageCount).toBe(history.length)
    expect(result.metrics.wasCompacted).toBe(false)
    expect(result.metrics.wasTruncated).toBe(false)
    expect(result.metrics.fallback).toBe('none')

    // 消息序列：system → 全部历史 → 当前用户消息
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: SYSTEM_PROMPT,
    })
    expect(result.messages).toHaveLength(history.length + 2)
    expect(result.messages.at(-1)?.role).toBe('user')
  })

  it('没有启用工具时不为工具轮次预留（不白吃历史预算）', async () => {
    const result = await buildManagedContext(baseInput())
    expect(result.metrics.toolReserveTokens).toBe(0)
    expect(result.metrics.ragReserveTokens).toBe(0)
  })

  it('启用知识库时单独为 RAG 预留，且不混进历史预算', async () => {
    const result = await buildManagedContext(
      baseInput({ enabledToolNames: ['knowledge_search', 'generate_image'] })
    )
    expect(result.metrics.ragReserveTokens).toBeGreaterThan(0)
    // generate_image 的结果只是一句话，不占预留
    expect(result.metrics.toolReserveTokens).toBe(
      result.metrics.ragReserveTokens
    )
  })
})

describe('长对话：窗口化 + 压缩', () => {
  it('历史超预算时只保留最近窗口，窗口以 user 开头', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 }) // 80 条 = 8320 token
    const result = await buildManagedContext(
      baseInput({ historyMessages: history })
    )

    expect(result.metrics.retainedMessageCount).toBeLessThan(history.length)
    expect(result.metrics.wasCompacted).toBe(false) // 没提供压缩能力就只做窗口截断
    expect(result.messages[1].role).toBe('user')
    expect(result.messages.at(-2)?.role).toBe('assistant')
    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
  })

  it('缺口超过阈值时触发压缩，摘要以 system 角色注入且带说明', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: {
          apiKey: 'sk-test',
          model: 'test-model',
          save: store.save,
        },
        complete: extractingSummarizer(),
      })
    )

    expect(result.metrics.wasCompacted).toBe(true)
    expect(result.summaryPersisted).toBe(true)
    expect(store.saveCalls).toHaveLength(1)

    // 摘要是 system 角色，且明确说明"这不是逐字原文"
    expect(result.messages[1].role).toBe('system')
    expect(result.messages[1].content).toContain('【历史对话摘要】')
    expect(result.messages[1].content).toContain('不是逐字原文')
    expect(result.messages[1].content).toContain('# 用户目标')
  })

  it('压缩后总输入仍在硬上限内，且历史占用 = 摘要 + 最近窗口', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        complete: extractingSummarizer(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
      })
    )

    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
    expect(result.metrics.summaryTokens).toBeGreaterThan(0)
    expect(result.metrics.historyTokens).toBe(
      result.metrics.summaryTokens + result.metrics.recentMessageTokens
    )
  })

  it('水位线推进到本次真正并入摘要的最后一条消息（且落在窗口起点之前）', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        complete: extractingSummarizer(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
      })
    )

    const watermark = store.saveCalls[0].watermark
    expect(watermark).not.toBeNull()

    const watermarkIndex = history.findIndex(
      (message) => message.id === watermark
    )
    expect(watermarkIndex).toBeGreaterThanOrEqual(0)
    // 水位线必须早于窗口起点，否则中间那段历史既没进摘要也没进窗口（永久丢失）
    expect(watermarkIndex).toBeLessThan(
      history.length - result.metrics.retainedMessageCount
    )
  })
})

describe('摘要复用：稳定态不重复产生摘要成本', () => {
  it('已有摘要且缺口未超阈值时，不再调用摘要模型', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    // 构造"上一轮已经压缩到 index 54"的状态
    const store = makeSummaryStore({
      summary: '# 用户目标\n继续完成任务',
      summaryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      summaryUpToMessageId: history[54].id!,
    })

    let summarizerCalls = 0
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
        complete: async () => {
          summarizerCalls++
          return { text: '不应被调用', usage: null }
        },
      })
    )

    expect(summarizerCalls).toBe(0)
    expect(result.metrics.wasCompacted).toBe(false)
    expect(result.metrics.summaryReused).toBe(true)
    expect(result.metrics.summaryTokens).toBeGreaterThan(0)
  })

  it('复用摘要时窗口预算要给摘要让位（不会两者相加超出硬上限）', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore({
      summary: filler(300),
      summaryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      summaryUpToMessageId: history[54].id!,
    })

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
        complete: async () => ({ text: 'x', usage: null }),
      })
    )

    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
  })

  it('CAS 失败（并发压缩输给别人）时本次仍可用内存摘要，不报错', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: async () => false },
        complete: extractingSummarizer(),
      })
    )

    expect(result.summaryPersisted).toBe(false)
    expect(result.metrics.wasCompacted).toBe(true)
    expect(result.messages[1].content).toContain('【历史对话摘要】')
  })
})

describe('保留性验证：摘要确实保住了长期信息（确定性断言）', () => {
  it('第 1 轮说的名字，在压缩后与后续轮次里都仍然出现在上下文中', async () => {
    // 第 1 轮：用户自报姓名
    const history: ContextHistoryMessage[] = [
      { id: 'm-0', role: 'user', content: '我叫 Alice' },
      { id: 'm-1', role: 'assistant', content: filler(100) },
    ]
    // 第 2~40 轮：无关的长对话，把第 1 轮挤出窗口
    for (let turn = 1; turn < 40; turn++) {
      history.push({ id: `m-${turn * 2}`, role: 'user', content: filler(100) })
      history.push({
        id: `m-${turn * 2 + 1}`,
        role: 'assistant',
        content: `${filler(100)}事实: 数据库使用 PostgreSQL`,
      })
    }

    const store = makeSummaryStore()
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        complete: extractingSummarizer(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
      })
    )

    const flattened = result.messages
      .map((message) => message.content ?? '')
      .join('\n')

    // 压缩确实发生了，而且第 1 轮确实已经不在窗口里
    expect(result.metrics.wasCompacted).toBe(true)
    expect(result.metrics.retainedMessageCount).toBeLessThan(history.length)

    // 但摘要把它带过来了 —— 这就是"长期语义没有丢"的证据
    expect(store.saveCalls[0].summary).toContain('Alice')
    expect(flattened).toContain('Alice')
    expect(flattened).toContain('PostgreSQL')

    // 再来一轮：复用持久化摘要，Alice 仍在上下文里（证明缓存真的生效）
    const second = await buildManagedContext(
      baseInput({
        historyMessages: [
          ...history,
          { id: 'm-new', role: 'user', content: '我最开始说的名字是什么？' },
        ],
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
        complete: extractingSummarizer(),
      })
    )
    expect(second.metrics.summaryReused).toBe(true)
    expect(
      second.messages.map((message) => message.content ?? '').join('\n')
    ).toContain('Alice')
  })
})

describe('附件预算', () => {
  it('超大附件被压到附件预算内，并留下省略标记', async () => {
    const result = await buildManagedContext(
      baseInput({
        attachments: [
          {
            name: 'huge.txt',
            content: filler(50000),
            type: 'txt',
            size: 150000,
          },
        ],
      })
    )

    expect(result.metrics.attachmentTokens).toBeLessThanOrEqual(1000)
    expect(result.metrics.wasTruncated).toBe(true)
    const userMessage = result.messages.at(-1)!.content ?? ''
    expect(userMessage).toContain('**附件: huge.txt**')
    expect(userMessage).toContain('已省略')
    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
  })

  it('小附件不被改动（原文全量进入上下文）', async () => {
    const result = await buildManagedContext(
      baseInput({
        attachments: [
          { name: 'a.txt', content: '短内容', type: 'txt', size: 9 },
        ],
      })
    )
    expect(result.metrics.wasTruncated).toBe(false)
    expect(result.metrics.droppedAttachmentCount).toBe(0)
    expect(result.messages.at(-1)!.content).toContain('短内容')
  })

  it('附件吃掉空间后历史窗口相应变小（不会两者都按满预算发）', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const withoutAttachment = await buildManagedContext(
      baseInput({ historyMessages: history })
    )
    const withAttachment = await buildManagedContext(
      baseInput({
        historyMessages: history,
        attachments: [
          { name: 'big.txt', content: filler(900), type: 'txt', size: 2700 },
        ],
      })
    )

    expect(withAttachment.metrics.retainedMessageCount).toBeLessThanOrEqual(
      withoutAttachment.metrics.retainedMessageCount
    )
  })
})

describe('降级路径', () => {
  it('单条用户消息就超过窗口时，确定性截断并如实标记', async () => {
    const result = await buildManagedContext(
      baseInput({
        historyMessages: makeHistory({ turns: 40, tokensPerMessage: 100 }),
        currentUserMessage: filler(50000),
      })
    )

    expect(result.metrics.fallback).toBe('truncated-user-message')
    expect(result.metrics.wasTruncated).toBe(true)
    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
    const userMessage = result.messages.at(-1)!.content ?? ''
    expect(userMessage).toContain('已省略')
    expect(estimateTokens(userMessage)).toBeLessThan(50000)
  })

  it('降级上下文只保留 system + 摘要 + 当前消息（供 provider 仍报超窗时重试一次）', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore({
      summary: '# 用户目标\n继续',
      summaryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      summaryUpToMessageId: history[54].id!,
    })

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
      })
    )

    expect(result.degradedMessages).toHaveLength(3)
    expect(result.degradedMessages[0].role).toBe('system')
    expect(result.degradedMessages[1].content).toContain('【历史对话摘要】')
    expect(result.degradedMessages[2].role).toBe('user')
  })

  it('无法降级（system prompt 自己就超窗）时抛出可操作的错误', async () => {
    await expect(
      buildManagedContext(baseInput({ systemPrompt: filler(20000) }))
    ).rejects.toBeInstanceOf(ContextBudgetExceededError)
  })

  it('用户取消时不触发压缩，也不写任何摘要', async () => {
    const controller = new AbortController()
    controller.abort()
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        cancelSignal: controller.signal,
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
        complete: async () => {
          throw new Error('不应被调用')
        },
      })
    )

    expect(store.saveCalls).toHaveLength(0)
    expect(result.metrics.wasCompacted).toBe(false)
    // 取消后仍然给出一个合法的（窗口化）上下文，让上层自行决定是否继续
    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
  })

  it('摘要失败时退回窗口截断，聊天不受影响', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()

    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
        complete: async () => {
          throw new Error('SiliconFlow API error: 500')
        },
      })
    )

    expect(result.metrics.compactionFailed).toBe(true)
    expect(result.metrics.wasCompacted).toBe(false)
    expect(result.metrics.fallback).toBe('none')
    expect(result.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      result.metrics.hardInputLimitTokens
    )
    // 仍然给了模型一个可用的窗口
    expect(result.metrics.retainedMessageCount).toBeGreaterThan(0)
  })
})

describe('消息序列合法性', () => {
  it('始终以 system 开头、以 user 结尾', async () => {
    const history = makeHistory({ turns: 40, tokensPerMessage: 100 })
    const store = makeSummaryStore()
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        summaryState: store.read(),
        complete: extractingSummarizer(),
        compaction: { apiKey: 'sk', model: 'm', save: store.save },
      })
    )

    expect(result.messages[0].role).toBe('system')
    expect(result.messages.at(-1)!.role).toBe('user')
  })

  it('窗口内不出现孤立 tool 消息（history 里混入 tool 时也不能以它开头）', async () => {
    const history: ContextHistoryMessage[] = []
    for (let i = 0; i < 40; i++) {
      history.push({ id: `u-${i}`, role: 'user', content: filler(100) })
      history.push({ id: `a-${i}`, role: 'assistant', content: null })
      history.push({ id: `t-${i}`, role: 'tool', content: filler(20) })
    }

    const result = await buildManagedContext(
      baseInput({ historyMessages: history })
    )
    expect(result.messages[1].role).toBe('user')
  })

  it('历史里的 toolCalls / 附件不会被回放（与改造前语义一致）', async () => {
    const history: ContextHistoryMessage[] = [
      { id: '1', role: 'user', content: '问题' },
      { id: '2', role: 'assistant', content: '答案' },
    ]
    const result = await buildManagedContext(
      baseInput({ historyMessages: history })
    )

    for (const message of result.messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'role'])
    }
  })
})

describe('metrics 完整性', () => {
  it('每次构建都给出全部必需字段', async () => {
    const history = makeHistory({ turns: 10, tokensPerMessage: 100 })
    const result = await buildManagedContext(
      baseInput({ historyMessages: history })
    )
    const metrics = result.metrics

    for (const key of [
      'contextWindow',
      'estimatedInputTokens',
      'historyTokens',
      'summaryTokens',
      'recentMessageTokens',
      'attachmentTokens',
      'ragReserveTokens',
      'toolReserveTokens',
      'outputReserveTokens',
      'historyMessageCount',
      'retainedMessageCount',
      'wasCompacted',
      'wasTruncated',
    ] as const) {
      expect(metrics[key]).toBeDefined()
    }

    expect(metrics.estimator).toBe('conservative-heuristic')
    expect(metrics.buildDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('未配置单价时 estimatedInputCost 为 null（不编造价格）', async () => {
    const result = await buildManagedContext(baseInput())
    expect(result.metrics.estimatedInputCost).toBeNull()
  })

  it('配置了输入单价时按估算输入 token 换算成本', async () => {
    const result = await buildManagedContext(
      baseInput({
        config: { ...SMALL_WINDOW_CONFIG, inputPricePer1MTokens: 3 },
      })
    )
    const expected = (result.metrics.estimatedInputTokens / 1_000_000) * 3
    expect(result.metrics.estimatedInputCost).toBeCloseTo(expected, 10)
  })

  it('minRecentUserTurns 真的接到了窗口选择上（不是死配置）', async () => {
    // 构造一个"朴素窗口只装得下很少几条"的历史：最后一轮用户粘了一大段文档。
    // 这种形状下"至少保留 N 个用户轮次"才会真正起作用——
    // 如果历史都是等长小消息，窗口本来就含十几轮，把下限从 1 提到 3 是看不出任何差别的
    //（第一版测试就是这么写的，结果是假通过）。
    const history: ContextHistoryMessage[] = []
    for (let t = 0; t < 10; t++) {
      history.push({ id: `u-${t}`, role: 'user', content: filler(100) })
      history.push({ id: `a-${t}`, role: 'assistant', content: filler(100) })
    }
    history.push({ id: 'u-big', role: 'user', content: filler(2400) })
    history.push({ id: 'a-big', role: 'assistant', content: '好的' })

    const countRetainedUsers = (messages: Array<{ role: string }>) =>
      messages.slice(1, -1).filter((m) => m.role === 'user').length

    const one = await buildManagedContext(
      baseInput({
        historyMessages: history,
        config: { ...SMALL_WINDOW_CONFIG, minRecentUserTurns: 1 },
      })
    )
    const three = await buildManagedContext(
      baseInput({
        historyMessages: history,
        config: { ...SMALL_WINDOW_CONFIG, minRecentUserTurns: 3 },
      })
    )

    expect(countRetainedUsers(one.messages)).toBe(2)
    expect(countRetainedUsers(three.messages)).toBe(3)
    expect(three.metrics.retainedMessageCount).toBeGreaterThan(
      one.metrics.retainedMessageCount
    )
    // 即使为了凑够轮次向前扩，也绝不能突破硬上限
    expect(three.metrics.estimatedInputTokens).toBeLessThanOrEqual(
      three.metrics.hardInputLimitTokens
    )
  })

  it('估算输入 = 实际下发消息的逐条合计 + 固定开销（口径自洽）', async () => {
    const history = makeHistory({ turns: 10, tokensPerMessage: 100 })
    const result = await buildManagedContext(
      baseInput({
        historyMessages: history,
        attachments: [
          { name: 'a.txt', content: '附件内容', type: 'txt', size: 12 },
        ],
      })
    )

    // 独立地把最终消息数组重算一遍：必须与 metrics 报出的估算值逐 token 对上，
    // 否则说明"报出来的指标"与"真正发出去的内容"已经不是同一个东西。
    expect(
      estimateHistoryTokens(result.messages).total + REQUEST_OVERHEAD_TOKENS
    ).toBe(result.metrics.estimatedInputTokens)
  })
})

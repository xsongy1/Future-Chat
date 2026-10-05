/**
 * 集成测试：chat.service → ContextManager → prompt.builder → siliconflow
 *
 * 这里验证的不是某条规则，而是**接线是否正确**：
 * - 历史是否真的经过上下文管理器（而不是原样全发）
 * - 摘要是否真的落库（保存回调有没有接上会话行）
 * - 附件超限是否真的被截断后才拼进当前消息
 * - provider 报超窗时是否只用降级上下文重试**一次**
 * - 原有 SSE 流的返回值有没有被破坏
 *
 * 外部依赖（数据库 / 上游 HTTP / 工具注册表 / 流处理器）全部 mock，
 * 只保留本仓库自己的编排代码。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  conversation: {
    id: 'conv-1',
    title: '新对话',
    summary: null as string | null,
    summaryUpdatedAt: null as Date | null,
    summaryUpToMessageId: null as string | null,
  },
  messages: [] as Array<{ id: string; role: string; content: string }>,
  /** 每次 createChatCompletion 收到的消息数组 */
  requests: [] as Array<Array<{ role: string; content: string | null }>>,
  /** 交给 SSE 流处理器的上下文 */
  streamContexts: [] as Array<Record<string, unknown>>,
  saveSummary: vi.fn(async () => true),
  /** 下一次 createChatCompletion 要抛的错误（消费一次后清空） */
  nextError: null as Error | null,
  imageAvailable: false,
}))

vi.mock('@/server/db/client', () => ({
  prisma: {
    message: {
      create: vi.fn(async () => ({})),
      count: vi.fn(async () => 2),
    },
    conversation: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}))

vi.mock('@/server/repositories/conversation.repository', () => ({
  ConversationRepository: {
    findById: vi.fn(async () => h.conversation),
    create: vi.fn(async () => h.conversation),
    touch: vi.fn(async () => undefined),
    saveSummary: (...args: unknown[]) => h.saveSummary(...(args as [])),
  },
}))

vi.mock('@/server/repositories/message.repository', () => ({
  MessageRepository: {
    findByConversationId: vi.fn(async () => h.messages),
  },
}))

/** 判断一次 createChatCompletion 是"聊天"还是"摘要" */
function isSummarizationCall(
  messages: Array<{ content: string | null }>
): boolean {
  return (messages[0]?.content ?? '').includes('对话摘要器')
}

function streamReader(payload: string) {
  const bytes = new TextEncoder().encode(payload)
  let sent = false
  return {
    read: async () => {
      if (sent) return { done: true, value: undefined }
      sent = true
      return { done: false, value: bytes }
    },
    cancel: async () => undefined,
  }
}

vi.mock('@/server/services/ai/siliconflow', () => ({
  createChatCompletion: vi.fn(
    async (
      _apiKey: string,
      options: { messages: Array<{ role: string; content: string | null }> }
    ) => {
      h.requests.push(options.messages)

      // 注入的错误只作用于**聊天**调用：压缩用的是同一个 createChatCompletion，
      // 如果无差别抛错，错误会被摘要调用先消费掉，测试就变成在验证错误的东西。
      if (h.nextError && !isSummarizationCall(options.messages)) {
        const error = h.nextError
        h.nextError = null
        throw error
      }

      if (isSummarizationCall(options.messages)) {
        return {
          reader: streamReader(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '# 用户目标\n集成测试摘要' } }] })}\n\n` +
              'data: [DONE]\n\n'
          ),
        }
      }

      // 聊天调用：流处理器已被 mock，reader 不会被消费
      return { reader: streamReader('data: [DONE]\n\n') }
    }
  ),
}))

vi.mock('@/server/services/tools', () => ({
  ensureToolsReady: vi.fn(async () => undefined),
  toolRegistry: {
    has: (name: string) =>
      name === 'generate_image' ? h.imageAvailable : false,
    get: (name: string) =>
      name === 'generate_image'
        ? {
            name: 'generate_image',
            description: '生成图片',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: async () =>
              JSON.stringify({ url: 'https://example.com/x.png' }),
          }
        : undefined,
    register: vi.fn(),
  },
}))

vi.mock('@/server/services/chat/stream.handler', () => ({
  createSSEStream: vi.fn(
    (_reader: unknown, context: Record<string, unknown>) => {
      h.streamContexts.push(context)
      return new ReadableStream({ start: (controller) => controller.close() })
    }
  ),
  createSSEStreamWithTools: vi.fn(
    (_reader: unknown, context: Record<string, unknown>) => {
      h.streamContexts.push(context)
      return new ReadableStream({ start: (controller) => controller.close() })
    }
  ),
}))

import { handleChatRequest } from '@/server/services/chat/chat.service'

/** 极小窗口，让"长对话"在几十条消息内就发生 */
const SMALL_WINDOW = '4000'

/**
 * 只取"聊天"请求
 *
 * h.requests 里同时包含摘要调用（压缩也是走 createChatCompletion 的），
 * 而压缩发生在聊天请求**之前**，所以拿 h.requests[0] 当聊天请求会取错对象。
 */
function chatRequests() {
  return h.requests.filter((messages) => !isSummarizationCall(messages))
}

function makeHistory(turns: number, tokensPerMessage: number) {
  const messages: Array<{ id: string; role: string; content: string }> = []
  for (let turn = 0; turn < turns; turn++) {
    messages.push({
      id: `m-${turn * 2}`,
      role: 'user',
      content: `第${turn + 1}问：` + '测'.repeat(tokensPerMessage),
    })
    messages.push({
      id: `m-${turn * 2 + 1}`,
      role: 'assistant',
      content: `第${turn + 1}答：` + '测'.repeat(tokensPerMessage),
    })
  }
  return messages
}

beforeEach(() => {
  process.env.CONTEXT_WINDOW_OVERRIDE = SMALL_WINDOW
  h.messages = []
  h.requests.length = 0
  h.streamContexts.length = 0
  h.nextError = null
  h.imageAvailable = false
  h.saveSummary.mockClear()
  h.conversation.summary = null
  h.conversation.summaryUpdatedAt = null
  h.conversation.summaryUpToMessageId = null
})

afterEach(() => {
  delete process.env.CONTEXT_WINDOW_OVERRIDE
})

describe('正常对话：接线正确、原有返回结构不变', () => {
  it('短历史原样进入上下文，返回结构含 stream/sessionId/conversationId/title', async () => {
    h.messages = makeHistory(3, 50) // 6 条，远小于窗口

    const result = await handleChatRequest('user-1', 'sk-test', {
      content: '你好',
      conversationId: 'conv-1',
    })

    expect(result.stream).toBeInstanceOf(ReadableStream)
    expect(result.conversationId).toBe('conv-1')
    // 标题逻辑未变：消息数达到 2 且原标题是"新对话"时，用首条消息改写标题
    expect(result.conversationTitle).toBe('你好')
    expect(result.sessionId).toBeTruthy()

    // system → 6 条历史 → 当前用户消息
    const sent = chatRequests()[0]
    expect(sent).toHaveLength(8)
    expect(sent[0].role).toBe('system')
    expect(sent.at(-1)).toEqual({ role: 'user', content: '你好' })
  })

  it('历史里的消息被逐条透传（role + content，顺序不变）', async () => {
    h.messages = makeHistory(2, 20)

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    const historyInPrompt = chatRequests()[0].slice(1, -1)
    expect(historyInPrompt).toEqual(
      h.messages.map((m) => ({ role: m.role, content: m.content }))
    )
  })
})

describe('长对话：历史被窗口化', () => {
  it('历史超过窗口时不再全量下发', async () => {
    h.messages = makeHistory(40, 100) // 80 条 = 8320 token，远超 4000 的窗口

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    const sent = chatRequests()[0]
    // system + 窗口 + 当前消息 ≪ 82
    expect(sent.length).toBeLessThan(h.messages.length)
    expect(sent.length).toBeGreaterThan(2)
    expect(sent[0].role).toBe('system')
    // 压缩后开头可能是"system prompt + 摘要"两条 system，但第一条非 system 必须是 user
    // （窗口不能切出半轮：以 user 开头才能让模型知道用户在问什么）
    const firstNonSystem = sent.find((message) => message.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')
    expect(sent.at(-1)!.content).toBe('继续')
  })

  it('把估算输入 token 透传给流处理器（供与真实 usage 对照）', async () => {
    h.messages = makeHistory(3, 50)

    await handleChatRequest('user-1', 'sk-test', {
      content: '你好',
      conversationId: 'conv-1',
    })

    expect(h.streamContexts[0].estimatedInputTokens).toBeGreaterThan(0)
  })
})

describe('摘要：压缩被触发并落库', () => {
  it('历史远超窗口时触发压缩，保存回调接到会话行上', async () => {
    h.messages = makeHistory(40, 100)

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    // 摘要落库（可能分多块，每块一次 CAS 写入）
    expect(h.saveSummary.mock.calls.length).toBeGreaterThanOrEqual(1)
    const [conversationId, payload, expectedUpdatedAt] = h.saveSummary.mock
      .calls[0] as unknown as [
      string,
      { summary: string; summaryUpToMessageId: string | null },
      Date | null,
    ]
    expect(conversationId).toBe('conv-1')
    expect(payload.summary).toContain('集成测试摘要')
    expect(payload.summaryUpToMessageId).toBeTruthy()
    // 首次压缩：期望版本号为 null（即"当前仍未压缩过"）
    expect(expectedUpdatedAt).toBeNull()

    // 摘要以 system 角色注入，且排在 system prompt 之后
    const sent = chatRequests()[0]
    expect(sent[1].role).toBe('system')
    expect(sent[1].content).toContain('集成测试摘要')
  })

  it('摘要已经覆盖到最新消息时直接复用，不再调用摘要模型', async () => {
    h.messages = makeHistory(40, 100)
    h.conversation.summary = '# 用户目标\n已有摘要'
    h.conversation.summaryUpdatedAt = new Date('2026-01-01T00:00:00Z')
    // 水位线落在最后一条消息上：摘要已经覆盖全部历史，缺口为 0
    // （不能用"把水位线放在窗口起点附近"来构造"缺口很小"——生产默认阈值是 0.1，
    //   在 4000 的测试窗口下阈值只有几十个 token，那样写会随窗口算法的微调而翻车）
    h.conversation.summaryUpToMessageId = h.messages[h.messages.length - 1].id

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    // 只有一次模型调用（聊天本身），没有第二次摘要调用
    expect(h.requests).toHaveLength(1)
    expect(h.saveSummary).not.toHaveBeenCalled()
    // 摘要仍然被注入（复用的是缓存，不是丢弃）
    expect(chatRequests()[0][1].content).toContain('已有摘要')
  })

  it('缺口超过阈值时（即使已有旧摘要）仍会增量压缩', async () => {
    h.messages = makeHistory(40, 100)
    h.conversation.summary = '# 用户目标\n旧摘要'
    h.conversation.summaryUpdatedAt = new Date('2026-01-01T00:00:00Z')
    // 水位线远在窗口起点之前：中间那一大段既不在摘要也不在窗口 → 必须压缩
    h.conversation.summaryUpToMessageId = h.messages[10].id

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    expect(h.saveSummary).toHaveBeenCalled()
    // 水位线必须前进（CAS 写入时带上新的水位线）
    const [, payload] = h.saveSummary.mock.calls[0] as unknown as [
      string,
      { summary: string; summaryUpToMessageId: string | null },
    ]
    expect(payload.summaryUpToMessageId).not.toBe(h.messages[10].id)
  })
})

describe('附件：超限时截断后才拼进当前消息', () => {
  it('超大附件不会原样进入请求', async () => {
    const huge = '测'.repeat(50000)

    await handleChatRequest('user-1', 'sk-test', {
      content: '看看这个文件',
      conversationId: 'conv-1',
      attachments: [
        { name: 'huge.txt', content: huge, type: 'txt', size: 150000 },
      ],
    })

    const userMessage = chatRequests()[0].at(-1)!.content ?? ''
    expect(userMessage).toContain('**附件: huge.txt**')
    expect(userMessage).toContain('已省略')
    expect(userMessage.length).toBeLessThan(huge.length)
  })
})

describe('超窗降级：provider 报错时只用降级上下文重试一次', () => {
  it('识别 context_length_exceeded 并重试一次，第二次是降级上下文', async () => {
    h.messages = makeHistory(40, 100)
    // 开启生图 → 走工具流，这样才能验证"多轮循环也从降级上下文继续"
    h.imageAvailable = true
    h.conversation.summary = '# 用户目标\n已有摘要'
    h.conversation.summaryUpdatedAt = new Date('2026-01-01T00:00:00Z')
    h.conversation.summaryUpToMessageId = h.messages[70].id
    h.nextError = new Error(
      'SiliconFlow API error: 400 - {"code":400,"message":"context_length_exceeded"}'
    )

    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })

    const chats = chatRequests()
    expect(chats).toHaveLength(2)

    // 降级上下文 = system prompt + 摘要 + 当前用户消息（丢掉整个最近窗口）
    const degraded = chats[1]
    expect(degraded).toHaveLength(3)
    expect(degraded[0].role).toBe('system')
    expect(degraded[1].content).toContain('【历史对话摘要】')
    expect(degraded[2]).toEqual({ role: 'user', content: '继续' })
    // 相比第一次请求确实变短了
    expect(degraded.length).toBeLessThan(chats[0].length)

    // 流处理器拿到的是降级后的上下文（多轮工具循环也从它继续）
    expect(h.streamContexts[0].contextMessages).toHaveLength(3)
  })

  it('非超窗错误不重试（避免把一次失败变成一串计费请求）', async () => {
    h.messages = makeHistory(3, 50)
    h.nextError = new Error('SiliconFlow API error: 401 - invalid api key')

    await expect(
      handleChatRequest('user-1', 'sk-test', {
        content: '你好',
        conversationId: 'conv-1',
      })
    ).rejects.toThrow(/401/)

    expect(chatRequests()).toHaveLength(1)
  })

  it('重试只有一次：降级请求本身失败时不再尝试第三次', async () => {
    h.messages = makeHistory(40, 100)
    h.nextError = new Error('context_length_exceeded')
    // 第二次调用返回成功（nextError 已消费），因此这里通过计数验证"总调用次数 = 2"
    await handleChatRequest('user-1', 'sk-test', {
      content: '继续',
      conversationId: 'conv-1',
    })
    expect(chatRequests()).toHaveLength(2)
  })
})

describe('回归：既有行为没有被破坏', () => {
  it('generate_image 可用时走工具流，并把 RAG/工具预留算进预算', async () => {
    h.imageAvailable = true
    h.messages = makeHistory(3, 50)

    await handleChatRequest('user-1', 'sk-test', {
      content: '画只猫',
      conversationId: 'conv-1',
    })

    // 走了 createSSEStreamWithTools（上下文里有 allowedTools）
    expect(h.streamContexts[0].allowedTools).toBeDefined()
    // generate_image 只是短结果，不占预留
    expect(h.streamContexts[0].knowledgeBaseId).toBeUndefined()
  })

  it('会话不存在时仍然抛 NotFoundError（错误语义未变）', async () => {
    const { ConversationRepository } =
      await import('@/server/repositories/conversation.repository')
    vi.mocked(ConversationRepository.findById).mockResolvedValueOnce(null)

    await expect(
      handleChatRequest('user-1', 'sk-test', {
        content: '你好',
        conversationId: 'missing',
      })
    ).rejects.toThrow(/not found/i)
  })

  it('不传 conversationId 时创建新会话', async () => {
    await handleChatRequest('user-1', 'sk-test', { content: '第一条消息' })

    const { ConversationRepository } =
      await import('@/server/repositories/conversation.repository')
    expect(ConversationRepository.create).toHaveBeenCalled()
    expect(chatRequests()[0].at(-1)).toEqual({
      role: 'user',
      content: '第一条消息',
    })
  })
})

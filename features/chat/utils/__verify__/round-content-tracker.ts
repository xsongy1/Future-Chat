/**
 * 验证：RoundContentTracker 到底解决了什么问题？
 *
 * 方法：把【服务端最终落库的内容】和【前端流式结束时 store 里的内容】两个模型
 *       放在同一个事件时间轴上跑，逐轮对照，看它们在哪里不一致。
 *
 * 服务端模型（依据 server/services/chat/stream.handler.ts:307-420）：
 *   - thinkingContent += roundThinking        (:351  ★ 跨轮累加)
 *   - finalAnswerContent = roundAnswer        (:356  ★ 只保留【最后一轮】的 answer)
 *   - persistMessage({ thinkingContent, answerContent: processImageResults(finalAnswerContent, ...) })
 *   - 每轮都 writer.sendAnswer 全部 delta → 前端能收到所有轮的 answer
 *
 * 前端模型（依据 features/chat/services/stream-handler.ts + round-content-tracker.ts）：
 *   - answerBuffer → store.appendContent（rAF 批量）
 *   - tool_call → rounds.onToolRoundStart() → 丢弃该轮已显示的前置文本
 *   - tool_result → rounds.onToolResult()
 *
 * 运行：node --experimental-strip-types features/chat/utils/__verify__/round-content-tracker.ts
 */

import assert from 'node:assert/strict'

// ===========================================================================
// StreamBuffer（与 features/chat/utils/stream-buffer.ts 逐行一致的语义）
// ===========================================================================
class StreamBuffer {
  private buffer = ''
  private rafId: number | null = null
  private onFlush: (content: string) => void
  private scheduleRaf: (cb: () => void) => number
  private cancelRaf: (id: number) => void

  constructor(
    onFlush: (content: string) => void,
    scheduleRaf: (cb: () => void) => number,
    cancelRaf: (id: number) => void
  ) {
    this.onFlush = onFlush
    this.scheduleRaf = scheduleRaf
    this.cancelRaf = cancelRaf
  }

  append(chunk: string): void {
    this.buffer += chunk
    if (this.rafId !== null) return
    this.rafId = this.scheduleRaf(() => {
      this.flush()
      this.rafId = null
    })
  }
  private flush(): void {
    if (this.buffer) {
      this.onFlush(this.buffer)
      this.buffer = ''
    }
  }
  forceFlush(): void {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId)
      this.rafId = null
    }
    this.flush()
  }
  clear(): void {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId)
      this.rafId = null
    }
    this.buffer = ''
  }
}

// ===========================================================================
// RoundContentTracker（与 features/chat/services/round-content-tracker.ts 逐行一致）
// ===========================================================================
interface TrackerCallbacks {
  getContent: () => string
  setContent: (content: string) => void
  clearAnswerBuffer: () => void
  forceFlushAnswer: () => void
}

class RoundContentTracker {
  private roundContentStart = 0
  private pendingTools = 0
  private suppressRoundContent = false
  private callbacks: TrackerCallbacks

  constructor(callbacks: TrackerCallbacks) {
    this.callbacks = callbacks
  }

  get suppressingAnswer(): boolean {
    return this.suppressRoundContent
  }

  onToolRoundStart(): void {
    if (this.pendingTools === 0) {
      this.suppressRoundContent = true
      this.callbacks.clearAnswerBuffer()
      const currentContent = this.callbacks.getContent()
      if (currentContent.length > this.roundContentStart) {
        this.callbacks.setContent(currentContent.slice(0, this.roundContentStart))
      }
    }
    this.pendingTools++
  }

  onToolResult(): void {
    this.pendingTools = Math.max(0, this.pendingTools - 1)
    if (this.pendingTools === 0) {
      this.suppressRoundContent = false
      this.callbacks.forceFlushAnswer()
      this.roundContentStart = this.callbacks.getContent().length
    }
  }
}

// ===========================================================================
// 手动 rAF
// ===========================================================================
function installManualRaf() {
  const pending = new Map<number, () => void>()
  let nextId = 1
  return {
    scheduleRaf(cb: () => void): number {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    cancelRaf(id: number): void {
      pending.delete(id)
    },
    flushFrame(): void {
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb()
    },
  }
}

// ===========================================================================
// 前端模型
// ===========================================================================
function createClientRunner(options: { useTracker: boolean }) {
  const raf = installManualRaf()
  const message = { content: '', thinking: '' }
  const toolInvocations: Array<{ toolCallId: string; state: string }> = []

  const answerBuffer = new StreamBuffer(
    (content) => {
      message.content += content
    },
    raf.scheduleRaf,
    raf.cancelRaf
  )
  const thinkingBuffer = new StreamBuffer(
    (content) => {
      message.thinking += content
    },
    raf.scheduleRaf,
    raf.cancelRaf
  )

  const rounds = new RoundContentTracker({
    getContent: () => message.content,
    setContent: (content) => {
      message.content = content
    },
    clearAnswerBuffer: () => answerBuffer.clear(),
    forceFlushAnswer: () => answerBuffer.forceFlush(),
  })

  const log: string[] = []

  return {
    get message() {
      return message
    },
    get toolInvocations() {
      return toolInvocations
    },
    get log() {
      return log
    },
    raf,
    /** 模拟 StreamHandler.handleData 的各分支 */
    thinking(content: string) {
      thinkingBuffer.append(content)
    },
    answer(content: string) {
      // stream-handler.ts:117  —— 工具轮内丢弃 answer
      if (options.useTracker && rounds.suppressingAnswer) return
      answerBuffer.append(content)
    },
    toolCall(id: string, name: string) {
      if (options.useTracker) rounds.onToolRoundStart()
      toolInvocations.push({ toolCallId: id, state: 'running' })
      log.push(`tool_call ${name}(${id}) | content 显示到此: ${JSON.stringify(message.content)}`)
    },
    toolResult(id: string) {
      const inv = toolInvocations.find((t) => t.toolCallId === id)
      if (inv) inv.state = 'completed'
      if (options.useTracker) rounds.onToolResult()
    },
    /** 帧边界 */
    frame(label: string) {
      raf.flushFrame()
      log.push(`--- ${label} 帧结束 | content=${JSON.stringify(message.content)} | thinking=${JSON.stringify(message.thinking)}`)
    },
    /** 流自然结束：finishStream 会 forceFlush 两个 buffer */
    finish() {
      thinkingBuffer.forceFlush()
      answerBuffer.forceFlush()
      return { content: message.content, thinking: message.thinking }
    },
  }
}

// ===========================================================================
// 服务端模型：跑完多轮后的持久化结果
// ===========================================================================
function runServerModel(rounds: Array<{ thinking: string; answer: string; tools: string[] }>) {
  let thinkingContent = ''
  let finalAnswerContent = ''
  const allToolCalls: string[] = []

  for (const r of rounds) {
    thinkingContent += r.thinking // :351 跨轮累加
    if (r.tools.length === 0) {
      finalAnswerContent = r.answer // :356 只保留最后一轮的 answer
      break
    }
    allToolCalls.push(...r.tools)
    // 工具轮的 answer 被丢弃（既不累加也不赋值）
  }

  // processImageResults：无生图时基本是 trim + sanitize
  const persisted = finalAnswerContent.trim()

  return { persistedContent: persisted, persistedThinking: thinkingContent, allToolCalls }
}

// ===========================================================================
// 场景定义：一个真实的「联网搜索」多轮对话
// ===========================================================================
const scenario = [
  {
    name: '第 1 轮',
    thinking: '用户问的是最新消息，我需要联网搜索。', // 服务端 :351 累加
    answer: '', // 模型直接调工具，没有输出文本
    tools: ['web_search'],
  },
  {
    name: '第 2 轮',
    thinking: '搜索结果拿到了，我来组织答案。', // 服务端 :351 继续累加
    answer: '根据最新消息，xxx 发布了 yyy。',
    tools: [],
  },
]

console.log('='.repeat(70))
console.log('RoundContentTracker 对照验证')
console.log('='.repeat(70))

// ---------------------------------------------------------------------------
// 场景 A：有 tracker（当前实现）
// ---------------------------------------------------------------------------
function scenarioA() {
  console.log('\n### 场景 A：有 RoundContentTracker（当前实现）')
  const client = createClientRunner({ useTracker: true })

  // ---- 第 1 轮 ----
  client.thinking(scenario[0].thinking)
  client.frame('第1轮 thinking')
  // 模型没有输出 answer，直接调工具
  client.toolCall('call_1', 'web_search')
  client.toolResult('call_1')
  client.frame('第1轮 工具完成')

  // ---- 第 2 轮 ----
  client.thinking(scenario[1].thinking)
  client.frame('第2轮 thinking')
  client.answer(scenario[1].answer)
  client.frame('第2轮 answer')

  const clientFinal = client.finish()
  const server = runServerModel(scenario)

  client.log.forEach((l) => console.log('   ', l))
  console.log('   [前端 store] content :', JSON.stringify(clientFinal.content))
  console.log('   [前端 store] thinking:', JSON.stringify(clientFinal.thinking))
  console.log('   [数据库落库] content :', JSON.stringify(server.persistedContent))
  console.log('   [数据库落库] thinking:', JSON.stringify(server.persistedThinking))
  console.log(
    '   => content 一致?',
    clientFinal.content === server.persistedContent ? '✅ 一致' : '❌ 不一致'
  )
  console.log(
    '   => thinking 一致?',
    clientFinal.thinking === server.persistedThinking ? '✅ 一致' : '❌ 不一致'
  )

  assert.equal(clientFinal.content, server.persistedContent)
  assert.equal(clientFinal.thinking, server.persistedThinking)
  return { clientFinal, server }
}

// ---------------------------------------------------------------------------
// 场景 B：没有 tracker —— 复现"刷新后文本消失"
// ---------------------------------------------------------------------------
function scenarioB() {
  console.log('\n### 场景 B：没有 RoundContentTracker（假设删掉它）')
  const client = createClientRunner({ useTracker: false })

  // 这一轮模型先输出了一段前置文本，然后才决定调工具
  const round1Answer = '我需要先搜索一下最新消息。'
  client.thinking(scenario[0].thinking)
  client.answer(round1Answer) // ← 没有 tracker，直接显示
  client.frame('第1轮 answer')
  client.toolCall('call_1', 'web_search') // ← 没有 tracker，不截断、不抑制
  client.toolResult('call_1')

  client.thinking(scenario[1].thinking)
  client.answer(scenario[1].answer)
  client.frame('第2轮 answer')

  const clientFinal = client.finish()
  const server = runServerModel([
    { ...scenario[0], answer: round1Answer },
    scenario[1],
  ])

  client.log.forEach((l) => console.log('   ', l))
  console.log('   [前端 store] content :', JSON.stringify(clientFinal.content))
  console.log('   [数据库落库] content :', JSON.stringify(server.persistedContent))

  const displayed = clientFinal.content
  const persisted = server.persistedContent
  const lostPrefix = displayed.slice(0, displayed.length - persisted.length)
  console.log('   => 一致?', displayed === persisted ? '✅ 一致' : '❌ 不一致')
  console.log('   => 用户【看得见】但【刷新后消失】的部分:', JSON.stringify(lostPrefix))

  assert.notEqual(displayed, persisted)
  assert.equal(persisted, scenario[1].answer)
  assert.ok(displayed.startsWith(round1Answer))
  return { displayed, persisted, lostPrefix }
}

// ---------------------------------------------------------------------------
// 场景 C：更常见的真实形态 —— 流式途中的未 flush 文本被 clear 掉
// ---------------------------------------------------------------------------
function scenarioC() {
  console.log('\n### 场景 C：tracker 的 clearAnswerBuffer 真正拦住了什么')
  const client = createClientRunner({ useTracker: true })

  // 模型先流式输出一段文本（还在 rAF buffer 里，没进 store）
  client.answer('正在为您')
  client.answer('搜索最新')
  client.answer('消息……')
  console.log('     (此刻内容还在 answerBuffer，尚未 flush，store.content =', JSON.stringify(client.message.content), ')')

  // 工具调用到达 → tracker.onToolRoundStart() → clearAnswerBuffer()
  client.toolCall('call_1', 'web_search')
  console.log('     tool_call 后 store.content =', JSON.stringify(client.message.content), '(缓冲被丢弃，从未显示过)')

  client.toolResult('call_1')
  client.answer(scenario[1].answer)
  const clientFinal = client.finish()
  const server = runServerModel(scenario)

  client.log.forEach((l) => console.log('   ', l))
  console.log('   [前端 store] content :', JSON.stringify(clientFinal.content))
  console.log('   [数据库落库] content :', JSON.stringify(server.persistedContent))
  console.log('   => 一致?', clientFinal.content === server.persistedContent ? '✅ 一致' : '❌ 不一致')

  assert.equal(clientFinal.content, server.persistedContent)
}

// ---------------------------------------------------------------------------
// 场景 D：多工具并行（pendingTools 计数器的意义）
// ---------------------------------------------------------------------------
function scenarioD() {
  console.log('\n### 场景 D：两个工具并行，pendingTools 必须归零才恢复')
  const client = createClientRunner({ useTracker: true })

  client.thinking('需要同时搜索和生成图片。')
  client.toolCall('call_1', 'web_search')
  client.toolCall('call_2', 'generate_image') // 第 2 个工具：pendingTools 从 1 → 2
  console.log('     两个工具都在跑，suppressingAnswer 状态需保持')

  client.answer('这段文本应当被丢弃（工具还没全结束）')
  console.log('     期间到达的 answer，store.content =', JSON.stringify(client.message.content))

  client.toolResult('call_1') // pendingTools 2 → 1，仍不恢复
  console.log('     第 1 个工具返回后 store.content =', JSON.stringify(client.message.content))

  client.toolResult('call_2') // pendingTools 1 → 0，恢复显示
  client.answer('两个工具的结果都拿到了。')
  const clientFinal = client.finish()
  const server = runServerModel([
    { thinking: '需要同时搜索和生成图片。', answer: '', tools: ['web_search', 'generate_image'] },
    { thinking: '', answer: '两个工具的结果都拿到了。', tools: [] },
  ])

  console.log('   [前端 store] content :', JSON.stringify(clientFinal.content))
  console.log('   [数据库落库] content :', JSON.stringify(server.persistedContent))
  console.log('   => 一致?', clientFinal.content === server.persistedContent ? '✅ 一致' : '❌ 不一致')

  assert.equal(clientFinal.content, server.persistedContent)
  assert.equal(clientFinal.content, '两个工具的结果都拿到了。')
}

// ---------------------------------------------------------------------------
// 场景 E：图片块的位置 —— 前端现场插入 vs 服务端统一挪到最前（发现真实缺陷）
// ---------------------------------------------------------------------------
function scenarioE() {
  console.log('\n### 场景 E：生图 —— 前端插在"工具结果到达的位置"，服务端插在【文本之前】')
  const client = createClientRunner({ useTracker: true })

  const imageBlock = '```image\n{"url":"https://img/x.png","alt":"一只猫","width":512,"height":512}\n```'

  // --- E1：模型直接调生图工具，没有前置文本 ---
  console.log('\n  E1. 模型没有输出前置文本，直接调生图工具')
  client.toolCall('call_1', 'generate_image')
  client.toolResult('call_1')
  // stream-handler.ts:226 —— 注意模板字面量开头有个 \n
  client.answer(`\n${imageBlock}\n`)
  client.answer('图片已经生成好了，是一只橘猫。')
  const e1Client = client.finish()

  // 服务端 processImageResults：插到最前，并在最后 .trim()
  const e1Server = `${imageBlock}\n\n图片已经生成好了，是一只橘猫。`

  console.log('     [前端] content 开头:', JSON.stringify(e1Client.content.slice(0, 12)))
  console.log('     [落库] content 开头:', JSON.stringify(e1Server.slice(0, 12)))
  console.log('     前端以 ```image 开头?', e1Client.content.startsWith('```image'))
  console.log('     完整一致?', e1Client.content === e1Server ? '✅' : '❌')
  if (e1Client.content !== e1Server) {
    console.log(
      '     ⚠️ 差异 = 前端多一个前导换行：',
      JSON.stringify(e1Client.content.slice(0, 6)),
      'vs',
      JSON.stringify(e1Server.slice(0, 6))
    )
    console.log(
      '        原因：stream-handler.ts:226 追加的是 `\\n```image\\n${json}\\n```\\n`，')
    console.log(
      '              而服务端 processImageResults 末尾有 .trim()（message-persister.ts:113/116）'
    )
    console.log(
      '        影响：纯展示层，Markdown 渲染时前导空行会被忽略，用户几乎无感'
    )
  }

  // --- E2：模型先输出文本，再调生图工具（位置不一致） ---
  console.log('\n  E2. 模型先输出文本，再调生图工具')
  const client2 = createClientRunner({ useTracker: true })
  // 注意：如果文本是在【工具轮之前】输出的，会被 tracker 丢弃；
  // 但图片块是 tool_result 时插入的，此时 pendingTools 已归零、suppressingAnswer 已恢复，
  // 所以图片块本身【不会】被丢弃。
  client2.answer('好的，我来生成。') // 第 1 轮的前置文本
  client2.toolCall('call_2', 'generate_image') // onToolRoundStart → 截断上面的文本
  client2.toolResult('call_2') // onToolResult → pendingTools 归零
  client2.answer(`\n${imageBlock}\n`) // 图片块此刻插入（截断之后，不会被丢）
  client2.answer('图片已经生成好了。')
  const e2Client = client2.finish()
  const e2Server = `${imageBlock}\n\n图片已经生成好了。`

  console.log('     [前端] content :', JSON.stringify(e2Client.content.slice(0, 40)) + '...')
  console.log('     [落库] content :', JSON.stringify(e2Server.slice(0, 40)) + '...')
  console.log('     => 图片位置一致?', e2Client.content.trim() === e2Server ? '✅' : '❌')
  console.log('     说明：前置文本"好的，我来生成。"已被 tracker 截断（两侧都没有）✅')

  assert.ok(!e2Client.content.includes('好的，我来生成。'), '前置文本应被截断')

  return { e1Consistent: e1Client.content === e1Server }
}

// ---------------------------------------------------------------------------
console.log('\n场景 A：有 tracker')
scenarioA()
scenarioB()
scenarioC()
scenarioD()
const e = scenarioE()

console.log('\n' + '='.repeat(70))
console.log('全部断言通过 ✅')
console.log('='.repeat(70))
console.log('\n结论摘要：')
console.log('  A. 有 tracker 时：前端 store 与数据库落库内容完全一致')
console.log('  B. 无 tracker 时：前端多显示一段前置文本，刷新后消失')
console.log('  C. tracker 的 clearAnswerBuffer 会丢弃【尚未 flush】的工具轮前置文本')
console.log('  D. pendingTools 计数器保证多工具并行期间不提前恢复显示')
console.log(
  '  E. 生图场景：内容位置被"图片插到文本之前"的约定对齐，',
  e.e1Consistent ? '但存在一个前导换行差异（纯展示层）' : '存在前导换行差异'
)

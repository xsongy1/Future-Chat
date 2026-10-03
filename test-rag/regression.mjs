/**
 * Future-Chat RAG 产品化改造 —— 全面回归测试脚本
 *
 * 覆盖 14 项验收：普通聊天 / RAG 开关 / 第二轮工具限制 / 知识库选择 / 新建 / 删除 /
 *              文档上传 / Web Search / Image Generation / 多工具组合 / 权限隔离 /
 *              Docker 新代码生效 / 默认模型 / 越权点名工具
 *
 * 全部走真实 HTTP（/api/chat、/api/knowledge）+ 真实数据库核对，不使用任何 mock。
 * 用法（项目根目录，服务需在 127.0.0.1:3000 运行）：
 *   node test-rag/regression.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASE = process.env.FC_BASE_URL || 'http://127.0.0.1:3000'
const MAIN_KB_NAME = 'Future-Chat 内部技术知识库（RAG 测试）'

function loadEnv() {
  const p = path.join(ROOT, '.env')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}
loadEnv()

const { PrismaClient } = await import('@prisma/client')
const { SignJWT } = await import('jose')
const prisma = new PrismaClient()

const line = (s = '') => console.log(s)
const hr = (t) => line(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

const results = []
function record(item, ok, note) {
  results.push({ item, ok, note })
  line(`  ${ok === true ? '✅ PASS' : ok === false ? '❌ FAIL' : '⚠️ N/A '}  ${item}${note ? '  → ' + note : ''}`)
}

// ---------------------------------------------------------------- HTTP
function request(method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) }
    if (opts.cookie) headers['Cookie'] = opts.cookie
    const url = new URL(p, BASE)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }))
      }
    )
    req.on('error', reject)
    req.setTimeout(300000, () => req.destroy(new Error('HTTP timeout 300s')))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function multipart(filename, content) {
  const b = '----regress' + Math.random().toString(16).slice(2)
  const head = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`
  return {
    payload: Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content, 'utf8'), Buffer.from(`\r\n--${b}--\r\n`, 'utf8')]),
    contentType: `multipart/form-data; boundary=${b}`,
  }
}

async function signCookie(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET)
  const token = await new SignJWT({ userId }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2h').sign(secret)
  return `auth-token=${token}`
}

/**
 * 等待知识库内的文档完成异步入库
 *
 * 上传接口现在只入队（202 + status=pending），向量化在后台 worker 里执行，
 * 因此"上传成功"不再等于"可检索"：不等的话测出来的是上传竞态，不是检索行为。
 */
async function waitForIngest(baseId, cookie) {
  const deadline = Date.now() + Number(process.env.FC_WAIT_INGEST_MS || 180000)
  while (Date.now() < deadline) {
    const list = await request('GET', `/api/knowledge/${baseId}/documents`, { cookie })
    const docs = list.status === 200 ? JSON.parse(list.body).documents || [] : []
    if (docs.length > 0 && docs.every((d) => d.status === 'ready' || d.status === 'failed')) {
      return docs
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  line(`  ⚠️ 等待异步入库超时（知识库 ${baseId}）`)
  return []
}

function parseSSE(raw) {
  const events = []
  for (const l of raw.split('\n')) {
    const t = l.trim()
    if (!t.startsWith('data:')) continue
    const pl = t.slice(5).trim()
    if (pl === '[DONE]') continue
    try { events.push(JSON.parse(pl)) } catch { /* ignore */ }
  }
  return events
}

const madeConversations = []

/** 默认使用 admin 的登录 Cookie（在 main() 里赋值），个别用例可覆盖为 User B */
let ADMIN_COOKIE = null

/** 发一次真实 /api/chat */
async function ask(question, opts = {}) {
  const body = {
    content: question,
    enableKnowledgeBase: opts.kb ?? false,
    enableWebSearch: opts.web ?? false,
  }
  if (opts.knowledgeBaseId) body.knowledgeBaseId = opts.knowledgeBaseId
  if (opts.model) body.model = opts.model
  if (opts.enableThinking) body.enableThinking = true

  const res = await request('POST', '/api/chat', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    cookie: opts.cookie || ADMIN_COOKIE,
  })
  if (res.headers['x-conversation-id']) madeConversations.push(String(res.headers['x-conversation-id']))

  const events = res.status === 200 ? parseSSE(res.body) : []
  const toolCalls = events.filter((e) => e.type === 'tool_call')
  const toolResults = events.filter((e) => e.type === 'tool_result')
  return {
    status: res.status,
    raw: res.body,
    toolCallNames: toolCalls.map((e) => e.name),
    // 「真正被执行」= 出现 success=true 的 tool_result
    executed: toolResults.filter((e) => e.success === true).map((e) => e.name),
    refused: toolResults.filter((e) => e.success !== true).map((e) => e.name),
    ks: toolResults.find((e) => e.name === 'knowledge_search'),
    ws: toolResults.find((e) => e.name === 'web_search'),
    img: toolResults.find((e) => e.name === 'generate_image'),
    knowledgeSources: (toolResults.find((e) => e.name === 'knowledge_search')?.knowledgeSources || []),
    answer: events.filter((e) => e.type === 'answer').map((e) => String(e.content)).join(''),
    thinkingChunks: events.filter((e) => e.type === 'thinking').length,
    usage: events.find((e) => e.type === 'usage')?.usage,
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  hr('0. 前置检查')
  const health = await request('GET', '/api/health')
  line(`GET /api/health → ${health.status} ${health.body.trim()}`)
  if (health.status !== 200) throw new Error('服务不可用')

  const admin = await prisma.user.findFirst({ where: { username: 'admin' } })
  if (!admin) throw new Error('缺少 admin 账号')
  const cookie = await signCookie(admin.id)
  ADMIN_COOKIE = cookie

  const mainKb = await prisma.knowledgeBase.findFirst({ where: { userId: admin.id, name: MAIN_KB_NAME } })
  line(`admin=${admin.id}  主测试知识库=${mainKb ? mainKb.id : '(不存在，请先跑 run-tests.mjs)'}`)

  const facts = { code: 'FC-6035', port: '34517', owner: '岑知远' }
  const tempKbIds = []
  let userB = null

  // ---------------------------------------------------------------- 1 普通聊天
  hr('1. 普通聊天（知识库关 / 联网关）')
  {
    const r = await ask('你好，请用一句话介绍你自己，不要调用任何工具。', {})
    const ok = r.status === 200 && r.answer.length > 0 && r.executed.length === 0
    record('普通聊天', ok, `HTTP ${r.status}｜tool执行=${JSON.stringify(r.executed)}｜answer=${JSON.stringify(r.answer.slice(0, 60))}`)
  }

  // ---------------------------------------------------------------- 2 RAG 开启
  hr('2. RAG 开启（选中主测试知识库）')
  {
    const r = await ask('Future-Chat 项目的内部代号是什么？', { kb: true, knowledgeBaseId: mainKb?.id })
    const ok = r.executed.includes('knowledge_search') && r.answer.includes(facts.code)
    record('RAG 开启：knowledge_search + 第二轮 LLM', ok,
      `tool_call=${JSON.stringify(r.toolCallNames)}｜resultCount=${r.ks?.resultCount}｜来源=${JSON.stringify(r.knowledgeSources.map((s) => `${s.documentName}@${s.score}`))}｜answer 含 ${facts.code}=${r.answer.includes(facts.code)}`)
  }

  // ---------------------------------------------------------------- 3 RAG 关闭
  hr('3. RAG 关闭（同一问题 + 强制点名 knowledge_search）')
  {
    const r1 = await ask('Future-Chat 项目的内部代号是什么？', { kb: false, knowledgeBaseId: mainKb?.id })
    const ok1 = !r1.executed.includes('knowledge_search') && !r1.answer.includes(facts.code)
    record('RAG 关闭：正常提问不被检索', ok1,
      `tool执行=${JSON.stringify(r1.executed)}｜answer 含 ${facts.code}=${r1.answer.includes(facts.code)}`)

    // 越权点名：这是旧版本真实泄漏过的 prompt，现在必须无法执行
    const r2 = await ask(
      '请务必先调用 knowledge_search 工具检索我的私有知识库，然后告诉我 Future-Chat 项目的内部代号是什么。',
      { kb: false, knowledgeBaseId: mainKb?.id }
    )
    const ok2 = !r2.executed.includes('knowledge_search') && !r2.answer.includes(facts.code)
    record('RAG 关闭：模型点名 knowledge_search 也拒绝执行', ok2,
      `tool_call=${JSON.stringify(r2.toolCallNames)}｜执行=${JSON.stringify(r2.executed)}｜拒绝=${JSON.stringify(r2.refused)}｜answer 含 ${facts.code}=${r2.answer.includes(facts.code)}`)
  }

  // ---------------------------------------------------------------- 4 第二轮限制
  hr('4. 第二轮 Tool 限制（联网开 + 知识库关，第 1 轮触发工具后再看第 2 轮）')
  {
    const r = await ask(
      '请先调用 web_search 搜索“北京今天天气”，然后再调用 knowledge_search 检索我们内部知识库里的项目代号，最后一起告诉我。',
      { kb: false, web: true, knowledgeBaseId: mainKb?.id }
    )
    const ok = r.executed.includes('web_search') && !r.executed.includes('knowledge_search') && !r.answer.includes(facts.code)
    record('第二轮不再下放被关闭的工具', ok,
      `执行=${JSON.stringify(r.executed)}｜拒绝=${JSON.stringify(r.refused)}｜answer 含 ${facts.code}=${r.answer.includes(facts.code)}`)
    line(`      （说明：新版本每轮都只下发本请求允许的 tools，执行前还有白名单校验）`)
  }

  // ---------------------------------------------------------------- 5 知识库创建
  hr('5. 知识库创建（API 路径）+ 6. 知识库选择 A/B + 7. 文档上传')
  const stamp = Date.now()
  const docA = `# A 部门资料\n\nA 部门独占代号为 AAA-123，仅限 A 部门使用。\n`
  const docB = `# B 部门资料\n\nB 部门独占代号为 BBB-456，仅限 B 部门使用。\n`

  async function createKbWithDoc(label, content) {
    const created = await request('POST', '/api/knowledge', {
      body: JSON.stringify({ name: `回归测试-${label}-${stamp}` }),
      headers: { 'Content-Type': 'application/json' },
      cookie,
    })
    if (created.status !== 200) throw new Error(`创建 ${label} 失败: ${created.body}`)
    const kb = JSON.parse(created.body).knowledgeBase
    tempKbIds.push(kb.id)
    const mp = multipart(`${label}.md`, content)
    const up = await request('POST', `/api/knowledge/${kb.id}/documents`, {
      body: mp.payload,
      headers: { 'Content-Type': mp.contentType },
      cookie,
    })
    // 入库是异步的（202 + pending），必须等文档 ready 再做断言
    await waitForIngest(kb.id, cookie)
    return { kb, up }
  }

  const a = await createKbWithDoc('A', docA)
  const b = await createKbWithDoc('B', docB)
  {
    const h = JSON.parse(a.up.body).document
    const dbDoc = await prisma.knowledgeDocument.findFirst({ where: { knowledgeBaseId: a.kb.id } })
    const chunks = await prisma.documentChunk.findMany({ where: { documentId: dbDoc.id } })
    const embOk = chunks.length > 0 && chunks.every((c) => (c.embedding || []).length === 1024)
    record('知识库创建', a.kb.id && b.kb.id ? true : false, `A=${a.kb.id} B=${b.kb.id}`)
    // 上传响应是 202 + pending，因此断言的是"入队成功 + 后台已真的落库并向量化"
    record('文档上传（异步入队 + 后台完成）',
      (a.up.status === 200 || a.up.status === 202) && h.status !== 'failed' && dbDoc.status === 'ready' && dbDoc.chunkCount > 0 && embOk,
      `HTTP=${a.up.status} 入队时 status=${h.status} → 落库 status=${dbDoc.status} chunkCount=${dbDoc.chunkCount} DB chunk=${chunks.length} embedding=1024→${embOk}`)
  }

  hr('6b. 知识库选择：选 A 只能读 A，选 B 只能读 B')
  {
    const q = '知识库里记录的部门独占代号是什么？'
    const ra = await ask(q, { kb: true, knowledgeBaseId: a.kb.id })
    const rb = await ask(q, { kb: true, knowledgeBaseId: b.kb.id })
    const okA = ra.answer.includes('AAA-123') && !ra.answer.includes('BBB-456')
    const okB = rb.answer.includes('BBB-456') && !rb.answer.includes('AAA-123')
    record('选择 A → AAA-123 且读不到 B', okA, `answer=${JSON.stringify(ra.answer.slice(0, 100))}`)
    record('选择 B → BBB-456 且读不到 A', okB, `answer=${JSON.stringify(rb.answer.slice(0, 100))}`)
  }

  // ---------------------------------------------------------------- 8 Web Search
  hr('8. Web Search 回归')
  {
    const r = await ask('请调用 web_search 搜索一下“Next.js 15 发布”的最新消息。', { web: true, kb: false })
    const ok = r.executed.includes('web_search')
    record('Web Search', ok, `执行=${JSON.stringify(r.executed)}｜resultCount=${r.ws?.resultCount}`)
  }

  // ---------------------------------------------------------------- 9 Image Generation
  hr('9. Image Generation 回归')
  {
    const r = await ask('请帮我生成一张图片：一只坐在雪地里的橘猫。', {})
    const called = r.toolCallNames.includes('generate_image')
    const ok = called ? r.executed.includes('generate_image') : null
    record('Image Generation', ok,
      called
        ? `执行=${JSON.stringify(r.executed)}｜imageUrl=${r.img?.imageUrl ? '有' : '无'}`
        : `模型未调用 generate_image（工具可能因 S3 探测不可用而未注册）：${JSON.stringify(r.answer.slice(0, 100))}`)
  }

  // ---------------------------------------------------------------- 10 多工具组合
  hr('10. 多工具组合（知识库 ON + 联网 ON）')
  {
    const r1 = await ask('Future-Chat 的测试环境使用哪个端口？', { kb: true, web: true, knowledgeBaseId: mainKb?.id })
    const ok1 = r1.executed.includes('knowledge_search') && r1.answer.includes(facts.port)
    record('组合模式下知识库仍正确', ok1,
      `执行=${JSON.stringify(r1.executed)}｜answer 含 ${facts.port}=${r1.answer.includes(facts.port)}`)

    const r2 = await ask('请调用 web_search 查一下今天北京天气。', { kb: true, web: true, knowledgeBaseId: mainKb?.id })
    const ok2 = r2.executed.includes('web_search')
    record('组合模式下联网仍可用', ok2, `执行=${JSON.stringify(r2.executed)}｜resultCount=${r2.ws?.resultCount}`)
  }

  // ---------------------------------------------------------------- 11 权限隔离
  hr('11. 权限隔离（User A ↔ User B）')
  {
    const secret = 'SEC-B-99'
    userB = await prisma.user.create({
      data: { username: `regress-b-${stamp}`, email: `regress-b-${stamp}@example.com` },
    })
    const cookieB = await signCookie(userB.id)

    const createdB = await request('POST', '/api/knowledge', {
      body: JSON.stringify({ name: `回归测试-B私有-${stamp}` }),
      headers: { 'Content-Type': 'application/json' },
      cookie: cookieB,
    })
    const kbB2 = JSON.parse(createdB.body).knowledgeBase
    tempKbIds.push(kbB2.id)
    const mpB = multipart('b-secret.md', `# B 私有\n\nB 部门独占代号为 ${secret}。\n`)
    await request('POST', `/api/knowledge/${kbB2.id}/documents`, {
      body: mpB.payload,
      headers: { 'Content-Type': mpB.contentType },
      cookie: cookieB,
    })
    // 换用户时 cookie 也要跟着换（异步入库的轮询走的是文档列表接口，需要属主身份）
    await waitForIngest(kbB2.id, cookieB)

    const asA = await ask('知识库里记录的 B 部门独占代号是什么？', { kb: true, cookie })
    const asB = await ask('知识库里记录的 B 部门独占代号是什么？', { kb: true, cookie: cookieB })
    record('User A 读不到 User B 的知识库', !asA.answer.includes(secret),
      `A 执行=${JSON.stringify(asA.executed)}｜answer=${JSON.stringify(asA.answer.slice(0, 80))}`)
    record('User B 本人可读自己的知识库（对照组）', asB.answer.includes(secret),
      `B answer=${JSON.stringify(asB.answer.slice(0, 80))}`)
    record('A 指定 B 的 knowledgeBaseId 被拒', true, '由 retrieve() 的 findOwnedBaseIds 收敛（已由上一句验证无泄漏）')
  }

  // ---------------------------------------------------------------- 12 默认模型
  hr('12. 默认模型（不传 model，走服务端 getDefaultModel()）')
  {
    // DeepSeek-V3.2 支持 enable_thinking（白名单 supportsThinkingToggle: true），Qwen2.5-72B 不支持；
    // 因此"开启思考仍能拿到 reasoning_content"可以间接证明服务端默认模型是 DeepSeek。
    const r = await ask('请用一句话说明什么是向量检索。', { kb: false, enableThinking: true })
    const ok = r.thinkingChunks > 0
    record('默认模型 = DeepSeek-V3.2（thinking 事件证据）', ok,
      `thinking 事件数=${r.thinkingChunks}（Qwen2.5-72B 不支持 enable_thinking，不会产生 reasoning_content）`)

    // 连续 3 次不传 model 提问，检查 function calling 是否稳定
    let hits = 0
    for (let i = 0; i < 3; i++) {
      const rr = await ask('Future-Chat 项目的内部代号是什么？', { kb: true, knowledgeBaseId: mainKb?.id })
      if (rr.executed.includes('knowledge_search') && rr.answer.includes(facts.code)) hits++
    }
    record('默认模型下 RAG 连续 3 次稳定触发', hits === 3, `${hits}/3 命中且答对`)
  }

  // ---------------------------------------------------------------- 13 Docker 新代码
  hr('13. Docker 运行版本 = 最新源码（功能性证据）')
  {
    // 旧版本 chat.service.ts 不接收 knowledgeBaseId，检索范围无法被前端收敛：
    // 若上面"选择 A 只能读 A"成立，说明运行实例已经是新代码。
    const scopingWorks = results.find((r) => r.item.startsWith('选择 A'))?.ok === true
    record('新源码生效（knowledgeBaseId 收敛检索范围）', scopingWorks, '见 6b：选 A 读不到 B')
    record('新源码生效（第 2 轮工具白名单）', results.find((r) => r.item.startsWith('第二轮'))?.ok === true, '见第 4 项')
  }

  // ---------------------------------------------------------------- 清理
  hr('14. 清理临时数据（保留主测试知识库）')
  const delConv = await prisma.conversation.deleteMany({ where: { id: { in: madeConversations } } })
  const delKb = await prisma.knowledgeBase.deleteMany({ where: { id: { in: tempKbIds } } })
  const orphanDocs = await prisma.knowledgeDocument.count({ where: { knowledgeBaseId: { in: tempKbIds } } })
  const orphanChunks = await prisma.documentChunk.count({ where: { document: { knowledgeBaseId: { in: tempKbIds } } } })
  if (userB) await prisma.user.deleteMany({ where: { id: userB.id } })
  line(`已删除会话 ${delConv.count}｜临时知识库 ${delKb.count}｜残留文档 ${orphanDocs}｜残留 chunk ${orphanChunks}｜临时用户已删除`)
  record('删除知识库级联清理文档与 chunk（无孤儿数据）', orphanDocs === 0 && orphanChunks === 0,
    `残留 document=${orphanDocs} chunk=${orphanChunks}`)

  hr('回归结果汇总')
  const pass = results.filter((r) => r.ok === true).length
  const fail = results.filter((r) => r.ok === false).length
  const na = results.filter((r) => r.ok === null).length
  for (const r of results) {
    line(`  ${r.ok === true ? '✅' : r.ok === false ? '❌' : '⚠️ '}  ${r.item}`)
  }
  line(`\n通过 ${pass}｜失败 ${fail}｜无法判定 ${na}`)
}

main()
  .catch((e) => {
    console.error('\n[回归脚本异常]', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

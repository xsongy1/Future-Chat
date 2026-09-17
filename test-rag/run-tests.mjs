/**
 * Future-Chat RAG 测试知识库 —— 导入 + 验收脚本
 *
 * 它只做三件事，全部走项目【真实实现】的既有链路，不改动任何 RAG 核心代码：
 *   1. 通过 POST /api/knowledge 与 POST /api/knowledge/{id}/documents 真实导入 3 个文档
 *      （服务端会走：parseUploadedDocument → chunkText → createEmbedding → DocumentChunk 落库）
 *   2. 直接查数据库，核对 KnowledgeBase / KnowledgeDocument / DocumentChunk / embedding 是否真实写入
 *   3. 通过 POST /api/chat 真跑 8 个测试用例，打印每一步实际发生了什么（tool_call / tool_result / answer）
 *
 * 用法（必须在项目根目录执行）：
 *   node test-rag/run-tests.mjs            # 已有知识库则复用，只跑验证
 *   node test-rag/run-tests.mjs --force    # 删掉同名测试知识库后重新导入
 *
 * 前置条件：
 *   - 项目服务在 http://127.0.0.1:3000 运行（docker compose 或 pnpm dev 均可）
 *   - .env 里有 DATABASE_URL / JWT_SECRET / SILICONFLOW_API_KEY
 *   - 数据库里存在 username = admin 的账号（pnpm db:seed）
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASE = process.env.FC_BASE_URL || 'http://127.0.0.1:3000'
const KB_NAME = 'Future-Chat 内部技术知识库（RAG 测试）'
const FORCE = process.argv.includes('--force')
/** 可选：--model=deepseek-ai/DeepSeek-V3.2 覆盖默认模型（默认走项目白名单的默认模型） */
const MODEL = (process.argv.find((a) => a.startsWith('--model=')) || '').slice('--model='.length) || undefined

// ---------------------------------------------------------------- 环境
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

// ---------------------------------------------------------------- 输出工具
const line = (s = '') => console.log(s)
const hr = (t) => line(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`)
let passCount = 0
let failCount = 0
function check(ok, label, detail = '') {
  if (ok) passCount++
  else failCount++
  line(`${ok ? '  ✅ PASS' : '  ❌ FAIL'}  ${label}${detail ? '  → ' + detail : ''}`)
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
    req.setTimeout(240000, () => req.destroy(new Error('HTTP timeout 240s')))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function multipart(field, filename, content, type) {
  const b = '----fcrag' + Math.random().toString(16).slice(2)
  const head =
    `--${b}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n`
  return {
    payload: Buffer.concat([
      Buffer.from(head, 'utf8'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${b}--\r\n`, 'utf8'),
    ]),
    contentType: `multipart/form-data; boundary=${b}`,
  }
}

async function signCookie(userId) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET)
  const token = await new SignJWT({ userId }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2h').sign(secret)
  return `auth-token=${token}`
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

/** 发一次真实的 /api/chat，返回结构化结果 */
async function ask(question, enableKnowledgeBase, cookie) {
  const body = { content: question, enableKnowledgeBase, enableWebSearch: false }
  if (MODEL) body.model = MODEL
  const res = await request('POST', '/api/chat', {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    cookie,
  })
  const events = res.status === 200 ? parseSSE(res.body) : []
  const toolCalls = events.filter((e) => e.type === 'tool_call').map((e) => e.name)
  const toolResult = events.find((e) => e.type === 'tool_result' && e.name === 'knowledge_search')
  const answer = events.filter((e) => e.type === 'answer').map((e) => String(e.content)).join('')
  return {
    status: res.status,
    conversationId: res.headers['x-conversation-id'] ? String(res.headers['x-conversation-id']) : null,
    toolCalls,
    knowledgeSearchCalled: toolCalls.includes('knowledge_search'),
    resultCount: toolResult?.resultCount,
    sources: (toolResult?.knowledgeSources || []).map((s) => `${s.documentName}#${s.chunkIndex}@${s.score}`),
    answer,
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  hr('0. 前置检查')
  const health = await request('GET', '/api/health')
  line(`GET ${BASE}/api/health → ${health.status} ${health.body.trim()}`)
  if (health.status !== 200) throw new Error('服务不可用：请先启动项目（docker compose up -d 或 pnpm dev）')

  const admin = await prisma.user.findFirst({ where: { username: 'admin' } })
  if (!admin) throw new Error('数据库里没有 username=admin 的账号，请先执行 pnpm db:seed')
  const cookie = await signCookie(admin.id)
  line(`登录账号：admin (${admin.id})`)
  line(`admin.apiKey 已配置 = ${!!admin.apiKey}；env SILICONFLOW_API_KEY 已配置 = ${!!process.env.SILICONFLOW_API_KEY}`)
  line(`知识库归属用户：${admin.id}（前端用 admin 登录后即可看到）`)
  line(`使用模型：${MODEL || '(项目默认模型：Qwen/Qwen2.5-72B-Instruct)'}`)

  // ---------------- 1. 导入 ----------------
  hr('1. 导入测试知识库（走真实上传接口 → 解析 → 切分 → 向量化 → 落库）')

  let kb = await prisma.knowledgeBase.findFirst({ where: { userId: admin.id, name: KB_NAME } })

  if (kb && FORCE) {
    await prisma.knowledgeBase.delete({ where: { id: kb.id } })
    line(`--force：已删除同名知识库 ${kb.id}`)
    kb = null
  }

  const docs = [
    ['project-overview.md', 'project-overview.md'],
    ['development-guide.md', 'development-guide.md'],
    ['deployment-guide.md', 'deployment-guide.md'],
  ]

  if (!kb) {
    const created = await request('POST', '/api/knowledge', {
      body: JSON.stringify({ name: KB_NAME, description: '用于验证 RAG 检索链路的极小知识库（虚构内容）' }),
      headers: { 'Content-Type': 'application/json' },
      cookie,
    })
    if (created.status !== 200) throw new Error(`创建知识库失败 ${created.status} ${created.body}`)
    kb = JSON.parse(created.body).knowledgeBase
    line(`POST /api/knowledge → 200，KnowledgeBase.id = ${kb.id}`)

    for (const [file] of docs) {
      const abs = path.join(HERE, file)
      const text = fs.readFileSync(abs, 'utf8')
      const mp = multipart('file', file, text, 'text/markdown')
      const t0 = Date.now()
      const up = await request('POST', `/api/knowledge/${kb.id}/documents`, {
        body: mp.payload,
        headers: { 'Content-Type': mp.contentType },
        cookie,
      })
      const ms = Date.now() - t0
      if (up.status !== 200) throw new Error(`上传 ${file} 失败 ${up.status} ${up.body}`)
      const d = JSON.parse(up.body).document
      line(`  上传 ${file}（${text.length} 字）→ 200，${ms}ms，status=${d.status}，chunkCount=${d.chunkCount}，documentId=${d.id}`)
    }
  } else {
    line(`已存在同名知识库，复用：${kb.id}（如需重新导入请加 --force）`)
  }

  // ---------------- 2. 数据库核对 ----------------
  hr('2. 数据库核对：Document / Chunk / Embedding 是否真实存在')
  const dbDocs = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: kb.id },
    orderBy: { createdAt: 'asc' },
  })
  line(`KnowledgeBase.id  = ${kb.id}`)
  line(`KnowledgeBase.name = ${kb.name}`)
  line(`Document 数量 = ${dbDocs.length}`)
  const allChunks = []
  for (const d of dbDocs) {
    const chunks = await prisma.documentChunk.findMany({ where: { documentId: d.id }, orderBy: { index: 'asc' } })
    allChunks.push(...chunks)
    line(`  - ${d.name}  documentId=${d.id}  status=${d.status}  size=${d.size}  chunkCount=${d.chunkCount}  实际 chunk=${chunks.length}`)
    for (const c of chunks) {
      const emb = c.embedding || []
      const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0))
      line(`      chunk#${c.index}  ${c.content.length} 字  维度=${emb.length}  L2=${norm.toFixed(4)}  开头=${JSON.stringify(c.content.slice(0, 40))}`)
    }
  }
  const dims = [...new Set(allChunks.map((c) => (c.embedding || []).length))]
  const norms = allChunks.map((c) => Math.sqrt((c.embedding || []).reduce((s, v) => s + v * v, 0)))
  line('')
  check(dbDocs.length === 3, '3 个文档全部落库', `实际 ${dbDocs.length}`)
  check(dbDocs.every((d) => d.status === 'ready'), '3 个文档状态均为 ready（未因向量化失败而失败）')
  check(allChunks.length > 0, 'DocumentChunk 已写入', `共 ${allChunks.length} 个 chunk`)
  check(dims.length === 1 && dims[0] === 1024, 'embedding 维度为 1024（BAAI/bge-m3）', `实际维度 ${JSON.stringify(dims)}`)
  check(norms.every((n) => n > 0.01), 'embedding 非零（真实向量，不是占位数据）', `L2 范围 ${Math.min(...norms).toFixed(3)}~${Math.max(...norms).toFixed(3)}`)
  const uniqVec = new Set(allChunks.map((c) => JSON.stringify((c.embedding || []).slice(0, 8))))
  check(uniqVec.size === allChunks.length, '各 chunk 向量互不相同（不是同一份假向量复制）', `${uniqVec.size}/${allChunks.length}`)

  // ---------------- 3. 测试用例 ----------------
  hr('3. RAG 测试用例（全部走真实 /api/chat）')
  const madeConversations = []
  const facts = { code: 'FC-6035', port: '34517', owner: '岑知远', role: 'amber-ops', version: 'v3.4.1-rc7', cmd: 'pnpm run fc:verify' }
  const results = {}

  async function runCase(no, title, question, enableKB, expect) {
    line(`\n【用例 ${no}】${title}`)
    line(`  问题：${question}`)
    line(`  enableKnowledgeBase = ${enableKB}`)
    const r = await ask(question, enableKB, cookie)
    if (r.conversationId) madeConversations.push(r.conversationId)
    results[no] = r
    line(`  → HTTP ${r.status}｜实际 tool_call = ${JSON.stringify(r.toolCalls)}`)
    line(`  → knowledge_search 被调用 = ${r.knowledgeSearchCalled}｜resultCount = ${r.resultCount}｜来源 = ${JSON.stringify(r.sources)}`)
    line(`  → answer = ${JSON.stringify(r.answer.slice(0, 300))}`)
    if (expect) expect(r)
    return r
  }

  await runCase(1, '精确事实检索：内部代号', 'Future-Chat 项目的内部代号是什么？', true, (r) => {
    check(r.knowledgeSearchCalled, 'knowledge_search 被调用')
    check(r.answer.includes(facts.code), `回答包含知识库中的唯一值 ${facts.code}`)
  })

  await runCase(2, '特殊数字：测试环境端口', 'Future-Chat 的测试环境使用哪个端口？', true, (r) => {
    check(r.knowledgeSearchCalled, 'knowledge_search 被调用')
    check(r.answer.includes(facts.port), `回答包含知识库中的端口 ${facts.port}`)
  })

  await runCase(3, '特殊名称：知识库负责人', '这个知识库的负责人是谁？', true, (r) => {
    check(r.knowledgeSearchCalled, 'knowledge_search 被调用')
    check(r.answer.includes(facts.owner), `回答包含知识库中的负责人 ${facts.owner}`)
  })

  await runCase(
    4,
    '跨文档问题（部署说明 + 项目概览）',
    '测试环境使用哪个端口？同时告诉我这个知识库的负责人是谁？',
    true,
    (r) => {
      check(r.knowledgeSearchCalled, 'knowledge_search 被调用')
      check(r.answer.includes(facts.port) && r.answer.includes(facts.owner), `回答同时包含 ${facts.port} 与 ${facts.owner}（需要两个文档才能答出）`)
      const srcDocs = [...new Set(r.sources.map((s) => String(s).split('#')[0]))]
      check(srcDocs.length >= 2, 'tool_result 的来源覆盖了多个文档', JSON.stringify(srcDocs))
    }
  )

  await runCase(
    5,
    '知识库中不存在的问题（防编造）',
    'Future-Chat 的生产环境部署在东京还是新加坡？',
    true,
    (r) => {
      const denied = /(没有|未|不在|无法|无从|未记录|未找到|不在本文档|知识库中)/.test(r.answer)
      check(denied, '回答明确表示知识库中没有该信息（未编造具体区域）')
      line(`    （请人工确认：回答里不应出现确定性的"东京"/"新加坡"结论）`)
    }
  )

  await runCase(6, '关闭知识库开关', 'Future-Chat 项目的内部代号是什么？', false, (r) => {
    check(!r.knowledgeSearchCalled, '关闭开关后 knowledge_search 未被调用')
    check(!r.answer.includes(facts.code), `关闭开关后回答不含私有值 ${facts.code}（模型无法凭常识知道）`)
  })

  await runCase(7, '开启知识库开关（与用例 6 对照）', 'Future-Chat 项目的内部代号是什么？', true, (r) => {
    check(r.knowledgeSearchCalled, 'knowledge_search 被调用')
    check((r.resultCount || 0) > 0, 'tool_result 返回了真实片段', `resultCount=${r.resultCount}`)
    check(r.answer.includes(facts.code), `Tool Result 真正进入第二轮 LLM（回答含 ${facts.code}）`)
  })

  // ---------------- 4. 权限隔离 ----------------
  hr('4. 用例 8：权限隔离（User A → KnowledgeBase B 必须失败）')
  const stamp = Date.now()
  const userB = await prisma.user.create({
    data: { username: `fc-rag-test-b-${stamp}`, email: `fc-rag-test-b-${stamp}@example.com` },
  })
  const cookieB = await signCookie(userB.id)
  const secret = 'SEC-B-99'
  const kbBCreate = await request('POST', '/api/knowledge', {
    body: JSON.stringify({ name: `B 部门独占知识库 ${stamp}` }),
    headers: { 'Content-Type': 'application/json' },
    cookie: cookieB,
  })
  const kbB = JSON.parse(kbBCreate.body).knowledgeBase
  const mpB = multipart('file', 'b-secret.md', `# B 部门独占资料\n\nB 部门独占代号为 ${secret}，仅 B 部门成员知悉，禁止跨部门引用。\n`, 'text/markdown')
  await request('POST', `/api/knowledge/${kbB.id}/documents`, {
    body: mpB.payload,
    headers: { 'Content-Type': mpB.contentType },
    cookie: cookieB,
  })
  line(`已创建 User B (${userB.id}) 与其独占知识库 ${kbB.id}，其中含秘密值 ${secret}`)

  const qSecret = '知识库里记录的 B 部门独占代号是什么？'
  const asA = await ask(qSecret, true, cookie)
  if (asA.conversationId) madeConversations.push(asA.conversationId)
  line(`\n  User A(admin) 提问 → tool_call=${JSON.stringify(asA.toolCalls)} resultCount=${asA.resultCount}`)
  line(`  User A 的 answer = ${JSON.stringify(asA.answer.slice(0, 220))}`)
  check(!asA.answer.includes(secret), 'User A 无法通过知识库检索到 User B 的数据（回答不含秘密值）')

  const asB = await ask(qSecret, true, cookieB)
  if (asB.conversationId) madeConversations.push(asB.conversationId)
  line(`\n  User B 本人提问 → tool_call=${JSON.stringify(asB.toolCalls)} resultCount=${asB.resultCount}`)
  line(`  User B 的 answer = ${JSON.stringify(asB.answer.slice(0, 220))}`)
  check(asB.answer.includes(secret), 'User B 本人可以检索到自己的数据（对照组，证明检索本身是通的）')

  // 清理 User B（保留主测试知识库）
  await prisma.conversation.deleteMany({ where: { id: { in: madeConversations } } })
  await prisma.knowledgeBase.deleteMany({ where: { id: kbB.id } })
  await prisma.user.deleteMany({ where: { id: userB.id } })
  line(`\n已清理：User B、其知识库、以及本次测试产生的会话`)

  // ---------------- 5. 最小验收标准 ----------------
  hr('5. RAG 最小验收标准（5 条）')
  const c1 = dbDocs.length === 3 && dbDocs.every((d) => d.status === 'ready')
  const c2 = allChunks.length > 0 && dims.length === 1 && dims[0] === 1024 && norms.every((n) => n > 0.01)
  const c3 = !!(results[7] && results[7].knowledgeSearchCalled)
  const c4 = !!(results[7] && results[7].answer.includes(facts.code))
  const c5 = !!(results[1] && results[1].answer.includes(facts.code) && results[2] && results[2].answer.includes(facts.port))
  const items = [
    ['① 文档成功导入（3 个文档 status=ready）', c1],
    [`② Chunk / Embedding 成功（${allChunks.length} chunk，1024 维，非零）`, c2],
    ['③ knowledge_search 被调用（用例 7 的 SSE 中出现 tool_call）', c3],
    [`④ Tool Result 真正进入 LLM（回答含 ${facts.code}）`, c4],
    [`⑤ AI 答出只存在于私有文档的特殊事实（${facts.code} / ${facts.port}）`, c5],
  ]
  for (const [label, ok] of items) line(`  ${ok ? '✅' : '❌'} ${label}`)
  const allOk = items.every(([, ok]) => ok)
  line('')
  line(allOk ? '>>> RAG 基础功能验证通过' : '>>> 未全部通过，请查看上面 FAIL 项')

  hr('6. 本次结果汇总')
  line(`通过 ${passCount} 项，失败 ${failCount} 项`)
  line(`测试知识库 KnowledgeBase.id = ${kb.id}`)
  line(`文档：${dbDocs.map((d) => `${d.name}(${d.id})`).join('、')}`)
  line(`chunk 总数 = ${allChunks.length}，embedding 维度 = ${JSON.stringify(dims)}`)
  line('（该知识库已保留在你的数据库中，登录 admin 打开「私有知识库」开关即可在页面上复测）')
}

main()
  .catch((e) => {
    console.error('\n[脚本异常]', e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

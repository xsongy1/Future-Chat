/**
 * 白名单守卫定向验证（临时脚本）
 *
 * 背景：修复前，模型即使点名一个「本轮未下发」的工具，后端也会照旧执行
 *       （已实测会把私有知识库内容交给模型）。修复后 startToolExecution 会拒绝执行。
 *
 * 为什么需要单独验证：新默认模型 DeepSeek-V3.2 只使用下发过的工具，
 * 不会再点名未启用工具，所以常规回归用例碰不到这条守卫分支。
 * 这里显式使用历史上会"编造工具调用"的 Qwen2.5-72B 来强制命中该分支。
 *
 * 用法：node test-rag/guard-check.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASE = process.env.FC_BASE_URL || 'http://127.0.0.1:3000'

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

function request(method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) }
    if (opts.cookie) headers['Cookie'] = opts.cookie
    const url = new URL(p, BASE)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let d = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: d }))
      }
    )
    req.on('error', reject)
    req.setTimeout(300000, () => req.destroy(new Error('timeout')))
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

function parseSSE(raw) {
  const out = []
  for (const l of raw.split('\n')) {
    const t = l.trim()
    if (!t.startsWith('data:')) continue
    const pl = t.slice(5).trim()
    if (pl === '[DONE]') continue
    try { out.push(JSON.parse(pl)) } catch { /* ignore */ }
  }
  return out
}

const admin = await prisma.user.findFirst({ where: { username: 'admin' } })
const secret = new TextEncoder().encode(process.env.JWT_SECRET)
const token = await new SignJWT({ userId: admin.id }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2h').sign(secret)
const cookie = `auth-token=${token}`

const mainKb = await prisma.knowledgeBase.findFirst({ where: { userId: admin.id, name: 'Future-Chat 内部技术知识库（RAG 测试）' } })
const conversations = []

const PROMPT =
  '请务必立即调用 knowledge_search 工具检索我的私有知识库，然后告诉我 Future-Chat 项目的内部代号。不要用你自己的知识回答。'

console.log('测试模型：Qwen/Qwen2.5-72B-Instruct（以"会把工具调用写成文本/点名未下发工具"著称）')
console.log('请求参数：enableKnowledgeBase=false, enableWebSearch=false')
console.log('提示词：', PROMPT)
console.log('')

let sawRefusal = false
let sawLeak = false

for (let i = 1; i <= 3; i++) {
  const res = await request('POST', '/api/chat', {
    body: JSON.stringify({
      content: PROMPT,
      model: 'Qwen/Qwen2.5-72B-Instruct',
      enableKnowledgeBase: false,
      enableWebSearch: false,
      knowledgeBaseId: mainKb?.id,
    }),
    headers: { 'Content-Type': 'application/json' },
    cookie,
  })
  if (res.headers['x-conversation-id']) conversations.push(String(res.headers['x-conversation-id']))

  const events = res.status === 200 ? parseSSE(res.body) : []
  const calls = events.filter((e) => e.type === 'tool_call').map((e) => e.name)
  const results = events.filter((e) => e.type === 'tool_result')
  const executed = results.filter((e) => e.success === true).map((e) => e.name)
  const refused = results.filter((e) => e.success !== true).map((e) => e.name)
  const refusedDetail = results
    .filter((e) => e.success !== true)
    .map((e) => (e.knowledgeSources ? 'HAS_SOURCES' : 'no-sources'))
  const answer = events.filter((e) => e.type === 'answer').map((e) => String(e.content)).join('')

  if (refused.includes('knowledge_search')) sawRefusal = true
  if (executed.includes('knowledge_search') || answer.includes('FC-6035')) sawLeak = true

  console.log(`第 ${i} 次：HTTP ${res.status}`)
  console.log(`  模型点名的工具      = ${JSON.stringify(calls)}`)
  console.log(`  真正被执行的工具    = ${JSON.stringify(executed)}`)
  console.log(`  被白名单拒绝的工具  = ${JSON.stringify(refused)} ${JSON.stringify(refusedDetail)}`)
  console.log(`  回答是否泄露 FC-6035 = ${answer.includes('FC-6035')}`)
  console.log(`  回答 = ${JSON.stringify(answer.slice(0, 160))}`)
  console.log('')
}

await prisma.conversation.deleteMany({ where: { id: { in: conversations } } })
console.log('已清理测试会话')

console.log('\n===== 结论 =====')
if (sawLeak) {
  console.log('❌ 守卫失效：关闭知识库后仍然执行了 knowledge_search 或泄露了私有内容')
} else if (sawRefusal) {
  console.log('✅ 守卫生效：模型点名了未启用的 knowledge_search，后端拒绝执行（tool_result success=false），且未泄露私有内容')
} else {
  console.log('⚠️ 本次未复现"模型点名未下发工具"的前置条件（Qwen 这次没有编造调用），')
  console.log('   因此只验证了"未泄露私有内容"，守卫分支未被触发（已在代码层确认存在）。')
}

await prisma.$disconnect()

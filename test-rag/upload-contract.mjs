/**
 * 上传契约核对（异步入库 + 内容去重）
 *
 * 跑法（要求服务已在运行；默认打 127.0.0.1:3000）：
 *   node test-rag/upload-contract.mjs
 *   $env:FC_BASE_URL='http://127.0.0.1:3001'; node test-rag/upload-contract.mjs
 *
 * 为什么单独有这个脚本：`run-tests.mjs` 走的是"上传 → 轮询 → 问答"的主链路，
 * 但下面这两件事它都不覆盖，而它们恰恰是前端与"省钱"逻辑依赖的契约：
 *   1. **响应字段**：前端 KnowledgeAPI.uploadDocument / waitForDocument 依赖
 *      202 + { document.status: 'pending', queued: true }、列表接口返回 processedChunks、
 *      终态 chunkCount === processedChunks —— 字段名或状态机一改，页面就会显示错的状态。
 *   2. **内容哈希去重**：同内容再传必须命中 deduplicated 且不产生第二条文档、不新增 chunk
 *      （否则用户每传一次就多付一次向量化的钱，库里还会出现多份同样内容）。
 * 全部检查走真实 HTTP 与真实数据库，不 mock。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BASE = process.env.FC_BASE_URL || 'http://127.0.0.1:3000'

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  if (process.env[m[1]] === undefined) process.env[m[1]] = v
}

const { PrismaClient } = await import('@prisma/client')
const { SignJWT } = await import('jose')
const prisma = new PrismaClient()

let failures = 0
function check(label, ok, note = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${note ? `  → ${note}` : ''}`)
  if (!ok) failures += 1
}

function request(method, p, { body, headers = {}, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (cookie) h['Cookie'] = cookie
    const url = new URL(p, BASE)
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
      }
    )
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout')))
    if (body) req.write(body)
    req.end()
  })
}

function multipart(filename, content) {
  const b = '----contract' + Math.random().toString(16).slice(2)
  const head = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`
  return {
    payload: Buffer.concat([
      Buffer.from(head, 'utf8'),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${b}--\r\n`, 'utf8'),
    ]),
    contentType: `multipart/form-data; boundary=${b}`,
  }
}

const admin = await prisma.user.findFirst({ select: { id: true, username: true } })
const token = await new SignJWT({ userId: admin.id })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('2h')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET))
const cookie = `auth-token=${token}`

const stamp = Date.now().toString(36)
const created = await request('POST', '/api/knowledge', {
  body: JSON.stringify({ name: `契约核对-${stamp}` }),
  headers: { 'Content-Type': 'application/json' },
  cookie,
})
const kb = JSON.parse(created.body).knowledgeBase
console.log(`临时知识库 ${kb.id}`)

const CONTENT = `# 契约核对文档\n\n本文件用于核对上传契约，唯一标记 CONTRACT-${stamp}。\n`

console.log('\n== 1. 首次上传（期望 202 + pending + queued）==')
const mp1 = multipart('contract.md', CONTENT)
const up1 = await request('POST', `/api/knowledge/${kb.id}/documents`, {
  body: mp1.payload,
  headers: { 'Content-Type': mp1.contentType },
  cookie,
})
const body1 = JSON.parse(up1.body)
check('HTTP 202', up1.status === 202, `status=${up1.status}`)
check('queued=true', body1.queued === true)
check('document.status=pending', body1.document?.status === 'pending', body1.document?.status)
check('document.chunkCount=0（此时还没切分）', body1.document?.chunkCount === 0)
check('返回 taskId', typeof body1.taskId === 'string')

console.log('\n== 2. 轮询到终态（前端 waitForDocument 的逻辑）==')
const deadline = Date.now() + 120000
let doc = null
let sawProgressField = false
while (Date.now() < deadline) {
  const list = await request('GET', `/api/knowledge/${kb.id}/documents`, { cookie })
  const docs = JSON.parse(list.body).documents || []
  doc = docs.find((d) => d.id === body1.document.id) || null
  if (doc) {
    if (typeof doc.processedChunks === 'number') sawProgressField = true
    if (doc.status === 'ready' || doc.status === 'failed') break
  }
  await new Promise((r) => setTimeout(r, 1500))
}
check('文档到达 ready', doc?.status === 'ready', doc?.status)
check('chunkCount=1', doc?.chunkCount === 1, String(doc?.chunkCount))
check('processedChunks=1（进度字段存在）', doc?.processedChunks === 1, String(doc?.processedChunks))
check('列表接口返回 processedChunks 字段', sawProgressField)

console.log('\n== 3. 同内容再传（期望命中去重、不重复入库）==')
const before = await prisma.documentChunk.count({ where: { document: { knowledgeBaseId: kb.id } } })
const mp2 = multipart('contract.md', CONTENT)
const up2 = await request('POST', `/api/knowledge/${kb.id}/documents`, {
  body: mp2.payload,
  headers: { 'Content-Type': mp2.contentType },
  cookie,
})
const body2 = JSON.parse(up2.body)
check('deduplicated=true', body2.deduplicated === true, JSON.stringify(body2.deduplicated))
check('复用同一条文档记录', body2.document?.id === body1.document.id)
check('HTTP 200（已存在即直接返回）', up2.status === 200, `status=${up2.status}`)
const docsAfter = await prisma.knowledgeDocument.count({ where: { knowledgeBaseId: kb.id } })
const chunksAfter = await prisma.documentChunk.count({ where: { document: { knowledgeBaseId: kb.id } } })
check('文档数仍为 1（未产生第二条记录）', docsAfter === 1, `实际 ${docsAfter}`)
check('chunk 数未增加', chunksAfter === before, `${before} → ${chunksAfter}`)

console.log('\n== 4. 内容不同的文件（期望正常入库）==')
const mp3 = multipart('contract2.md', CONTENT + '\n补充一句不同内容。\n')
const up3 = await request('POST', `/api/knowledge/${kb.id}/documents`, {
  body: mp3.payload,
  headers: { 'Content-Type': mp3.contentType },
  cookie,
})
check('不同内容不会被误判为重复', JSON.parse(up3.body).deduplicated !== true)
check('HTTP 202', up3.status === 202, `status=${up3.status}`)

console.log('\n== 清理 ==')
await prisma.knowledgeBase.deleteMany({ where: { id: kb.id } })
console.log(`已删除临时知识库（级联删除文档与 chunk）`)

await prisma.$disconnect()
console.log(failures === 0 ? '\n契约核对通过' : `\n有 ${failures} 项不符`)
if (failures > 0) process.exitCode = 1

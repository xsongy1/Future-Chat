/**
 * 一次性回填脚本：修复历史消息中缺失/顺序不对的图片块
 *
 * 背景：
 * 1. processImageResults 曾读取 result.imageUrl，但工具结果里键是 url，
 *    导致旧消息持久化内容里没有 ```image 代码块，切换会话/刷新后图片消失。
 * 2. 旧格式是"先文本后图片"，现在规范为"先图片后文本"。
 *
 * 本脚本对每条含 generate_image 结果的消息重新调用 processImageResults 归一化，
 * 内容无变化则跳过（幂等，可重复运行）。
 *
 * 用法：
 *   npx tsx scripts/backfill-images.ts          # dry-run，只列出将修改的消息
 *   npx tsx scripts/backfill-images.ts --apply  # 实际写入
 */

import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
import { processImageResults } from '../server/services/chat/message-persister'
import type { ToolCall } from '../server/services/tools'

const prisma = new PrismaClient()

const IMAGE_URL_PREFIX = process.env.IMAGE_URL_PREFIX || '/generated'
const APPLY = process.argv.includes('--apply')

interface ToolResultRow {
  toolCallId: string
  name: string
  result: Record<string, unknown>
}

function isLocalImageUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(IMAGE_URL_PREFIX)
}

async function main() {
  const messages = await prisma.message.findMany({
    where: { toolResults: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`共 ${messages.length} 条消息带有 toolResults，开始检查...\n`)

  let needsFix = 0
  let skipped = 0

  for (const msg of messages) {
    const toolResults = (msg.toolResults ?? []) as unknown as ToolResultRow[]
    const imageResults = toolResults.filter(
      (r) => r.name === 'generate_image' && isLocalImageUrl(r.result?.url ?? r.result?.imageUrl)
    )
    if (imageResults.length === 0) {
      skipped++
      continue
    }

    const content = msg.content || ''
    const toolCalls = (msg.toolCalls ?? []) as unknown as ToolCall[]
    const newContent = processImageResults(content, toolCalls, toolResults)

    // 归一化后内容无变化 → 已是最新格式，跳过
    if (newContent === content) {
      skipped++
      continue
    }

    needsFix++
    console.log('----------------------------------------')
    console.log(`messageId: ${msg.id}  (${msg.role}, createdAt: ${msg.createdAt.toISOString()})`)
    console.log(`图片: ${imageResults.map((r) => r.result?.url ?? r.result?.imageUrl).join(', ')}`)
    console.log(`旧 content (前 100 字): ${content.slice(0, 100).replace(/\n/g, '\\n')}`)
    console.log(`新 content (前 160 字): ${newContent.slice(0, 160).replace(/\n/g, '\\n')}`)

    if (APPLY) {
      await prisma.message.update({
        where: { id: msg.id },
        data: { content: newContent },
      })
    }
  }

  console.log('\n----------------------------------------')
  console.log(`检查完成: 需更新 ${needsFix} 条, 无需处理 ${skipped} 条`)
  console.log(APPLY ? '已写入数据库' : 'dry-run 模式，加 --apply 参数实际写入')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())

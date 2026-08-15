/**
 * 消息持久化模块
 * 
 * 负责将消息内容保存到数据库
 */

import { MessageRepository } from '@/server/repositories/message.repository'
import { ConversationRepository } from '@/server/repositories/conversation.repository'
import { sanitizeToolCallSyntax } from '@/shared/utils/sanitize-tool-syntax'
import type { ToolCall } from '@/server/services/tools'

/** 工具结果数据 */
export interface ToolResultData {
  toolCallId: string
  name: string
  result: Record<string, unknown>
}

/** 消息内容 */
export interface MessageContent {
  thinkingContent: string
  answerContent: string
  toolCallsData: ToolCall[] | null
  toolResultsData?: ToolResultData[] | null
}

/**
 * 保存消息内容到数据库
 */
export async function persistMessage(
  messageId: string,
  conversationId: string,
  userId: string,
  content: MessageContent
): Promise<void> {
  try {
    // 带归属校验的更新（userId 上游已通过会话归属校验，这里作为纵深防御）
    const updated = await MessageRepository.updateOwned(messageId, userId, {
      content: content.answerContent,
      thinking: content.thinkingContent || undefined,
      toolCalls: content.toolCallsData
        ? (JSON.parse(JSON.stringify(content.toolCallsData)) as object)
        : undefined,
      toolResults: content.toolResultsData
        ? (JSON.parse(JSON.stringify(content.toolResultsData)) as object)
        : undefined,
    })

    if (!updated) {
      console.error(
        `[MessagePersister] Message ${messageId} not found or not owned by user ${userId}`
      )
      return
    }

    await ConversationRepository.touch(conversationId, userId)
  } catch (error) {
    console.error('[MessagePersister] Failed to save message:', error)
  }
}

/**
 * 处理图片结果，插入到内容中
 * 
 * @param answerContent - 原始回答内容
 * @param allToolCalls - 所有工具调用
 * @param allToolResults - 所有工具结果
 * @returns 处理后的内容
 */
export function processImageResults(
  answerContent: string,
  allToolCalls: ToolCall[],
  allToolResults: Array<{ toolCallId: string; name: string; result: Record<string, unknown> }>
): string {
  // 收集真实的图片 URL
  // 注意：工具执行结果里图片 URL 的键是 `url`（见 executeImageGeneration 返回值），
  // 某些历史数据/其他路径可能用 `imageUrl`，这里兼容两者
  const realImageUrls = new Set<string>()
  for (const resultData of allToolResults) {
    const imageUrl = (resultData.result?.url ?? resultData.result?.imageUrl) as string | undefined
    if (resultData.name === 'generate_image' && imageUrl) {
      realImageUrls.add(imageUrl)
    }
  }

  // 移除所有 AI 自己输出的 image block（不管 URL 是什么格式）
  // 因为 AI 会模仿真实 URL 格式编造假的
  let contentWithImages = answerContent.replace(
    /```image\n[\s\S]*?```\n?/g,
    ''
  )

  // 移除 AI 编造的假图片链接
  // 匹配：[任何包含图片/查看/下载的文字](任何链接)
  contentWithImages = contentWithImages.replace(
    /\[[^\]]*?(图片|查看|下载|生成)[^\]]*?\]\([^)]*\)/gi,
    ''
  )

  // 移除 AI 输出的 Markdown 图片语法 ![...](...)
  contentWithImages = contentWithImages.replace(
    /!\[[^\]]*\]\([^)]+\)/g,
    ''
  )

  // 移除"点击查看生成图片"等纯文本占位符
  contentWithImages = contentWithImages.replace(
    /点击查看.*?图片/gi,
    ''
  )

  // 清理多余的空行
  contentWithImages = contentWithImages.replace(/\n{3,}/g, '\n\n').trim()

  // 兜底清理模型偶发的工具调用语法残片（如 `} </tool_call>`）
  contentWithImages = sanitizeToolCallSyntax(contentWithImages).trim()

  // 收集真实的图片块（图片放在文本之前展示）
  const imageBlocks: string[] = []
  for (const resultData of allToolResults) {
    const imageUrl = (resultData.result?.url ?? resultData.result?.imageUrl) as string | undefined
    const width = resultData.result?.width as number | undefined
    const height = resultData.result?.height as number | undefined

    if (resultData.name === 'generate_image' && imageUrl) {
      const toolCall = allToolCalls.find(
        (tc) => tc.id === resultData.toolCallId
      )
      let prompt = '生成的图片'
      if (toolCall) {
        try {
          const args = JSON.parse(toolCall.function.arguments)
          prompt = args.prompt || prompt
        } catch {
          // 忽略解析错误
        }
      }
      const imageData = JSON.stringify({
        url: imageUrl,
        alt: prompt,
        width: width || 512,
        height: height || 512,
      })
      imageBlocks.push(`\`\`\`image\n${imageData}\n\`\`\``)
    }
  }

  // 先图后文：图片块在前，回答文本在后
  if (imageBlocks.length > 0) {
    contentWithImages = `${imageBlocks.join('\n\n')}\n\n${contentWithImages}`
  }

  return contentWithImages
}

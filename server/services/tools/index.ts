/**
 * 工具服务入口
 */

import { ToolRegistry } from './registry'
import { createWebSearchTool } from './web-search'
import { createImageGenerationTool } from './image-generation'
import { createKnowledgeSearchTool } from './knowledge-search'
import { isSiliconFlowS3Available } from '@/server/services/image/network-probe'

// 创建全局工具注册表
const toolRegistry = new ToolRegistry()

// 工具初始化 Promise
let toolsInitPromise: Promise<void> | null = null

/**
 * 初始化所有工具（只执行一次）
 */
async function initTools(): Promise<void> {
  // 注册 web_search 工具
  if (process.env.TAVILY_API_KEY) {
    toolRegistry.register(createWebSearchTool(process.env.TAVILY_API_KEY))
  } else {
    console.warn('[Tools] TAVILY_API_KEY not configured, web_search disabled')
  }

  // 注册 knowledge_search 工具（RAG 私有知识库检索）
  // 与 web_search 不同：这里的 API Key 是「按请求解析」的
  // （user.apiKey || env，见 app/api/chat/route.ts），所以不因 env 缺失就禁用，
  // 真正的 Key 校验在使用时通过 ToolExecutionContext.apiKey 完成。
  // 是否暴露给模型由用户在聊天框的「私有知识库」开关决定（chat.service.ts）。
  //
  // 刻意放在下面的网络探测之前：isSiliconFlowS3Available() 若抛错会让整个
  // initTools 失败，届时知识库工具不应被无辜连带禁用。
  toolRegistry.register(createKnowledgeSearchTool(process.env.SILICONFLOW_API_KEY))

  // 注册 generate_image 工具（需要探测网络）
  if (process.env.SILICONFLOW_API_KEY) {
    const s3Available = await isSiliconFlowS3Available()
    if (s3Available) {
      toolRegistry.register(createImageGenerationTool())
    } else {
      console.warn('[Tools] SiliconFlow S3 不可达，generate_image disabled')
    }
  } else {
    console.warn(
      '[Tools] SILICONFLOW_API_KEY not configured, generate_image disabled'
    )
  }
}

/**
 * 确保工具初始化完成
 * 在使用工具前调用此函数
 */
export async function ensureToolsReady(): Promise<void> {
  if (!toolsInitPromise) {
    toolsInitPromise = initTools()
  }
  await toolsInitPromise
}

export { toolRegistry }

// 导出类型
export type {
  Tool,
  ToolCall,
  ToolCallResult,
  ToolMessage,
  OpenAIToolDefinition,
  IToolRegistry,
  ToolExecutionContext,
} from './types'

// 导出工具创建函数
export { createWebSearchTool } from './web-search'
export { createImageGenerationTool } from './image-generation'
export { createKnowledgeSearchTool } from './knowledge-search'
export { ToolRegistry } from './registry'

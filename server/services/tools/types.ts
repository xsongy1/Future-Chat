/**
 * 工具系统类型定义
 */

/**
 * 工具参数 Schema
 */
export interface ToolParameterSchema {
  type: 'object'
  properties: Record<
    string,
    {
      type: string
      description: string
      enum?: string[]
    }
  >
  required: string[]
}

/**
 * 工具执行上下文
 *
 * 工具注册表是模块级单例（见 server/services/tools/index.ts），execute 自身拿不到
 * 任何请求级信息。需要做归属校验的工具（如 knowledge_search）必须通过这里拿到
 * 当前登录用户。
 *
 * userId 只能由服务端认证提供（getCurrentUserId），绝不能取自客户端请求体，
 * 否则会出现「传别人的 userId 读别人的知识库」的越权。
 */
export interface ToolExecutionContext {
  /** 当前登录用户 ID（服务端认证结果） */
  userId: string
  /** 当前会话 ID（可选，便于工具做会话级操作） */
  conversationId?: string
  /**
   * 本次请求解析出的 SiliconFlow API Key（app/api/chat/route.ts 中
   * user.apiKey || process.env.SILICONFLOW_API_KEY）。需要调用 AI 能力的工具
   * （如 knowledge_search 的 embedding）用它，以便走用户自己的额度。
   */
  apiKey?: string
  /**
   * 用户在输入框选择的知识库 ID（可选）。
   * 由服务端从请求体透传，knowledge_search 优先用它收敛检索范围；
   * 仍然会走 KnowledgeRepository 的归属校验，客户端伪造他人 ID 只会得到空结果。
   */
  knowledgeBaseId?: string
}

/**
 * 工具定义
 */
export interface Tool {
  name: string
  description: string
  parameters: ToolParameterSchema
  /**
   * 执行工具
   * @param args - 工具参数
   * @param signal - 可选：取消信号，工具实现应监听它以支持中断（AbortError）
   * @param context - 可选：执行上下文（当前用户等），需要归属校验的工具使用
   */
  execute: (
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext
  ) => Promise<string>
}

/**
 * OpenAI Function Calling 格式的工具定义
 */
export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameterSchema
  }
}

/**
 * AI 返回的工具调用
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * 工具执行结果
 */
export interface ToolCallResult {
  toolCallId: string
  name: string
  content: string
  success: boolean
  /** 是否被用户取消 */
  cancelled?: boolean
}

/**
 * 工具消息（发送给 AI 的格式）
 */
export interface ToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/**
 * 工具注册表接口
 */
export interface IToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  getToolDefinitions(): OpenAIToolDefinition[]
  executeByName(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: ToolExecutionContext
  ): Promise<string>
  has(name: string): boolean
  getAll(): Tool[]
}

/**
 * SSE 工具调用事件
 */
export interface ToolCallEvent {
  type: 'tool_call'
  name: string
  query?: string // web_search 工具的搜索查询
  prompt?: string // generate_image 工具的图片描述
  sessionId: string
}

/**
 * SSE 工具结果事件
 */
export interface ToolResultEvent {
  type: 'tool_result'
  name: string
  resultCount?: number // web_search 工具的结果数量
  imageUrl?: string // generate_image 工具的图片 URL
  success: boolean
  sessionId: string
}

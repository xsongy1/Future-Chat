/**
 * 上下文管理器的共享类型
 *
 * 只放**被两个以上模块引用**的类型。单模块内部类型留在各自文件里，
 * 避免这个文件变成什么都往里塞的杂物间。
 */

/**
 * 一条历史消息（只包含真正会下发给模型的部分）
 *
 * 刻意不含 toolCalls / toolResults：当前链路不会把它们回放到上下文里
 * （见 prompt.builder 的说明），因此预算也按"实际下发的内容"计。
 * 若把不回放的字段计入预算，预算就会与真实请求对不上。
 */
export interface ContextHistoryMessage {
  id?: string
  role: string
  content: string | null
}

/**
 * 对话附件
 *
 * 与 ChatRequest.attachments 同构（name/content/type/size）。
 * 只有**当前轮**的附件会进入上下文：历史消息里存的 attachments 不会被回放，
 * 所以附件预算只针对当前消息（这一点在 docs/context-management.md 里写明）。
 */
export interface ContextAttachment {
  name: string
  content: string
  type?: string
  size?: number
}

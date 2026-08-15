/**
 * 工具调用语法残片清理（前端与服务端共享）
 *
 * 部分模型（如 Qwen）在流式输出中会偶发地把工具调用的语法残片当作普通文本输出，
 * 例如 `} </tool_call>`、```tool_call ... ``` 代码围栏等。
 * 这些内容不属于回答正文，渲染前应被移除。
 * 服务端持久化与客户端渲染共用，故置于 shared/ 中立共享层（lib/ 保持纯前端）。
 */

/**
 * 清理单个文本片段中的工具调用语法残片
 *
 * @param text - 原始文本片段
 * @returns 清理后的文本
 */
export function sanitizeToolCallSyntax(text: string): string {
  if (!text) return text

  return text
    // 移除 ```tool_call ... ``` 代码围栏块
    .replace(/```tool_call\s*[\s\S]*?```/gi, '')
    .replace(/```\/tool_call\s*[\s\S]*?```/gi, '')
    // 移除 `} </tool_call>` / `</tool_call> }` 等紧邻残片（整体移除，避免留下孤立的 `}`）
    .replace(/\s*\}\s*<\/?tool_call>\s*/gi, '')
    .replace(/\s*<\/?tool_call>\s*\}\s*/gi, '')
    // 移除独立的 <tool_call> / </tool_call> 标签
    .replace(/<\/?tool_call>/gi, '')
}

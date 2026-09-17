/**
 * 上传文档解析
 *
 * 当前项目原本只有 app/api/upload/route.ts 内联的解析逻辑：它把 .txt/.md 读成
 * 纯文本后直接返回给前端塞进对话上下文，不落盘也不落库——也就是说「文档」这个
 * 实体在项目里原本并不存在。RAG 需要可持久化、可切分、可检索的文档，
 * 所以这里补上这一层。
 *
 * 解析能力与 /api/upload 保持一致（仅 .txt / .md，纯文本读取），
 * 不引入 PDF / DOCX 解析依赖——那需要新增 npm 包并处理 standalone 构建下的
 * 原生依赖打包问题，超出本次最小改动范围。
 */

/** 与 /api/upload 保持一致的 MIME 白名单 */
const VALID_TYPES = ['text/plain', 'text/markdown']

/** 与 /api/upload 保持一致的扩展名白名单 */
const VALID_EXTENSIONS = ['.txt', '.md']

/** 与 /api/upload 保持一致的单文件上限（1MB） */
export const MAX_FILE_SIZE = 1024 * 1024

export interface ParsedDocument {
  name: string
  type: 'txt' | 'md'
  size: number
  content: string
}

export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentParseError'
  }
}

/**
 * 校验并解析上传文件为纯文本
 *
 * @throws DocumentParseError 文件类型/大小不合法，或内容为空
 */
export async function parseUploadedDocument(file: File): Promise<ParsedDocument> {
  const hasValidType = VALID_TYPES.includes(file.type)
  const hasValidExtension = VALID_EXTENSIONS.some((ext) =>
    file.name.toLowerCase().endsWith(ext)
  )

  if (!hasValidType && !hasValidExtension) {
    throw new DocumentParseError(
      '不支持的文件类型，目前仅支持 .txt 和 .md 文件'
    )
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new DocumentParseError(
      `文件过大，单文件上限 ${MAX_FILE_SIZE / 1024 / 1024}MB`
    )
  }

  const content = await file.text()

  if (!content.trim()) {
    throw new DocumentParseError('文件内容为空')
  }

  return {
    name: file.name,
    type: file.name.toLowerCase().endsWith('.md') ? 'md' : 'txt',
    size: file.size,
    content,
  }
}

/**
 * 文档切分（Chunking）
 *
 * 纯函数，无外部依赖、无 IO，便于单测与解释。
 *
 * 策略（刻意保持简单）：
 * 1. 统一换行 → 按空行切「段落」
 * 2. 超长段落 → 按句子边界切；仍超长 → 按长度硬切
 * 3. 贪心装箱：段落依次累加，超过 chunkSize 就落一块
 * 4. 相邻块之间保留 overlap 字符重叠，避免切点正好切断语义
 *    重叠只作为「落块时的前缀」拼进去，不参与装箱判断，
 *    否则会退化成「只含重叠尾巴」的碎片块
 *
 * 当前解析器只能拿到纯文本，所以 metadata 只记录文档内序号（index），
 * 不虚构页码 / 章节等拿不到的信息。
 */

/** 单块目标长度（字符） */
export const DEFAULT_CHUNK_SIZE = 800

/** 相邻块重叠长度（字符） */
export const DEFAULT_OVERLAP = 100

/** 小于该长度的尾块并入前一块，避免产生碎片 */
export const MIN_CHUNK_SIZE = 50

export interface Chunk {
  /** 文档内序号，从 0 开始 */
  index: number
  content: string
}

export interface ChunkOptions {
  chunkSize?: number
  overlap?: number
}

/**
 * 把段落拆成不超过 maxSize 的原子片段
 */
function splitIntoAtoms(text: string, maxSize: number): string[] {
  const atoms: string[] = []

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim()
    if (!trimmed) continue

    if (trimmed.length <= maxSize) {
      atoms.push(trimmed)
      continue
    }

    // 超长段落：先按中英文句末标点切
    const sentences = trimmed.split(/(?<=[。！？!?.;；\n])/)
    let buffer = ''

    for (const sentence of sentences) {
      // 单句仍超长（如无标点的长文本 / 代码）：按长度硬切
      if (sentence.length > maxSize) {
        if (buffer.trim()) {
          atoms.push(buffer)
          buffer = ''
        }
        for (let i = 0; i < sentence.length; i += maxSize) {
          atoms.push(sentence.slice(i, i + maxSize))
        }
        continue
      }

      if (buffer && buffer.length + sentence.length > maxSize) {
        atoms.push(buffer)
        buffer = ''
      }
      buffer += sentence
    }

    if (buffer.trim()) atoms.push(buffer)
  }

  return atoms
}

/**
 * 将文本切分为 chunk 列表
 *
 * @param text - 原始文本
 * @param options - chunkSize / overlap，均有默认值
 * @returns 按 index 升序排列的 chunk 列表；空文本返回空数组
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(options.chunkSize ?? DEFAULT_CHUNK_SIZE, MIN_CHUNK_SIZE)
  const overlap = Math.max(
    0,
    Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.floor(size / 2))
  )

  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  const atoms = splitIntoAtoms(normalized, size)

  const contents: string[] = []
  let buffer = ''
  let carry = '' // 上一块尾部的重叠前缀，仅在落块时拼接

  for (const atom of atoms) {
    if (buffer && buffer.length + atom.length + 1 > size) {
      contents.push(carry + buffer)
      carry = overlap > 0 ? buffer.slice(-overlap) : ''
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n${atom}` : atom
  }

  if (buffer) {
    if (contents.length > 0 && buffer.length < MIN_CHUNK_SIZE) {
      // 尾块过短：并入前一块
      contents[contents.length - 1] = `${contents[contents.length - 1]}\n${buffer}`
    } else {
      contents.push(carry + buffer)
    }
  }

  return contents.map((content, index) => ({ index, content: content.trim() }))
}

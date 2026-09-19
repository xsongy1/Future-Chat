/**
 * 把 React 子节点还原成纯文本
 *
 * 为什么必须有它：
 * MarkdownComponents 的 rehypePlugins 里有 rehype-highlight，代码块被高亮后
 * `<code>` 的子节点**不再是字符串**，而是一串 `<span class="hljs-*">` 元素。
 * 此时 `String(children)` 走的是 `Array.prototype.join(',')`，结果是
 * "[object Object],[object Object],..."——而元素之间还会被 join 塞进逗号。
 * 表现就是：屏幕上看着完全正常，复制出来全是乱码（复制按钮直接把这个坏字符串写进剪贴板）。
 *
 * 递归取文本而不是 String()：既保住原始空白与换行，
 * 也不会像 join 那样往代码里插入分隔符。
 */

import { isValidElement, type ReactNode } from 'react'

/** 递归拼接子节点的文本内容（null / undefined / 布尔值按 React 语义忽略） */
export function reactNodeToPlainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'bigint') return String(node)
  if (Array.isArray(node)) return node.map((child) => reactNodeToPlainText(child)).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return reactNodeToPlainText(node.props.children)
  }
  return ''
}

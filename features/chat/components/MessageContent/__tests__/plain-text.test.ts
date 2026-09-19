/**
 * reactNodeToPlainText 单测
 *
 * 核心断言：高亮后的代码块（子节点是一串 <span> 元素）取出的文本
 * 必须与原始代码逐字符一致——这正是"屏幕正常、复制乱码"那个 bug 的判据。
 */

import { describe, it, expect } from 'vitest'
import { createElement, Fragment, type ReactNode } from 'react'
import { reactNodeToPlainText } from '../plain-text'

/** 模拟 rehype-highlight 产出的子节点：关键字/数字被 span 包裹，标点与空白是纯文本 */
function highlighted(parts: Array<[string, string] | string>): ReactNode[] {
  return parts.map((part) =>
    typeof part === 'string' ? part : createElement('span', { className: part[0] }, part[1])
  )
}

describe('reactNodeToPlainText', () => {
  it('纯字符串原样返回（含换行与缩进）', () => {
    const code = 'def f(x):\n    return x + 1\n'
    expect(reactNodeToPlainText(code)).toBe(code)
  })

  it('数字转成字符串', () => {
    expect(reactNodeToPlainText(42)).toBe('42')
  })

  it('数组按空字符串拼接，而不是 join(",")', () => {
    const children = highlighted([
      ['hljs-keyword', 'def'],
      ' ',
      ['hljs-title', 'f'],
      '(x):\n',
    ])

    expect(reactNodeToPlainText(children)).toBe('def f(x):\n')
    // 回归点：旧实现 String(children) 会产出 [object Object] 并用逗号拼接
    expect(String(children)).toContain('[object Object]')
    expect(reactNodeToPlainText(children)).not.toContain('[object Object]')
    expect(reactNodeToPlainText(children)).not.toContain(',')
  })

  it('多行高亮代码逐字符保真（缩进/换行/标点都不丢）', () => {
    const source = 'for i in range(n - 2):\n    if nums[i] > 0:\n        break\n'
    const children = highlighted([
      ['hljs-keyword', 'for'],
      ' ',
      ['hljs-variable', 'i'],
      ' in ',
      ['hljs-built_in', 'range'],
      '(',
      ['hljs-variable', 'n'],
      ' - ',
      ['hljs-number', '2'],
      '):\n    ',
      ['hljs-keyword', 'if'],
      ' ',
      ['hljs-variable', 'nums'],
      '[',
      ['hljs-variable', 'i'],
      '] > ',
      ['hljs-number', '0'],
      ':\n        ',
      ['hljs-keyword', 'break'],
      '\n',
    ])

    expect(reactNodeToPlainText(children)).toBe(source)
  })

  it('嵌套元素递归取文本', () => {
    const node = createElement(
      'code',
      null,
      createElement('span', { className: 'hljs-string' }, createElement('em', null, 'a')),
      'b'
    )
    expect(reactNodeToPlainText(node)).toBe('ab')
  })

  it('null / undefined / 布尔值按 React 语义忽略', () => {
    expect(reactNodeToPlainText([null, undefined, false, true, 'x'])).toBe('x')
    expect(reactNodeToPlainText(null)).toBe('')
  })

  it('Fragment 与数组混用也能拼对', () => {
    const node = createElement(Fragment, null, ['a', createElement('span', null, 'b')], 'c')
    expect(reactNodeToPlainText(node)).toBe('abc')
  })
})

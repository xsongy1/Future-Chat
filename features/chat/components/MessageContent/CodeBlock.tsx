'use client'

import { CopyButton } from './CopyButton'
import { reactNodeToPlainText } from './plain-text'

interface CodeBlockProps {
  inline?: boolean
  className?: string
  children: React.ReactNode
}

export function CodeBlock({ inline, className, children }: CodeBlockProps) {
  const match = /language-(\w+)/.exec(className || '')
  const language = match ? match[1] : ''
  // 不能用 String(children)：被 rehype-highlight 高亮后 children 是一串元素，
  // String() 会 join(',') 成 "[object Object],..."，复制出来全是乱码
  const code = reactNodeToPlainText(children).replace(/\n$/, '')

  if (inline) {
    return (
      <code className="rounded px-1.5 py-0.5 text-sm font-mono bg-white dark:bg-gray-800">
        {children}
      </code>
    )
  }

  return (
    <div className="group relative my-4 rounded-lg bg-white dark:bg-gray-800">
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 rounded-t-lg">
        <span className="text-xs font-medium text-muted-foreground">
          {language || 'text'}
        </span>
        <div className="opacity-60 group-hover:opacity-100 transition-opacity">
        <CopyButton text={code} />
        </div>
      </div>

      <pre className="!mt-0 overflow-x-auto bg-white dark:bg-gray-800 px-4 pb-4 pt-3">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
}


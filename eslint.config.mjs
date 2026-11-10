import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript', 'prettier'),
  {
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'types/next-auth.d.ts',
      'packages/future-monitor-sdk/dist/**',
      // docs/ 在 .gitignore 内，只存放本地生成的基准报告与测量产物
      // （含压缩后的 SDK bundle、.mts 脚本），不是源码，不参与 lint
      'docs/**',
    ],
  },
  {
    rules: {
      // 允许以 _ 开头的未使用变量
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
]

export default eslintConfig

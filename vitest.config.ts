import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // 项目源码统一用 @/ 别名导入，vitest 默认不认，这里对齐 tsconfig 的 paths
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/sky-monitor/tests/**/*.test.ts',
      // 服务端纯逻辑测试（如 RAG chunker / retrieval）：不依赖 DB 与网络，可直接跑
      'server/**/__tests__/**/*.test.ts',
    ],
  },
})

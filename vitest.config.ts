import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // 项目源码统一用 @/ 别名导入，vitest 默认不认，这里对齐 tsconfig 的 paths
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      // 与 tsconfig paths 对齐：测试直接跑 SDK 源码，避免误用过期的 dist 产物
      // （顺序有意义：/debug 必须排在包名之前，否则会被前缀匹配吃掉）
      'future-monitor-sdk/debug': fileURLToPath(
        new URL('./packages/future-monitor-sdk/src/debug/index.ts', import.meta.url)
      ),
      'future-monitor-sdk': fileURLToPath(
        new URL('./packages/future-monitor-sdk/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/future-monitor-sdk/tests/**/*.test.ts',
      // 服务端纯逻辑测试（如 RAG chunker / retrieval）：不依赖 DB 与网络，可直接跑
      'server/**/__tests__/**/*.test.ts',
      // 应用层纯逻辑测试（SSE 解析 / 流式埋点 / 埋点封装）：不依赖浏览器与 React
      'features/**/__tests__/**/*.test.ts',
      'lib/**/__tests__/**/*.test.ts',
    ],
  },
})

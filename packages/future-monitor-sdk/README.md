# Future-monitor-sdk

轻量级 AI 应用监控 SDK（工作区包 `packages/future-monitor-sdk`，包名 `future-monitor-sdk`）。核心 gzip ≈ 1.4KB（tree-shaking 后），面向 LLM 对话场景：

- **SSE 链路追踪**：完整生命周期（TTFB / First Chunk Latency / TTFT / TTFA / TTLB）、阶段拆分（thinking/answer）、工具调用链路、卡顿检测（sse_stall/sse_resume）、重试链路串联（previousTraceId）
- **错误监控**：JS 错误 / Promise 拒绝 / 资源加载失败 / console.error，忽略规则 + 窗口去重
- **性能采集**：Web Vitals（FCP/LCP/CLS/INP）+ 页面导航时序
- **网络监控**：fetch / XHR 拦截，请求耗时与状态
- **智能上报**：批处理（10 条/5s）+ 关键事件直发 + 指数退避重试 + 离线持久化（断网补发）
- **采样**：random / session 模式、按类型采样率、关键事件永远 100%
- **调试面板**（`future-monitor-sdk/debug`，仅开发环境、源码内子路径）：事件流 / Trace / 性能 / 网络 / 会话 / 队列实时可视化

## 架构

```
插件管道（按 priority 自动排序，与注册顺序无关）：
  debug(1000) → error/performance/network(200) → dedupe(100) → sampling(50) → transport(-1000)
```

核心不依赖 React；调试面板通过 `./debug` 子路径按需加载（详见 §6 的路径说明）。

---

## 1. 安装

```bash
# 工作区内（推荐）：packages/future-monitor-sdk 已在 pnpm-workspace.yaml 中
pnpm add future-monitor-sdk

# 或作为独立包发布后
npm install future-monitor-sdk
```

> Next.js 用户：确认 `tsconfig.json` 有路径映射，或 `next.config.ts` 配 `transpilePackages: ['future-monitor-sdk']`（本仓库两种都已配好）。

## 2. 初始化（单例 + 插件装配）

建议封装成单例模块（参考本项目 `lib/monitor/index.ts`），全局只初始化一次：

```ts
import {
  Monitor, ErrorPlugin, PerformancePlugin, NetworkPlugin,
  DedupePlugin, SamplingPlugin, TransportPlugin, DebugPlugin,
  BrowserStorage, BrowserTransport,
} from 'future-monitor-sdk'

const isDev = process.env.NODE_ENV === 'development'

function initMonitor(): Monitor {
  const endpoint = '/api/monitor'
  const monitor = new Monitor({ appId: 'my-app', debug: isDev })

  // 调试面板（仅开发）
  if (isDev) monitor.use(new DebugPlugin({ maxEvents: 500 }))

  // 采集
  monitor.use(new ErrorPlugin({ ignoreErrors: [/ResizeObserver/i] }))
  monitor.use(new PerformancePlugin())
  monitor.use(new NetworkPlugin({ excludeUrls: [/\/api\/monitor/] }))

  // 处理
  monitor.use(new DedupePlugin({ windowMs: 1000 }))
  monitor.use(new SamplingPlugin({            // 可选：生产降采样
    rate: 0.1, mode: 'session',
    alwaysSample: ['sse_error', 'js_error', 'promise_error'],
  }))

  // 上报（必须最后一个注册，priority 已保证顺序）
  monitor.use(new TransportPlugin({
    endpoint,
    transport: new BrowserTransport({ endpoint }),
    mode: 'batch',            // batch | immediate
    batchSize: 10,
    flushInterval: 5000,
    maxRetries: 3,
    criticalTypes: ['sse_error', 'js_error', 'promise_error'],
    offlineStorage: new BrowserStorage(),   // 断网持久化，恢复后补发
  }))

  return monitor
}

// 懒加载单例（服务端渲染返回 null）
let monitor: Monitor | null = null
export function getMonitor(): Monitor | null {
  if (typeof window === 'undefined') return null
  if (!monitor) monitor = initMonitor()
  return monitor
}
```

## 3. 手动埋点

```ts
const monitor = getMonitor()

// 附加全局上下文（自动写入每个事件的 context）
monitor.setContext({ userId: 'u_123', version: '1.2.0' })

// 自定义事件
monitor.track('button_click', { name: 'send' })
```

## 4. SSE 链路追踪（AI 场景核心）

```ts
const monitor = getMonitor()
const trace = monitor.createTrace({
  aiMessageId: 'msg_abc123',
  previousTraceId: 'trc_xxx',   // 重试时传原 Trace ID，串联重试链路
  stallThreshold: 3000,          // 卡顿阈值（默认 3000ms）
})
monitor.setCurrentTrace(trace)
trace.start()                     // → sse_start

// ...SSE 流式过程中：
trace.markRequestStart({ url: '/api/chat' })  // T0：fetch 之前，所有延迟指标的基准
// const res = await fetch('/api/chat', ...)
trace.firstByte()                 // 首字节（响应头到达）→ sse_first_byte (TTFB)
// const { value } = await reader.read()
trace.rawChunk(value.byteLength)  // 每个数据块 → 首个即 sse_first_chunk (First Chunk Latency)
// 首个带内容的增量帧
trace.firstToken('thinking')      // 首个 token → sse_first_token (TTFT)
trace.recordChunk()               // 每个 SSE 事件调用 → 事件计数 + 卡顿检测
trace.phaseStart('thinking')      // → phase_start
trace.phaseEnd('thinking')        // → phase_end

trace.toolStart('web_search', { query: 'AI' }, 'tool_123')   // → tool_start
trace.toolEnd('web_search', { toolCallId: 'tool_123', success: true, resultCount: 5 })
                                                                // → tool_end

trace.complete()                  // 流真正关闭时调用 → sse_complete（TTLB = 末字节）
// trace.error('模型超时')        // 出错 → sse_error
// trace.abort('user_cancel')     // 用户取消 → sse_abort
monitor.setCurrentTrace(null)
```

> 建议封装一层 helper（参考本项目 `lib/monitor/trace-helper.ts`），
> 让业务代码只调 `startTrace / markRequestStart / markFirstByte / recordRawChunk / endTrace`，
> Monitor 未初始化时全部静默返回，不抛错。

### 延迟指标口径

五个指标共用同一个基准 **T0 = 请求真正发出的时刻**（`markRequestStart()`），
所以它们可以直接互相比较、相减；指标 = 事件时刻 − T0。

| 指标 | 含义 | 触发方法 | 事件 |
|---|---|---|---|
| **TTFB** | 首字节：HTTP 响应头到达客户端 | `firstByte()`（`await fetch()` 之后立刻调用），结束后由 Resource Timing 校准 | `sse_first_byte` |
| **First Chunk Latency** | 首个响应体数据块（`read()` 首次拿到字节） | `rawChunk()` / `firstChunk()` | `sse_first_chunk` |
| **TTFT** | 首个模型生成的 token（首个带内容的 thinking/answer 增量） | `firstToken(phase)` | `sse_first_token` |
| **TTFA** | 首个 answer token（思考型模型另算） | `firstToken('answer')` | 随 `sse_complete` 给出 |
| **TTLB** | 末字节：流关闭 | `complete()`（流真正结束时） | `sse_complete` |

恒等关系（网络物理决定的）：`0 ≤ TTFB ≤ First Chunk Latency ≤ TTFT ≤ TTLB`

- **TTFB 里没有模型生成时间**：它只到"响应头到达"，反映 DNS/TCP/TLS/排队 + 服务端首包。
- **首块延迟**比 TTFB 多出服务端把首块 flush 出来的时间。
- **TTFT** 比首块延迟多出模型首 token 生成时间：首个数据块可能只含 role 帧、usage 帧、
  心跳或半条 SSE 帧，所以不能用首块延迟冒充 TTFB（那会把模型生成时间算进网络指标）。
- 结束时 `complete()` / `error()` / `abort()` 会用 Resource Timing 的 `responseStart`
  把 TTFB 从"主线程观测到的响应头时刻"校准为"网络层首字节"，事件里用 `ttfbSource` 标明来源
  （`fetch-headers` / `resource-timing`）。同步这次通常取不到条目（浏览器一般在响应体收完后才写入），
  因此还会补一次 0ms 延迟读取，命中就补发一条 `sse_first_byte`，载荷带 `refined: true`：
  **同一 traceId 内，带 `refined` 的那条是 TTFB 最终值**（面板会自动回填到已归档的 Trace）。
  两次都取不到就保留 `fetch-headers` 原值——不编造数字，也不会把 TTFB 改大。
- 任何结束方式都会先关闭仍未闭合的阶段（`phase_end` 带 `auto: true`），
  所以用户点停止这类"先结束 Trace、后抛 AbortError"的顺序也不会留下永远"进行中"的阶段。

## 5. 会话管理

```ts
// 页面加载时
monitor.startSession()            // → session_start

// 页面可见性变化（visibilitychange）
monitor.setSessionVisible(document.visibilityState === 'visible')
                                  // → session_visibility（session_end 里也会带上 isVisible）

// 每次对话/工具调用自动计数（由 trace-helper 调用）
monitor.getSession()?.incrementTraceCount()
monitor.getSession()?.incrementToolUsage('web_search')

// 页面卸载时
monitor.endSession()              // → session_end（附带 traceCount / toolUsage / isVisible 统计）
```

React 场景用 `MonitorProvider` 管理生命周期（本项目 `lib/monitor/MonitorProvider.tsx`）。

## 6. 调试面板（开发环境）

> **`future-monitor-sdk/debug` 是源码内子路径，不是发布产物。** 面板依赖宿主的设计系统
> （`@/components/ui/*`），因此不随 npm 包发布（见 `scripts/build.mjs`），`package.json` 的
> `exports` 里也没有 `./debug` 条目——外部安装的包直接 `import 'future-monitor-sdk/debug'`
> 会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。它靠宿主 tsconfig 的 `paths`（本仓库映射到
> `./packages/future-monitor-sdk/src/*`）解析，仅在仓库内可用。

```tsx
// React 应用中（懒加载 + 仅 dev）
import { DebugPanel, useDebugSubscription } from 'future-monitor-sdk/debug'

function App() {
  const { status, error } = useDebugSubscription()
  if (process.env.NODE_ENV !== 'development') return null
  return <DebugPanel connectionStatus={status} connectionError={error} />
}
```

面板能力：**事件**实时流（过滤/搜索/详情）、**Trace** 时间线（阶段/工具/耗时/历史）、**性能** Web Vitals、**网络**请求列表、**会话**统计、**队列**（待发送/离线 + 立即发送/清空）、**回放**占位；右上角菜单可一键触发测试错误/请求/自定义事件。

## 7. 后端对接

SDK 以"单条或数组"批量 POST 事件到 `endpoint`：

```json
[
  {
    "id": "evt_xxx",
    "type": "sse_complete",
    "timestamp": 1755417600000,
    "data": {
      "traceId": "trc_xxx",
      "ttlb": 3200,
      "ttfb": 180,
      "ttfbSource": "fetch-headers",
      "firstChunkLatency": 220,
      "ttft": 460,
      "ttftPhase": "thinking",
      "ttfa": 1520,
      "chunkCount": 42,
      "rawChunkCount": 18,
      "bytesReceived": 20481
    },
    "context": { "appId": "my-app", "sessionId": "ses_xxx", "traceId": "trc_xxx", "userId": "u_1" }
  }
]
```

参考实现：本项目 `app/api/monitor/route.ts`（校验 + 按 id 去重 + 维度列落库）。

## 8. 生产配置建议

| 项 | 建议 |
|---|---|
| 采样率 | 生产设 `rate: 0.1`（session 模式），错误事件 100% 上报 |
| 上报模式 | `batch`（10 条 / 5s），错误类走 `criticalTypes` 直发 |
| 离线存储 | 开启 `offlineStorage`，弱网/断网不丢数据 |
| 忽略规则 | `ErrorPlugin.ignoreErrors` 过滤第三方噪音（ResizeObserver 等） |
| 上报排除 | `NetworkPlugin.excludeUrls` 排除 `/api/monitor` 自身 |

本仓库支持环境变量 `NEXT_PUBLIC_MONITOR_SAMPLE_RATE`（默认 1=全量，设 `0.1` 即生产降采样）。

## 事件类型

| 类别 | 事件 |
|---|---|
| SSE 链路 | `sse_start` `sse_first_byte` `sse_first_chunk` `sse_first_token` `sse_stall` `sse_resume` `phase_start` `phase_end` `tool_start` `tool_end` `sse_usage` `sse_complete` `sse_error` `sse_abort` |
| 会话 | `session_start` `session_end` |
| 错误 | `js_error` `promise_error` `resource_error` `console_error` |
| 性能 | `web_vital` `page_loaded` |
| 网络 | `http_request` |

## 测试

```bash
pnpm test          # vitest：管道排序 / 去重 / 采样 / 批处理 / 退避重试 / 离线恢复 / Trace 生命周期
```

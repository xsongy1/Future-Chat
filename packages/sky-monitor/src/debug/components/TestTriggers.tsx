/**
 * 测试触发器组件
 *
 * 分组：
 * - 错误测试：JS 错误 / Promise 错误（真实浏览器错误捕获）
 * - 网络测试：测试请求
 * - AI 链路模拟：完整/用量/限流/服务端错误/超时/中止/重试（走真实 Trace API）
 * - 用户行为：复制 / 重新生成 / 停止生成（user_action 事件）
 * - 自定义事件
 */

'use client'

import { Settings2, AlertCircle, Globe, Zap, Bot, Timer, RefreshCw, Hand, Copy, RotateCw, Square } from 'lucide-react'

// ShadcnUI 组件
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** DebugPlugin 模拟 API 类型 */
interface DebugPluginWithSimulate {
  track?: (type: string, data: Record<string, unknown>) => void
  simulateTrace?: (
    kind: 'success' | 'error' | 'abort' | 'usage' | 'retry',
    options?: { model?: string; error?: Record<string, unknown> }
  ) => string | null
  simulateUserAction?: (action: string, detail?: Record<string, unknown>) => void
}

function getDebugPlugin(): DebugPluginWithSimulate | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as Record<string, DebugPluginWithSimulate | undefined>)
    .__SKY_MONITOR_DEBUG__ ?? null
}

export function TestTriggers() {
  return (
    <TooltipProvider>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <Settings2 className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>
            <p>测试工具</p>
          </TooltipContent>
        </Tooltip>

        <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
          {/* ========== AI 链路模拟 ========== */}
          <DropdownMenuLabel className="text-xs flex items-center gap-1">
            <Bot className="w-3 h-3 text-blue-500" /> AI 链路模拟
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => simulateTrace('success')} className="text-xs">
            <Bot className="w-3 h-3 mr-2 text-blue-500" />
            模拟成功回答
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => simulateTrace('usage')} className="text-xs">
            <Zap className="w-3 h-3 mr-2 text-green-500" />
            模拟成功 + Token 用量/成本
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              simulateTrace('error', {
                error: { code: 'RATE_LIMIT', message: '模拟：请求频率超限', statusCode: 429, retryable: true },
              })
            }
            className="text-xs"
          >
            <Timer className="w-3 h-3 mr-2 text-orange-500" />
            模拟限流错误 (RATE_LIMIT 429)
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              simulateTrace('error', {
                error: { code: 'PROVIDER_ERROR', message: '模拟：上游服务异常', statusCode: 500, retryable: true },
              })
            }
            className="text-xs"
          >
            <AlertCircle className="w-3 h-3 mr-2 text-red-500" />
            模拟服务端错误 (PROVIDER_ERROR 500)
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              simulateTrace('error', {
                error: { code: 'TIMEOUT', message: '模拟：响应超时', retryable: true },
              })
            }
            className="text-xs"
          >
            <Timer className="w-3 h-3 mr-2 text-yellow-500" />
            模拟超时 (TIMEOUT)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => simulateTrace('abort')} className="text-xs">
            <Hand className="w-3 h-3 mr-2 text-amber-500" />
            模拟用户中止
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => simulateTrace('retry')} className="text-xs">
            <RefreshCw className="w-3 h-3 mr-2 text-purple-500" />
            模拟重试链路（串联 previousTraceId）
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* ========== 用户行为 ========== */}
          <DropdownMenuLabel className="text-xs flex items-center gap-1">
            <RotateCw className="w-3 h-3 text-green-500" /> 用户行为
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => simulateUserAction('copy', { role: 'assistant' })} className="text-xs">
            <Copy className="w-3 h-3 mr-2 text-blue-500" />
            复制消息
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => simulateUserAction('regenerate')} className="text-xs">
            <RotateCw className="w-3 h-3 mr-2 text-purple-500" />
            重新生成
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => simulateUserAction('stop_generation')} className="text-xs">
            <Square className="w-3 h-3 mr-2 text-red-500" />
            停止生成
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* ========== 错误测试（真实浏览器错误） ========== */}
          <DropdownMenuLabel className="text-xs flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-red-500" /> 错误测试
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={triggerTestError} className="text-xs">
            <AlertCircle className="w-3 h-3 mr-2 text-red-500" />
            触发 JS 错误
          </DropdownMenuItem>
          <DropdownMenuItem onClick={triggerPromiseError} className="text-xs">
            <AlertCircle className="w-3 h-3 mr-2 text-orange-500" />
            触发 Promise 错误
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* ========== 网络测试 ========== */}
          <DropdownMenuLabel className="text-xs flex items-center gap-1">
            <Globe className="w-3 h-3 text-blue-500" /> 网络测试
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={triggerTestRequest} className="text-xs">
            <Globe className="w-3 h-3 mr-2 text-blue-500" />
            触发测试请求
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* ========== 自定义事件 ========== */}
          <DropdownMenuLabel className="text-xs">自定义事件</DropdownMenuLabel>
          <DropdownMenuItem onClick={triggerCustomEvent} className="text-xs">
            <Zap className="w-3 h-3 mr-2 text-green-500" />
            发送自定义事件
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}

// ==================== AI 链路模拟 ====================

function simulateTrace(
  kind: 'success' | 'error' | 'abort' | 'usage' | 'retry',
  options?: { model?: string; error?: Record<string, unknown> }
): void {
  getDebugPlugin()?.simulateTrace?.(kind, options)
}

function simulateUserAction(action: string, detail?: Record<string, unknown>): void {
  getDebugPlugin()?.simulateUserAction?.(action, detail)
}

// ==================== 错误测试 ====================

/** 触发测试 JS 错误 */
function triggerTestError(): void {
  setTimeout(() => {
    throw new Error('[Test] 这是一个测试错误')
  }, 0)
}

/** 触发测试 Promise 错误 */
function triggerPromiseError(): void {
  Promise.reject(new Error('[Test] 这是一个 Promise 错误'))
}

// ==================== 网络测试 ====================

/** 触发测试 HTTP 请求 */
function triggerTestRequest(): void {
  fetch('/api/test-debug-panel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ test: true, timestamp: Date.now() }),
  }).catch(() => {
    // 预期会失败，用于测试错误请求
  })
}

// ==================== 自定义事件 ====================

/** 触发自定义事件 */
function triggerCustomEvent(): void {
  getDebugPlugin()?.track?.('custom_test', {
    message: '这是一个自定义测试事件',
    timestamp: Date.now(),
  })
}

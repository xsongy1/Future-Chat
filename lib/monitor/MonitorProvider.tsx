/**
 * MonitorProvider 组件
 *
 * 在应用入口初始化 Monitor，管理会话生命周期
 */

'use client'

import { useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react'
import { getMonitor } from './index'
import { useDebugSubscription } from 'future-monitor-sdk/debug'

// 懒加载 DebugPanel（仅开发环境）
const DebugPanel = lazy(() =>
  import('future-monitor-sdk/debug').then((m) => ({ default: m.DebugPanel }))
)

interface MonitorProviderProps {
  children: ReactNode
}

const isDev = process.env.NODE_ENV === 'development'

/**
 * Monitor 提供者组件
 * 负责启动和结束会话
 */
export function MonitorProvider({ children }: MonitorProviderProps) {
  const [isClient, setIsClient] = useState(false)

  // 延迟结束会话的定时器：StrictMode 立即重跑时用它取消那次"假结束"
  const deferredEndRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 开发环境：使用 hook 订阅 DebugPlugin 事件
  // 注意：Hook 必须无条件调用，但内部逻辑会根据 isDev 决定是否真正订阅
  const debugState = useDebugSubscription()
  const { status, error } = isDev
    ? debugState
    : { status: 'connected' as const, error: null }

  useEffect(() => {
    setIsClient(true)

    // 服务端渲染时跳过
    if (typeof window === 'undefined') return

    // 本次 effect 重跑：先取消上一次挂起的"延迟结束"，StrictMode 双调用时会话得以存活
    if (deferredEndRef.current !== null) {
      clearTimeout(deferredEndRef.current)
      deferredEndRef.current = null
    }

    try {
      const monitor = getMonitor()
      if (!monitor) return

      // 启动会话（已有会话就复用，避免重跑产生第二个空会话）
      if (!monitor.getSession()) {
        monitor.startSession()
      }

      // 页面卸载时结束会话
      // effect cleanup 在关页/刷新/跳转外部站点时不会执行，必须用 pagehide 兜底，
      // 否则 session_end（携带 traceCount / toolUsage 聚合）在最常见的结束方式里直接丢失
      const handlePageHide = () => {
        try {
          monitor.endSession()
        } catch (e) {
          console.warn('[Monitor] endSession error:', e)
        }
        // 立刻 flush：TransportPlugin 自己的 pagehide 监听注册更早、此时已跑过，
        // 不 flush 的话这条 session_end 会留在批缓冲里发不出去
        try {
          void monitor.flush()
        } catch (e) {
          console.warn('[Monitor] flush error:', e)
        }
      }

      const handleVisibilityChange = () => {
        try {
          monitor.setSessionVisible(document.visibilityState === 'visible')
        } catch (e) {
          console.warn('[Monitor] setSessionVisible error:', e)
        }
      }

      window.addEventListener('pagehide', handlePageHide)
      document.addEventListener('visibilitychange', handleVisibilityChange)

      return () => {
        window.removeEventListener('pagehide', handlePageHide)
        document.removeEventListener('visibilitychange', handleVisibilityChange)

        // 延后一个 tick 再结束：StrictMode 的立即重跑会先把定时器清掉（会话保住），
        // 而真正的卸载仍能正常上报 session_end
        deferredEndRef.current = setTimeout(() => {
          deferredEndRef.current = null
          try {
            monitor.endSession()
          } catch (e) {
            console.warn('[Monitor] endSession error:', e)
          }
        }, 0)
      }
    } catch (e) {
      console.warn('[Monitor] init error:', e)
    }
  }, [])

  return (
    <>
      {children}
      {/* 开发环境显示调试面板 */}
      {isDev && isClient && (
        <Suspense fallback={null}>
          <DebugPanel connectionStatus={status} connectionError={error} />
        </Suspense>
      )}
    </>
  )
}

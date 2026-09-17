'use client'

/**
 * AuthGuard Component - 认证守卫组件
 * 
 * 统一处理页面级别的认证逻辑：
 * - 自动显示加载状态
 * - 未登录时显示登录对话框
 * - 可选择未登录时的行为（重定向或仅显示对话框）
 * 
 * @module components/AuthGuard
 */

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/features/auth/hooks/use-auth'
import { LoginDialog } from '@/features/auth/components/LoginDialog'

interface AuthGuardProps {
  /** 子组件 */
  children: React.ReactNode
  /** 未登录时是否重定向到指定路径 */
  redirectTo?: string | null
}

/**
 * 认证守卫组件
 * 
 * @example
 * ```tsx
 * // 基础用法：未登录时显示登录对话框
 * <AuthGuard>
 *   <YourProtectedContent />
 * </AuthGuard>
 * 
 * // 未登录时重定向到首页
 * <AuthGuard redirectTo="/">
 *   <YourProtectedContent />
 * </AuthGuard>
 * 
 * // 自定义文本
 * <AuthGuard 
 *   loadingText="验证身份中..." 
 *   unauthenticatedText="请登录以继续"
 * >
 *   <YourProtectedContent />
 * </AuthGuard>
 * ```
 */
export function AuthGuard({
  children,
  redirectTo = null,
}: AuthGuardProps) {
  const router = useRouter()
  const { isLoading, isAuthenticated, showLoginDialog } = useAuth()
  const [hasRedirected, setHasRedirected] = useState(false)

  // 处理未登录时的重定向
  useEffect(() => {
    // 等待认证完成
    if (isLoading) return

    // 已登录，清除重定向标记
    if (isAuthenticated) {
      setHasRedirected(false)
      return
    }

    // 未登录且需要重定向
    if (!isAuthenticated && redirectTo && !hasRedirected) {
      setHasRedirected(true)
      router.push(redirectTo)
    }
  }, [isLoading, isAuthenticated, redirectTo, hasRedirected, router])

  // 正在加载认证状态
  // 注意：这里必须给一个可见的占位。useSession() 的 loading 发生在客户端水合之后，
  // 路由级的 loading.tsx 不会覆盖它——之前返回 null 会让 /chat 出现纯白屏
  // （首次访问还要等 dev 编译 + /api/auth/session 返回，白屏会持续数秒）。
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">正在验证身份...</div>
      </div>
    )
  }

  // 未登录
  if (!isAuthenticated) {
    // 如果设置了重定向，显示占位而不是白屏，等待上面的 effect 跳转
    if (redirectTo) {
      return (
        <div className="flex h-screen items-center justify-center">
          <div className="text-muted-foreground">正在跳转...</div>
        </div>
      )
    }

    // 没有设置重定向，显示登录对话框
    return <LoginDialog open={showLoginDialog} />
  }

  // 已登录，渲染子组件
  return (
    <>
      <LoginDialog open={showLoginDialog} />
      {children}
    </>
  )
}


import type { Metadata } from 'next'
import './globals.css'
import { Providers } from '@/components/Providers'
import { Toaster } from '@/components/ui/toaster'
import { AccountLinkNotification } from '@/features/auth/components/AccountLinkNotification'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { GeoChecker } from '@/components/GeoChecker'

export const metadata: Metadata = {
  title: 'Future-Chat',
  description: 'Future-Chat - AI 智能对话助手（硅基流动模型 + Tool Calling + 私有知识库）',
  icons: {
    icon: '/icon.svg',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <ErrorBoundary>
          <Providers>
            {children}
            <Toaster />
            <AccountLinkNotification />
            <GeoChecker />
          </Providers>
        </ErrorBoundary>
      </body>
    </html>
  )
}

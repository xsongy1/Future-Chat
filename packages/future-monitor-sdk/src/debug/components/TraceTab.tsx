/**
 * Trace 追踪 Tab
 */

'use client'

import { useDebugStore } from '../store'
import type { TraceData, PhaseData, ToolData } from '../types'

// ShadcnUI 组件
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'

export function TraceTab() {
  const { currentTrace, traceHistory } = useDebugStore()

  return (
    <div className="flex flex-col h-full">
      {/* 当前 Trace */}
      {currentTrace ? (
        <div className="p-3 border-b">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span className="text-sm font-medium">当前 Trace</span>
            <Badge variant="outline" className={getStateBadgeClass(currentTrace.state)}>
              {currentTrace.state}
            </Badge>
          </div>
          <TraceDetail trace={currentTrace} />
        </div>
      ) : (
        <div className="p-3 text-center text-muted-foreground text-sm border-b">
          暂无活跃 Trace
        </div>
      )}

      {/* Trace 历史 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-3 py-2 text-xs text-muted-foreground border-b">
          历史记录 ({traceHistory.length})
        </div>
        <ScrollArea className="flex-1">
          {traceHistory.length === 0 ? (
            <div className="p-3 text-center text-muted-foreground/60 text-sm">
              暂无历史
            </div>
          ) : (
            traceHistory.map((trace) => (
              <div key={trace.traceId} className="p-3 border-b">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="outline" className={getStateBadgeClass(trace.state)}>
                    {trace.state}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDuration(trace.metrics.duration)}
                  </span>
                </div>
                <TraceDetail trace={trace} compact />
              </div>
            ))
          )}
        </ScrollArea>
      </div>
    </div>
  )
}

/** Trace 详情 */
function TraceDetail({ trace, compact = false }: { trace: TraceData; compact?: boolean }) {
  const { metrics } = trace

  return (
    <div className="space-y-2">
      {/* 基本信息 */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">Trace ID: </span>
          <span className="font-mono">{trace.traceId.slice(0, 8)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">耗时: </span>
          <span>{formatDuration(metrics.duration)}</span>
        </div>
      </div>

      {/* 延迟指标：口径见 SDK core/trace.ts，全部相对 T0（请求发出） */}
      <div className="rounded-md bg-muted/50 p-2 space-y-1 text-xs">
        <MetricRow
          label="TTFB"
          hint="首字节（响应头）"
          value={metrics.ttfb}
          suffix={metrics.ttfbSource === 'resource-timing' ? ' *' : ''}
        />
        <MetricRow
          label="FCL"
          hint="首个数据块"
          value={metrics.firstChunkLatency}
        />
        <MetricRow
          label="TTFT"
          hint={metrics.ttftPhase ? `首个 token（${metrics.ttftPhase}）` : '首个 token'}
          value={metrics.ttft}
        />
        {metrics.ttfa !== undefined && (
          <MetricRow label="TTFA" hint="首个 answer token" value={metrics.ttfa} />
        )}
        {metrics.ttfbSource === 'resource-timing' && (
          <div className="text-[10px] text-muted-foreground/70">
            * TTFB 已用 Resource Timing 校准为网络层首字节
          </div>
        )}
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">SSE 事件: </span>
            <span>{metrics.chunkCount ?? 0}</span>
          </div>
          <div>
            <span className="text-muted-foreground">数据块: </span>
            <span>{metrics.rawChunkCount ?? 0}</span>
          </div>
        </div>
      )}

      {/* Token 用量与成本（sse_usage 事件） */}
      {trace.usage && (
        <div className="rounded-md bg-muted/50 p-2 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Token 用量</span>
            {trace.usage.tokensPerSec ? (
              <span className="text-muted-foreground/70">{trace.usage.tokensPerSec} tok/s</span>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-1 text-center">
            <div>
              <div className="font-mono text-blue-500">{trace.usage.inputTokens ?? '-'}</div>
              <div className="text-muted-foreground/60">输入</div>
            </div>
            <div>
              <div className="font-mono text-green-500">{trace.usage.outputTokens ?? '-'}</div>
              <div className="text-muted-foreground/60">输出</div>
            </div>
            <div>
              <div className="font-mono text-foreground">{trace.usage.totalTokens ?? '-'}</div>
              <div className="text-muted-foreground/60">合计</div>
            </div>
          </div>
          {trace.usage.estimatedCost != null && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">估算成本</span>
              <span className="font-mono text-amber-500">${trace.usage.estimatedCost.toFixed(6)}</span>
            </div>
          )}
        </div>
      )}

      {/* 阶段时间线 */}
      {trace.phases.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">阶段</div>
          {trace.phases.map((phase, i) => (
            <PhaseItem key={i} phase={phase} />
          ))}
        </div>
      )}

      {/* 工具调用 */}
      {trace.tools.length > 0 && !compact && (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">工具调用</div>
          {trace.tools.map((tool) => (
            <ToolItem key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 单项延迟指标 */
function MetricRow({
  label,
  hint,
  value,
  suffix = '',
}: {
  label: string
  hint: string
  value?: number
  suffix?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">
        <span className="font-mono">{label}</span>
        <span className="text-muted-foreground/60"> · {hint}</span>
      </span>
      <span className="font-mono">
        {value === undefined ? '-' : `${value}ms`}
        {value === undefined ? '' : suffix}
      </span>
    </div>
  )
}

/** 阶段项 */
function PhaseItem({ phase }: { phase: PhaseData }) {  const duration = phase.endTime ? phase.endTime - phase.startTime : null

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${
        phase.name === 'thinking' ? 'bg-yellow-500' : 'bg-green-500'
      }`} />
      <span>{phase.name}</span>
      {duration !== null && (
        <span className="text-muted-foreground">{duration}ms</span>
      )}
      {!phase.endTime && (
        <span className="text-yellow-500 animate-pulse">进行中</span>
      )}
    </div>
  )
}

/** 工具项 */
function ToolItem({ tool }: { tool: ToolData }) {
  const duration = tool.endTime ? tool.endTime - tool.startTime : null

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${
        tool.success === undefined ? 'bg-muted-foreground' :
        tool.success ? 'bg-green-500' : 'bg-red-500'
      }`} />
      <span>{tool.name}</span>
      {duration !== null && (
        <span className="text-muted-foreground">{duration}ms</span>
      )}
      {!tool.endTime && (
        <span className="text-yellow-500 animate-pulse">执行中</span>
      )}
    </div>
  )
}

/** 获取状态 Badge 样式 */
function getStateBadgeClass(state: string): string {
  switch (state) {
    case 'active': return 'bg-blue-500/10 text-blue-500 border-blue-500/30'
    case 'completed': return 'bg-green-500/10 text-green-500 border-green-500/30'
    case 'error': return 'bg-red-500/10 text-red-500 border-red-500/30'
    case 'aborted': return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/30'
    default: return ''
  }
}

/** 格式化耗时 */
function formatDuration(ms?: number): string {
  if (ms === undefined) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Future-monitor-sdk - 调试面板子路径入口
 *
 * 用法：import { DebugPanel, useDebugSubscription } from 'future-monitor-sdk/debug'
 * 仅开发环境使用；依赖 React / zustand（peer deps）与宿主设计系统（@/components/ui）。
 */

export { DebugPanel } from './DebugPanel'
export type { DebugPanelProps } from './DebugPanel'
export { useDebugSubscription } from './useDebugSubscription'
export { useDebugStore, getFilteredEvents, getEventStats, getEventTypes } from './store'
export type {
  ErrorReplayEvent,
  TraceData,
  PhaseData,
  ToolData,
  HttpRequest,
  SessionData,
  VitalsData,
  EventFilter,
  TabType,
} from './types'
export { EVENT_COLORS, VITALS_THRESHOLDS, getEventColor, getVitalColor } from './types'
export type { MonitorEvent } from '../core/types'

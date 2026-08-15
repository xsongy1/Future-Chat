/**
 * RoundContentTracker - 工具轮内容管理
 *
 * 处理"带工具调用的那一轮"的前置文本丢弃逻辑：
 * 模型在工具调用前偶发输出一段文本（如"图片已生成… } </tool_call>"），
 * 后端不持久化这段内容，前端也要同步丢弃，保证直播内容与持久化一致；
 * 同时保证图片先于文字展示。
 *
 * 纯逻辑 + 回调，不依赖 store / React，便于独立测试。
 */

export interface RoundContentTrackerCallbacks {
  /** 当前消息的 content（用于计算内容截断起点） */
  getContent: () => string
  /** 截断消息 content（丢弃工具轮内的前置文本） */
  setContent: (content: string) => void
  /** 清空 answer 缓冲区（丢弃尚未 flush 的前置文本） */
  clearAnswerBuffer: () => void
  /** 强制刷新 answer 缓冲区（工具轮结束时恢复文本显示） */
  forceFlushAnswer: () => void
}

export class RoundContentTracker {
  private roundContentStart = 0 // 当前轮起始时 content 的长度（图片等已确认内容保留）
  private pendingTools = 0 // 本轮尚未结束的工具数
  private suppressRoundContent = false // 工具轮内丢弃后续 answer 文本

  constructor(private callbacks: RoundContentTrackerCallbacks) {}

  /**
   * 是否应丢弃当前 answer 文本（工具轮内）
   */
  get suppressingAnswer(): boolean {
    return this.suppressRoundContent
  }

  /**
   * 工具调用开始：进入工具轮
   * 新一轮的第一个工具：丢弃该轮已流式显示的前置文本（与后端持久化一致）
   */
  onToolRoundStart(): void {
    if (this.pendingTools === 0) {
      this.suppressRoundContent = true
      this.callbacks.clearAnswerBuffer()
      const currentContent = this.callbacks.getContent()
      if (currentContent.length > this.roundContentStart) {
        this.callbacks.setContent(currentContent.slice(0, this.roundContentStart))
      }
    }
    this.pendingTools++
  }

  /**
   * 工具结果返回：本轮全部工具结束时恢复文本显示，
   * 并记录下一轮内容起点（保留已确认的图片等）
   */
  onToolResult(): void {
    this.pendingTools = Math.max(0, this.pendingTools - 1)
    if (this.pendingTools === 0) {
      this.suppressRoundContent = false
      this.callbacks.forceFlushAnswer()
      this.roundContentStart = this.callbacks.getContent().length
    }
  }
}

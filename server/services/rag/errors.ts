/**
 * RAG 任务的"中止"信号
 *
 * 用来区分两件性质完全不同的事：
 *   - **失败**：上游报错、额度用完、正文不合法…… 这些要落失败原因、按策略重试，用户能看见。
 *   - **中止**：这个任务已经不该继续做了——文档/知识库被用户删掉（级联删掉了任务行），
 *     或者任务已被回收重排给别的 worker（锁超时）。这时继续调用 embedding API
 *     只是在为一个不存在的目标花钱，而且收尾时也没有行可写。
 *
 * 所以中止不是错误：worker 捕获它之后只记一条 info 日志，不重试、不写失败状态
 * （写也写不上，行已经没了，硬写会让日志出现"不在本 worker 名下"这种噪音告警）。
 */
export class RagTaskAbortedError extends Error {
  /** 中止原因（写进日志，便于区分"被删"与"被抢"） */
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'RagTaskAbortedError'
    this.reason = reason
  }
}

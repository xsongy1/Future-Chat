/**
 * 多轮工具调用：该持久化哪一轮的文本
 *
 * 单独放一个零依赖模块，是为了让这条不变量能被纯单测覆盖
 * （stream.handler.ts 的依赖链会拉起 prisma / 工具注册表，不适合做纯逻辑测试）。
 *
 * @module server/services/chat/round-answer
 */

/**
 * 计算本轮之后"应当落库的正文"
 *
 * 规则：记录**最后一个有内容**的轮次回答——与前端 RoundContentTracker 的展示结果对齐
 * （它每次工具轮结束就把内容起点重置到当前长度，所以用户看到的最终正文就是最后一轮）。
 *
 * 为什么要单独抽出来：以前只有"某一轮没有工具调用"这条分支才会给 finalAnswerContent
 * 赋值，于是轮次跑满 MAX_TOOL_ROUNDS 退出时它仍是空字符串——前端已经把最后一轮
 * 流式显示出来，落库却是空的，刷新后这条回答消失。
 *
 * @param previous - 之前累积的"待落库正文"
 * @param roundAnswer - 本轮 AI 流式返回的正文（可能为空：整轮只调用工具不输出文本）
 * @returns 本轮之后的"待落库正文"；本轮无内容时保持上一轮的值
 */
export function pickPersistedAnswer(
  previous: string,
  roundAnswer: string | null | undefined
): string {
  if (!roundAnswer) return previous
  return roundAnswer
}

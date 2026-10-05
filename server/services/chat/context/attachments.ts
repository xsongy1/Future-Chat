/**
 * 附件预算与确定性截断
 *
 * ## 要解决的问题
 *
 * 附件走的是"解析后全文拼进当前消息"的路径（见 prompt.builder 的 appendAttachments），
 * 上传上限是 1MB。1MB 中文文本约 100 万 token，而模型窗口是 32K 量级——
 * 也就是说**一个附件就能把上下文彻底打爆**，而且是在发送前就已经注定的：
 * 只能等 provider 返回 400，用户看到一次失败。
 *
 * ## 处理方式
 *
 * 预算足够 → 原文全量（不改动一个字符）
 * 预算不够 → 保留文件头 + 文件尾，中间插入**显式**省略标记
 * 连保底尺寸都放不下 → 整份丢弃，并在当前消息里写明"哪些附件没有包含"
 *
 * 三个刻意的选择：
 * 1. **不做 RAG 化**。附件是"用户当轮贴给你看的东西"，语义上属于当前消息；
 *    丢进向量库既改变了产品语义，又引入一次 embedding 成本与时延。
 * 2. **不静默丢数据**。截断处有标记、被丢弃的附件有说明，模型可以如实告诉用户。
 * 3. **头 + 尾**而不是只留头，理由见 truncate.ts。
 */

import { formatAttachmentBlock } from '../prompt.builder'
import { estimateTokens } from './tokens'
import { truncateTextToTokenBudget } from './truncate'
import type { ContextConfig } from './config'
import type { ContextAttachment } from './types'

export interface AttachmentBudgetResult {
  /** 截断后的附件，可直接交给 appendAttachments */
  attachments: ContextAttachment[]
  /** 因预算不足被整份丢弃的附件名 */
  droppedNames: string[]
  /** 截断后的实际占用 token */
  tokens: number
  /** 是否发生过截断（含整份丢弃） */
  truncated: boolean
  /** 需要显式告知模型的附件说明；无需说明时为 null */
  notice: string | null
}

/** 单个附件（含包装格式）的估算 token 数 */
export function estimateAttachmentTokens(
  attachment: ContextAttachment
): number {
  return estimateTokens(formatAttachmentBlock(attachment))
}

/** 附件块的测量口径：连同 `**附件: name**` 包装一起算，与实际下发的内容一致 */
function measureAttachmentBlock(name: string, content: string): number {
  return estimateTokens(formatAttachmentBlock({ name, content }))
}

/**
 * 把一份附件压到 `targetTokens` 以内
 *
 * @returns 压好的内容；连最小尺寸都放不下时返回 null（调用方据此整份丢弃）
 */
function truncateAttachmentToBudget(
  attachment: ContextAttachment,
  targetTokens: number
): string | null {
  return truncateTextToTokenBudget(attachment.content, targetTokens, {
    // 附件的包装（文件名 + 围栏）本身就占 token，测量时必须带上，
    // 否则"刚好卡在预算上"的附件会在拼装后超出去。
    // 省略标记用 truncate.ts 的默认实现，保证与"截断用户消息"时的标记一致。
    measure: (text) => measureAttachmentBlock(attachment.name, text),
  })
}

/**
 * 按预算裁剪附件
 *
 * @param attachments - 本轮附件（原文）
 * @param budgetTokens - 附件可用的 token 上限（来自 planContextBudget）
 * @param config - 用于取 attachmentMinTokens 保底值
 */
export function applyAttachmentBudget(
  attachments: readonly ContextAttachment[],
  budgetTokens: number,
  config: ContextConfig
): AttachmentBudgetResult {
  if (attachments.length === 0) {
    return {
      attachments: [],
      droppedNames: [],
      tokens: 0,
      truncated: false,
      notice: null,
    }
  }

  const fullTokens = attachments.reduce(
    (sum, file) => sum + estimateAttachmentTokens(file),
    0
  )

  // 快路径：装得下就一个字符都不动
  if (fullTokens <= budgetTokens) {
    return {
      attachments: [...attachments],
      droppedNames: [],
      tokens: fullTokens,
      truncated: false,
      notice: null,
    }
  }

  const minTokens = config.attachmentMinTokens

  // 决定"留下几份、每份多少预算"。
  // 不变量：keptCount * perFileBudget <= budgetTokens，因此最终总占用必然不超预算。
  let keptCount = attachments.length
  let perFileBudget = Math.floor(budgetTokens / keptCount)

  if (perFileBudget < minTokens) {
    keptCount = Math.max(0, Math.floor(budgetTokens / minTokens))
    perFileBudget = keptCount > 0 ? Math.floor(budgetTokens / keptCount) : 0
  }

  if (keptCount === 0) {
    const droppedNames = attachments.map((file) => file.name)
    return {
      attachments: [],
      droppedNames,
      tokens: 0,
      truncated: true,
      notice: buildDroppedNotice(droppedNames),
    }
  }

  const kept: ContextAttachment[] = []
  const droppedNames: string[] = []
  let truncated = false

  attachments.forEach((file, index) => {
    if (index >= keptCount) {
      droppedNames.push(file.name)
      truncated = true
      return
    }

    if (estimateAttachmentTokens(file) <= perFileBudget) {
      kept.push(file)
      return
    }

    const content = truncateAttachmentToBudget(file, perFileBudget)
    if (content === null) {
      droppedNames.push(file.name)
      truncated = true
      return
    }

    kept.push({ ...file, content })
    truncated = true
  })

  const tokens = kept.reduce(
    (sum, file) => sum + estimateAttachmentTokens(file),
    0
  )

  return {
    attachments: kept,
    droppedNames,
    tokens,
    truncated,
    notice: droppedNames.length > 0 ? buildDroppedNotice(droppedNames) : null,
  }
}

/** 被整份丢弃时的说明：让模型能如实告知用户，而不是假装读过 */
function buildDroppedNotice(droppedNames: readonly string[]): string {
  return (
    `[附件说明：以下附件因超出本轮上下文长度限制，未能包含在本次请求中：` +
    `${droppedNames.join('、')}。请如实告知用户这些附件未被读取，` +
    `建议拆分后重发，或改用私有知识库。]`
  )
}

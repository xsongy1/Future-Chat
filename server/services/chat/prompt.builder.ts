/**
 * System Prompt 构建器
 *
 * 管理和构建 AI 的系统提示词
 */

/**
 * 基础系统提示词
 */
const BASE_PROMPT = `You are a helpful assistant. 你是一个友好的 AI 助手。`

/**
 * 工具不可用提示
 */
const IMAGE_UNAVAILABLE_PROMPT = `

⚠️ 图片生成功能当前不可用（网络原因）。
当用户要求生成图片时，请直接告知："抱歉，图片生成功能暂时不可用，可能是网络问题，请稍后再试。"
不要尝试调用 generate_image 工具，因为它不存在。`

/**
 * 富媒体格式说明
 */
const MEDIA_FORMAT_PROMPT = `

当需要展示特定类型的信息时，请使用以下格式：

1. 天气信息 - 使用 weather 代码块：
\`\`\`weather
{"city": "城市名", "temp": 温度数字, "condition": "天气状况", "humidity": 湿度数字}
\`\`\`

2. 数据图表 - 使用 chart 代码块（重要！）：
\`\`\`chart
{"type": "bar或line", "title": "图表标题", "labels": ["标签1", "标签2"], "values": [数值1, 数值2]}
\`\`\`

⚠️ 图表规则（最高优先级，必须遵守）：
- 任何涉及"数据"的图 → 必须用 chart 代码块，禁止调用 generate_image
- "分数线趋势图"、"录取分数走势" → chart 代码块 (line)，不是图片！
- "销售数据图"、"统计图表" → chart 代码块，不是图片！
- 仅支持 bar（柱状图）和 line（折线图）
- 趋势图、走势图、变化图、历年数据 → line 类型
- 对比图、排名图、分布图 → bar 类型

关键词判断：
- 包含"数据"、"分数"、"统计"、"历年"、"趋势"、"走势"、"对比" → chart 代码块
- 包含"风景"、"人物"、"动物"、"艺术"、"照片" → generate_image 工具

3. 图片规则（最高优先级！）：
⚠️ 绝对禁止：
- 禁止输出 \`\`\`image 代码块
- 禁止输出 ![alt](url) Markdown 图片语法
- 禁止自己编造或引用任何图片 URL
- 禁止使用历史对话中出现的图片 URL

✅ 正确做法：
- 需要图片时，调用 generate_image 工具
- 工具会自动展示图片，你只需简单确认"图片已生成"
- 如果没有 generate_image 工具，告知用户"图片生成功能暂不可用"

原因：系统会自动渲染工具返回的图片，你输出的任何图片格式都会被过滤掉

4. 搜索规则（重要！）：
- 当需要查询实时信息、新闻、最新数据时，立即调用 web_search 工具
- 直接调用工具，不要说"正在搜索"之类的话
- 禁止假装搜索或编造搜索结果
- 如果没有 web_search 工具，告知用户"搜索功能暂不可用"

5. 工具调用原则（最高优先级！）：
- 用户要求画图/生成图片 → 必须调用 generate_image，禁止用文字描述
- 用户要求搜索/查询实时信息 → 必须调用 web_search，禁止编造
- 用户询问自己的文档/资料/内部知识 → 必须调用 knowledge_search，禁止编造
- 需要工具时，立即调用，不要先输出文字
- 一次请求中可以同时调用多个工具
- 工具调用失败时再用文字解释原因

区分图表和图片（严格遵守）：
| 用户意图 | 正确做法 | 错误做法 |
|---------|---------|---------|
| "分数线趋势图" | chart (line) | ❌ generate_image |
| "历年录取走势" | chart (line) | ❌ generate_image |
| "销售数据柱状图" | chart (bar) | ❌ generate_image |
| "画校园风景" | generate_image | ❌ chart |
| "生成一只猫" | generate_image | ❌ chart |

6. 私有知识库检索规则（最高优先级，违反即为严重错误！）：

当 knowledge_search 工具可用时，只要用户的问题涉及以下任何一类，就必须先调用 knowledge_search，拿到结果后再作答：
- 用户自己的文档、文件、资料、知识库
- 用户所在公司/组织/团队/单位的内部规定、制度、政策、流程、标准、额度
- 出现"我们公司""我们部门""内部""你们的知识库""我上传的文件"等表述
- 任何具体的事实性数字或规定（价格、标准、额度、时限、名单等），只要你不确定，就先检索

⚠️ 判断不确定时，一律先调用工具检索，不要直接凭记忆作答。

⚠️ 绝对禁止（违反即视为回答失败）：
- 禁止在未调用 knowledge_search 的情况下回答上述问题
- 禁止说"我将进行搜索""请稍等""根据搜索结果""根据知识库"却实际没有调用工具
- 禁止编造文档内容、文件名、条款、金额、时限、标准
- 禁止把工具调用写成普通文本（例如 {{"name": "knowledge_search", ...}} 或 <tool_call> 标签）
  工具调用必须通过系统的 function calling 机制发出，不要在回答正文里描述调用过程

检索之后（按返回的状态词区分处理，不要混为一谈）：
- 片段足以回答 → 严格依据片段作答，并标注来源文件名
- 返回 no_match（未找到足够可信的证据）→ 如实说明"知识库中没有相关资料"；可以换一种问法再检索一次，仍为 no_match 就必须停下如实说明。**禁止**编造，也**禁止**用你自己的知识替代知识库内容作答（如要补充常识，必须明确标注那不是来自知识库）
- 返回 empty_knowledge_base → 说明知识库里还没有可检索的文档，提示用户先上传文档或等待入库完成
- 返回 no_access → 说明该知识库不存在或没有访问权限（不要说成"知识库里没有相关资料"）
- 返回 error（检索失败）→ 按"检索暂时不可用"如实告知；**不要**说成"知识库中没有"，也不要凭常识补答
- 片段不足 → 如实说明"知识库中没有相关资料"；如需补充通用常识，必须明确标注那不是来自知识库
- 如果没有 knowledge_search 工具 → 说明"私有知识库功能未开启，请在输入框开启后重试"`

/**
 * 构建完整的系统提示词
 * @param imageAvailable - 图片生成工具是否可用
 */
export function buildSystemPrompt(imageAvailable: boolean = true): string {
  let prompt = BASE_PROMPT + MEDIA_FORMAT_PROMPT
  if (!imageAvailable) {
    prompt += IMAGE_UNAVAILABLE_PROMPT
  }
  return prompt
}

/**
 * 拼装最终下发的消息数组（system → 历史 → 当前用户消息）
 *
 * 这是**唯一**的拼装实现：上下文管理器（context/manager.ts）与旧的整段历史路径
 * （buildContextMessages）都走这里，所以 Before / After 的差异只在于
 * "传进来的是哪一段历史"，而不在于消息格式——否则 benchmark 比的就不是上下文管理，
 * 而是两种格式的差异。
 *
 * @param systemPrompt - 已构建好的 system prompt
 * @param historyMessages - 会进入上下文的历史消息（可为空）
 * @param currentUserMessage - 当前用户消息（已含附件）
 */
export function assembleMessages(
  systemPrompt: string,
  historyMessages: Array<{ role: string; content: string | null }>,
  currentUserMessage: string
): Array<{ role: string; content: string | null }> {
  return [
    { role: 'system', content: systemPrompt },
    // 历史消息：只回放 role + content
    //
    // 刻意不回放 Message.toolCalls / toolResults：它们是**本次请求内**多轮循环的产物，
    // 落库只是给前端回显用；把历史里的 tool_calls 重新塞回上下文，
    // 会要求同时补齐配对的 tool 消息，而配对关系跨轮次、跨消息，容易拼出非法序列。
    // 当前行为保持不变是本模块的硬约束。
    ...historyMessages.map((msg) => ({ role: msg.role, content: msg.content })),
    { role: 'user', content: currentUserMessage },
  ]
}

/**
 * 构建消息上下文（整段历史版本）
 *
 * ⚠️ 这是改造前的**原始行为**，保留为 Before 基准实现：
 * 数据库里有多少历史就拼多少，不做任何 token 预算控制。
 *
 * 它已不再被聊天主链路调用（见 chat.service.ts），保留的两个理由：
 * 1. benchmark 需要一个"代表真实生产行为"的 Before（见 scripts/context-benchmark.ts），
 *    凭空造一个假 Before 会让对比结果失去意义；
 * 2. 测试用它做对照，证明上下文管理器确实改变了行为。
 *
 * @param imageAvailable - 图片生成工具是否可用
 */
export function buildContextMessages(
  historyMessages: Array<{ role: string; content: string }>,
  currentUserMessage: string,
  imageAvailable: boolean = true
): Array<{ role: string; content: string }> {
  return assembleMessages(
    buildSystemPrompt(imageAvailable),
    historyMessages,
    currentUserMessage
  ) as Array<{ role: string; content: string }>
}

/**
 * 附件块的文本格式
 *
 * 导出而不是内联：上下文管理器要对附件做截断后重新拼装，
 * 如果两边各写一份格式字符串，改动其中一处就会让"截断后的附件"看起来和
 * "未截断的附件"结构不同，模型对两者的解释也会不一致。
 */
export function formatAttachmentBlock(file: {
  name: string
  content: string
}): string {
  return `\n\n---\n**附件: ${file.name}**\n\`\`\`\n${file.content}\n\`\`\``
}

/**
 * 处理附件，将文件内容添加到消息中
 */
export function appendAttachments(
  content: string,
  attachments?: Array<{ name: string; content: string }>
): string {
  if (!attachments || attachments.length === 0) {
    return content
  }

  const fileContents = attachments.map(formatAttachmentBlock).join('\n')

  return content + fileContents
}

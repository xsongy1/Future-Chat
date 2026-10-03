/**
 * 词法分词（BM25 检索的文档侧与查询侧共用）
 *
 * 纯函数，无 IO、无依赖。
 *
 * ## 与 PostgreSQL 的约定：token 必须能原样变成 lexeme
 * 词频不在应用层统计，而是把文本灌给 to_tsvector('simple', $1)，由 SQL 去数 tf / df
 * （见 lexical.ts）。所以「这里切出的 token」必须与「Postgres 切出的 lexeme」
 * 逐一对应，否则 SQL 数出来的 tf 与 avgdl 跟公式的假设不一致，分数就不可信。
 *
 * 之所以能对上，是因为 simple 配置走的是默认 parser：
 *   - 连续的 CJK 表意文字被当成一个 word 整段保留，不会被逐字拆开
 *   - 连续的 ASCII 字母/数字（asciiword / numword）同样整段保留
 *   - 两者都只做小写化：simple 词典不做词干还原
 * 反过来，只要本模块保证每个 token 都是「纯 CJK 串或纯 [a-z0-9] 串」，且 token 之间
 * 只有一个空格，to_tsvector('simple', toLexemeText(x)) 得到的 lexeme 与 tokenize(x)
 * 就完全一致。因此下面遇到任何可疑字符一律当分隔符丢弃，而不是想办法保留：
 * 多丢字符只会让某个 token 变短，而多留字符会在 tsvector 里凭空造出一个
 * SQL 能匹配、应用层却不知道的 lexeme，那种不一致更难排查。
 *
 * 超长 lexeme 的边界（实测过，不是理论问题）：Postgres 会**静默丢弃**长度 ≥ 2047 字节的
 * 单个 lexeme（只发 NOTICE，不报错）。若本模块照常产出这样一个 token，就会出现
 * 「应用层认为它存在、tsvector 里根本没有」的不一致：索引侧它搜不到，
 * 查询侧 `to_tsquery` 会把它解析成空 tsquery（空 tsquery 匹配任何文档都为 false），
 * 于是这次词法检索静默变成 0 命中。因此这里主动把超过 MAX_TOKEN_BYTES 的 token 丢掉，
 * 让两侧从一开始就一致。实测数据：2046 字节保留、2047 字节起被丢弃；
 * CJK bigram 固定 6 字节（2 字 × 3 字节），永远不受影响。
 * 同理，改动 parser 或换成 english 之类带 stemming 的词典，这个等价关系立刻失效。
 *
 * ## 为什么是 bigram
 * 中文没有词间空格，而引词典分词要新增依赖（体积 + 构建 + 领域术语覆盖不到），
 * 于是用「相邻两字滑动」这种无词典方案：`测试环境端口` → 测试/试环/环境/境端/端口。
 * 代价是词表比词典分词大得多、且会切出「试环」这类无意义组合，但对小规模私有
 * 知识库无所谓；好处是口语化问句「测试环境使用哪个端口」里的 测试/环境/端口
 * 三个 bigram 都能命中片段，不需要词典也能召回。
 */

/**
 * 单条文本最多产出的 token 数（超出即截断）
 *
 * chunker 默认块长 800 字，最坏情况（全中文）也才约 1600 个 bigram，
 * 8192 是给「外部直接传长文本」留的余量；上限本身是必要的兜底：
 * Postgres 的 tsvector 位置上限是 16383，且超大 tsvector 会让索引写入与
 * 后续 df 统计一起变慢，而这个上限在应用层拦截比在 SQL 里补救便宜得多。
 */
export const MAX_TOKENS = 8192

/**
 * 单个 token 允许的最大字节数（UTF-8），超过就丢弃
 *
 * 2046 来自 Postgres 的实际行为：lexeme 长度 ≥ 2047 字节时 `to_tsvector` 会静默丢弃它。
 * 也就是说长度超过这条线的 token 在索引里根本不存在，把它当成"合法 token"继续传下去，
 * 只会得到"索引里没有、查询里也永远匹配不上"的假词项（详见文件头说明）。
 *
 * 会被丢掉的只有超长 ASCII 连写串（base64、压缩产物、被误当文本的长哈希）——
 * 这类串本来就不可检索，丢了比留着更诚实；CJK bigram 只有 6 字节，永远不会触发。
 */
export const MAX_TOKEN_BYTES = 2046

/**
 * toTsQueryInput 最多输出的词项数
 *
 * 每个词项在 SQL 里都要换一次 df 统计，查询越长代价越高；正常提问（哪怕是很长的
 * 中文句子）也就几十个 bigram，超过 64 之后新增的多半是噪声词，只拖慢检索。
 */
export const MAX_QUERY_TERMS = 64

/** CJK 表意文字区间：扩展 A、基本区、兼容区 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
]

/** 允许进入 tsquery 的 token：只可能是本模块切出的纯 ASCII 小写字母数字或纯 CJK */
const SAFE_TERM = /^[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/

function isCjkCode(code: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (code >= start && code <= end) return true
  }
  return false
}

/**
 * 是否是 ASCII 词字符（字母或数字）
 *
 * 只看小写区间即可：调用方已先整体 toLowerCase，不必再为 A-Z 留分支。
 */
function isAsciiWordCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x7a)
}

/**
 * 切分为 token 流
 *
 * 保留重复与顺序：`termFrequencies` 要数 tf，且 `length` 就是 BM25 的文档长度 dl。
 *
 * @param text - 原始文本
 * @returns token 数组；空串 / 纯空白 / 纯标点返回空数组
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  if (!text) return tokens

  // 先整体小写：之后每个分支只需认 [a-z0-9]，不用反复处理大小写
  const lower = text.toLowerCase()

  // 同时只会有一种「段」非空：类型一换就先落词，ASCII 段与 CJK 段互不干扰
  let cjkRun: string[] = []
  let asciiRun = ''

  const push = (token: string): boolean => {
    if (tokens.length >= MAX_TOKENS) return false
    tokens.push(token)
    return true
  }

  const flush = (): void => {
    if (cjkRun.length === 1) {
      // 单字必须自成一个 token：否则「端口」这类两字词之外的短查询永远匹配不上
      push(cjkRun[0])
    } else if (cjkRun.length > 1) {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        if (!push(cjkRun[i] + cjkRun[i + 1])) break
      }
    }
    // 超长 ASCII 串直接丢弃：Postgres 的 tsvector 里放不下（≥2047 字节被静默丢掉），
    // 留着它会让索引侧与查询侧对"这个词项是否存在"给出不同答案
    if (asciiRun && asciiRun.length <= MAX_TOKEN_BYTES) push(asciiRun)
    cjkRun = []
    asciiRun = ''
  }

  for (const char of lower) {
    // 截断后就没必要继续扫了：一段超长中文会在这里直接结束，不会被展开成几万个 bigram
    if (tokens.length >= MAX_TOKENS) break

    const code = char.codePointAt(0) ?? 0

    if (isCjkCode(code)) {
      if (asciiRun) flush()
      cjkRun.push(char)
      continue
    }

    if (isAsciiWordCode(code)) {
      if (cjkRun.length > 0) flush()
      asciiRun += char
      continue
    }

    // 其余一切都是分隔符：空格、换行、中英文标点（，。！？、；：（）【】）、
    // emoji、- _ / 等。`FC-6035` 因此得到 fc 与 6035 两个 token 而不是一个
    flush()
  }

  flush()

  return tokens
}

/**
 * 统计每个 token 的出现次数（tf）
 *
 * @param tokens - `tokenize` 的输出（必须带重复）
 */
export function termFrequencies(tokens: string[]): Map<string, number> {
  const frequencies = new Map<string, number>()

  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }

  return frequencies
}

/**
 * 拼成可直接喂给 `to_tsvector('simple', $1)` 的文本
 *
 * 分隔符固定为单个空格：默认 parser 会据此给出连续的 lexeme 位置，
 * 多个空格只会让位置出现间隙，对 tf/df 没影响但徒增歧义。
 *
 * @returns 无 token 时返回空字符串（而不是空格）
 */
export function toLexemeText(text: string): string {
  return tokenize(text).join(' ')
}

/**
 * 查询词项：去重、只保留安全字符、截断到 MAX_QUERY_TERMS；无有效词项返回空数组
 *
 * 查询侧的词项必须只有这一个出处：BM25 的 SQL 一边用 lexeme IN (...) 过滤候选，
 * 一边把 toTsQueryInput 的结果当 tsquery 解析，两处要是各算各的，df 统计到的词
 * 与实际命中的词就可能不是同一批，分数会在没有任何报错的情况下悄悄变形。
 * （去重同样是为这个一致性服务：重复词项只会让 SQL 多算一次 df，
 *   分数不会变——tf 由文档侧决定——却会让查询串和词项数组都不必要地变长。）
 *
 * @returns 按首次出现顺序排列的词项；无 token 时返回空数组
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()

  for (const token of tokenize(query)) {
    if (terms.length >= MAX_QUERY_TERMS) break

    // 不依赖「tokenize 只产出安全字符」这个前提：tsquery 的元字符
    // （| & ! : * ( ) '）一旦混进词项，轻则改变 OR 语义，重则整条 query 语法报错，
    // 所以在出口再做一次白名单校验，多一层校验的成本远低于一次线上查询失败
    if (!SAFE_TERM.test(token) || seen.has(token)) continue

    seen.add(token)
    terms.push(token)
  }

  return terms
}

/**
 * 拼成可直接喂给 `to_tsquery('simple', $1)` 的 OR 查询
 *
 * 刻意只是 queryTerms 的薄封装：两条链路（SQL 的 lexeme 过滤 / tsquery 解析）
 * 必须来自同一份词项，任何「顺手在这儿多做一点」的改动都会重新引入不一致的风险。
 *
 * @returns 无有效词项时返回 null，调用方据此跳过词法检索
 */
export function toTsQueryInput(query: string): string | null {
  const terms = queryTerms(query)

  return terms.length > 0 ? terms.join(' | ') : null
}

/**
 * token 数，即 BM25 公式里的文档长度 dl
 *
 * 单独导出而不是让调用方自己 `tokenize(x).length`，是为了让「dl 的定义」
 * 只存在于一处——SQL 侧算 avgdl 用的也是同一个数。注意这是 token 数而非字符数：
 * 中文 bigram 展开后 dl 约为字数的两倍，avgdl 必须用同一口径，不能混用字数。
 */
export function countTokens(text: string): number {
  return tokenize(text).length
}

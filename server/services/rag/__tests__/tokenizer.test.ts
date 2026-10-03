/**
 * Tokenizer 单元测试
 *
 * 用相对路径导入（与 chunker.test.ts 一致）。
 * 断言的是「token 流」本身而不只是「能否切出词」：token 的顺序、重复与分隔方式
 * 都是与 Postgres `to_tsvector('simple', ...)` 对齐约定的一部分，改动其中任何一项
 * 都会让 BM25 的 tf / dl 与 SQL 统计对不上，分数随之失真。
 *
 * 覆盖：空/纯标点输入、中文 bigram 展开、单字、ASCII 段、混合文本、重复保留、
 * 截断上限（MAX_TOKENS / MAX_TOKEN_BYTES）、lexeme 拼接、查询词项去重/截断/注入防护、
 * tsquery 与查询词项的一致性。
 */

import { describe, it, expect } from 'vitest'
import {
  MAX_QUERY_TERMS,
  MAX_TOKENS,
  MAX_TOKEN_BYTES,
  countTokens,
  queryTerms,
  termFrequencies,
  toLexemeText,
  toTsQueryInput,
  tokenize,
} from '../tokenizer'

/** token 的安全形态：纯 ASCII 小写字母数字，或纯 CJK 表意文字 */
const SAFE_TERM = /^[a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/

describe('tokenize', () => {
  it('空输入 / 纯空白 / 纯标点 / emoji 都返回空数组', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   \n\t\r\n ')).toEqual([])
    expect(tokenize('，。！？、；：（）【】')).toEqual([])
    expect(tokenize('---___/// ... !!!')).toEqual([])
    expect(tokenize('🙂🙂')).toEqual([])
  })

  it('中文按相邻二字滑窗展开，顺序即出现顺序', () => {
    expect(tokenize('测试环境端口')).toEqual([
      '测试',
      '试环',
      '环境',
      '境端',
      '端口',
    ])
    expect(tokenize('中国人')).toEqual(['中国', '国人'])
  })

  it('连续中文的 bigram 数量等于字数减一', () => {
    const tokens = tokenize('一二三四五六七八九十')

    expect(tokens).toHaveLength(9)
    expect(tokens[0]).toBe('一二')
    expect(tokens[8]).toBe('九十')
  })

  it('单个中文字符自成一个 token', () => {
    expect(tokenize('好')).toEqual(['好'])
    expect(tokenize('甲，乙')).toEqual(['甲', '乙'])
  })

  it('ASCII 字母数字整段保留并小写化', () => {
    expect(tokenize('abc123')).toEqual(['abc123'])
    expect(tokenize('34517')).toEqual(['34517'])
    expect(tokenize('ABC')).toEqual(['abc'])
    // 连字符是分隔符，所以番号被切成字母段与数字段两段
    expect(tokenize('FC-6035')).toEqual(['fc', '6035'])
  })

  it('CJK 段与 ASCII 段互相独立', () => {
    expect(tokenize('代号FC-6035是')).toEqual(['代号', 'fc', '6035', '是'])
    expect(tokenize('端口34517')).toEqual(['端口', '34517'])
    expect(tokenize('abc中文123')).toEqual(['abc', '中文', '123'])
  })

  it('中英文标点、下划线、斜杠、换行都当分隔符', () => {
    expect(tokenize('测试，环境')).toEqual(['测试', '环境'])
    expect(tokenize('a_b/c')).toEqual(['a', 'b', 'c'])
    expect(tokenize('第一行\n第二行')).toEqual(['第一', '一行', '第二', '二行'])
  })

  it('重复 token 原样保留（tf 与文档长度 dl 依赖重复）', () => {
    // 「测试」出现两次：词频统计与 tokenize().length 都必须看得见这个重复
    expect(tokenize('测试测试')).toEqual(['测试', '试测', '测试'])
    expect(tokenize('端口 端口')).toEqual(['端口', '端口'])
  })

  it('口语化问句与短片段共享 bigram，无需词典也能召回', () => {
    const queryTokens = new Set(tokenize('测试环境使用哪个端口'))
    const shared = tokenize('测试环境端口').filter((token) =>
      queryTokens.has(token)
    )

    expect(shared).toEqual(['测试', '试环', '环境', '端口'])
  })

  it('每个 token 都是纯 CJK 或纯 [a-z0-9]，不含空格', () => {
    const tokens = tokenize('代号FC-6035 测试，环境 12.5% #tag 版本v2.1')

    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens) {
      expect(SAFE_TERM.test(token)).toBe(true)
      expect(token).not.toContain(' ')
    }
  })

  it(`超长输入被截断到 MAX_TOKENS（${MAX_TOKENS}）`, () => {
    const tokens = tokenize('测'.repeat(MAX_TOKENS * 2))

    expect(tokens).toHaveLength(MAX_TOKENS)
    expect(tokens.every((token) => token === '测测')).toBe(true)
    // 正常长度不该被削
    expect(tokenize('测'.repeat(100))).toHaveLength(99)
  })

  it(`超过 MAX_TOKEN_BYTES（${MAX_TOKEN_BYTES}）的 ASCII 串被丢弃`, () => {
    // Postgres 会静默丢弃 ≥2047 字节的 lexeme：留着它会让两侧对"这个词项在不在"给出不同答案
    const runs = (n: number) => `fc ${'a'.repeat(n)} 6035`

    // 边界：2046 保留
    expect(tokenize(runs(MAX_TOKEN_BYTES))).toEqual(['fc', 'a'.repeat(MAX_TOKEN_BYTES), '6035'])
    // 2047 起丢弃，但同段里的正常 token 不受影响
    expect(tokenize(runs(MAX_TOKEN_BYTES + 1))).toEqual(['fc', '6035'])
    expect(tokenize('a'.repeat(3000))).toEqual([])

    // 丢弃必须贯穿到另外两个导出：否则查询侧仍会造出一个索引里不存在的词项
    expect(toLexemeText(runs(3000))).toBe('fc 6035')
    expect(queryTerms(runs(3000))).toEqual(['fc', '6035'])
  })

  it('CJK bigram 不会被字节上限影响（固定 6 字节）', () => {
    expect(tokenize('测'.repeat(3000))).toHaveLength(2999)
  })
})

describe('termFrequencies', () => {
  it('统计每个 token 的出现次数', () => {
    const frequencies = termFrequencies(['端口', '端口', '测试'])

    expect(frequencies.get('端口')).toBe(2)
    expect(frequencies.get('测试')).toBe(1)
    expect(frequencies.size).toBe(2)
  })

  it('空数组返回空 Map', () => {
    expect(termFrequencies([]).size).toBe(0)
  })
})

describe('toLexemeText', () => {
  it('用单个空格拼接 token', () => {
    expect(toLexemeText('测试环境端口')).toBe('测试 试环 环境 境端 端口')
  })

  it('没有 token 时返回空字符串而不是空格', () => {
    expect(toLexemeText('')).toBe('')
    expect(toLexemeText('，。！')).toBe('')
  })

  it('按空格切开后与 tokenize 完全一致（lexeme == token 的约定）', () => {
    const text = '代号FC-6035 是 测试环境端口，版本 2.1'
    const lexemes = toLexemeText(text)

    expect(lexemes.length > 0 ? lexemes.split(' ') : []).toEqual(tokenize(text))
    // 不能出现连续空格或首尾空格：多余的空格会让 Postgres 的 lexeme 位置出现间隙
    expect(lexemes).not.toMatch(/ {2}/)
    expect(lexemes).toBe(lexemes.trim())
  })
})

describe('queryTerms', () => {
  it('去重并保留首次出现顺序', () => {
    expect(queryTerms('测试测试')).toEqual(['测试', '试测'])
    expect(queryTerms('乙乙甲甲')).toEqual(['乙乙', '乙甲', '甲甲'])
    // ASCII 重复也照样只留一份
    expect(queryTerms('FC fc 6035')).toEqual(['fc', '6035'])
  })

  it('只保留安全词项，纯标点 token 不进入结果', () => {
    const terms = queryTerms("测试' | & ! ( ) : * 测试 | 环境")

    expect(terms).toEqual(['测试', '环境'])
    for (const term of terms) expect(SAFE_TERM.test(term)).toBe(true)
  })

  it(`词项数不超过 MAX_QUERY_TERMS（${MAX_QUERY_TERMS}）`, () => {
    const query = Array.from({ length: 100 }, (_, i) => `k${i}`).join(' ')
    const terms = queryTerms(query)

    expect(terms).toHaveLength(MAX_QUERY_TERMS)
    expect(terms[0]).toBe('k0')
    expect(terms[MAX_QUERY_TERMS - 1]).toBe(`k${MAX_QUERY_TERMS - 1}`)
  })

  it('空输入 / 纯空白 / 纯标点返回空数组', () => {
    expect(queryTerms('')).toEqual([])
    expect(queryTerms('   \n\t ')).toEqual([])
    expect(queryTerms('，。！？、；：（）【】')).toEqual([])
    expect(queryTerms('---___/// |&!()*')).toEqual([])
  })

  it('与 toTsQueryInput 永远一致（SQL 的词项过滤与 tsquery 必须同源）', () => {
    const inputs = [
      '测试环境使用哪个端口',
      'FC-6035',
      '版本 v2.1 端口34517',
      "'; DROP TABLE chunks; --",
      '甲，乙 甲',
      '测试测试',
      Array.from({ length: 100 }, (_, i) => `k${i}`).join(' '),
      '，。！？',
    ]

    for (const input of inputs) {
      const terms = queryTerms(input)
      expect(toTsQueryInput(input)).toBe(
        terms.length > 0 ? terms.join(' | ') : null
      )
    }
  })
})

describe('toTsQueryInput', () => {
  it('去重后用 | 连接，可直接交给 to_tsquery', () => {
    expect(toTsQueryInput('测试测试')).toBe('测试 | 试测')
  })

  it('保留首次出现顺序，不排序', () => {
    expect(toTsQueryInput('乙乙甲甲')).toBe('乙乙 | 乙甲 | 甲甲')
  })

  it('没有 token 时返回 null（调用方据此跳过词法检索）', () => {
    expect(toTsQueryInput('')).toBeNull()
    expect(toTsQueryInput('   \n ')).toBeNull()
    expect(toTsQueryInput('，。！？---')).toBeNull()
  })

  // 词项上限/白名单/去重等行为不在这里重复测：下面这条等价断言表明
  // toTsQueryInput 只是 queryTerms 的 join，那些行为由 queryTerms 的用例覆盖即可。
  it('等价于 queryTerms 的 join（薄封装，不允许各自演化）', () => {
    expect(toTsQueryInput('代号FC-6035 是 测试环境端口')).toBe(
      queryTerms('代号FC-6035 是 测试环境端口').join(' | ')
    )

    // 长查询同样必须一致（上限与去重都在 queryTerms 里）
    const long = Array.from({ length: 100 }, (_, i) => `k${i}`).join(' ')
    expect(toTsQueryInput(long)).toBe(queryTerms(long).join(' | '))
    expect((toTsQueryInput(long) ?? '').split(' | ')).toHaveLength(MAX_QUERY_TERMS)
  })

  it('注入 tsquery 语法只会被当作分隔符丢弃', () => {
    // 若元字符能混进词项，轻则改变 OR 语义，重则整条 query 语法报错
    const input = toTsQueryInput("测试' | & ! ( ) : * 测试 | 环境")

    expect(input).toBe('测试 | 环境')

    const statements = toTsQueryInput("'; DROP TABLE chunks; --")

    expect(statements).toBe('drop | table | chunks')

    for (const term of `${input} | ${statements}`.split(' | ')) {
      expect(SAFE_TERM.test(term)).toBe(true)
    }
    expect(`${input}${statements}`).not.toMatch(/['"&!():*<>\\]/)
    expect(`${input}${statements}`).not.toMatch(/\|\|/)
  })
})

describe('countTokens', () => {
  it('等于 tokenize().length，即 BM25 的文档长度 dl', () => {
    const text = '测试环境端口 FC-6035'

    expect(countTokens(text)).toBe(tokenize(text).length)
    expect(countTokens(text)).toBe(7)
    expect(countTokens('测试环境端口')).toBe(5)
  })

  it('没有 token 时为 0', () => {
    expect(countTokens('')).toBe(0)
    expect(countTokens('，。！')).toBe(0)
  })
})

/**
 * 正则工具
 *
 * 带 g / y flag 的正则是有状态的：test() 命中后会把 lastIndex 推到匹配末尾，
 * 下一次调用从那里继续，于是同一个正则交替返回 true / false。
 * 忽略规则、URL 过滤这类"每次都要独立判定"的场景必须先复位 lastIndex。
 */

/** 安全的正则测试：每次调用前复位 lastIndex */
export function testRegex(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0
  return regex.test(value)
}

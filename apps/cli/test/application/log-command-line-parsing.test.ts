/**
 * `e2e_assistant log` 的行数解析测试（v19 §6.2）。
 *
 * 锁定 `cac` 的类型陷阱：不给 `-n` 时是字符串 `'100'`，`-n 500` 时是数字 `500`；
 * 非法值必须明确报错，**不静默回退默认值**——静默回退会让 `-n 0` 表现为
 * 「打印 100 行」，用户无法理解。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_LINE_COUNT,
  parseLogLineCount,
} from '../../src/commands/log-command'

describe('parseLogLineCount', () => {
  it('缺省时使用默认行数', () => {
    expect(parseLogLineCount(undefined)).toBe(DEFAULT_LOG_LINE_COUNT)
    expect(DEFAULT_LOG_LINE_COUNT).toBe(100)
  })

  it('接受 cac 给出的字符串默认值', () => {
    // 不给 -n 时 cac 原样返回声明的默认值（字符串）。
    expect(parseLogLineCount('100')).toBe(100)
  })

  it('接受 cac 转换出的数字', () => {
    // 纯数字输入会被 cac 转成 number。
    expect(parseLogLineCount(500)).toBe(500)
  })

  it('拒绝非正整数而不是静默回退', () => {
    for (const illegalValue of ['abc', '0', '-1', '1.5', '', '  ', 0, -5, 1.5]) {
      expect(() => parseLogLineCount(illegalValue)).toThrow(/行数参数不合法/)
    }
  })

  it('错误文案包含可执行的用法示例', () => {
    expect(() => parseLogLineCount('abc')).toThrow(/e2e_assistant log -n 50/)
  })
})

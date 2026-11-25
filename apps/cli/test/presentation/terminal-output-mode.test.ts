/**
 * 渲染层级判定的测试。
 *
 * 这里锁定的是「管道下必须降级」这条性质：e2e 用例通过管道读取 stdout，
 * 若在此误判为 TTY，输出会带上边框字符，断言的可读子串与视觉都会被破坏。
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_MIN_COLUMNS,
  resolveTerminalOutputMode,
} from '../../src/presentation/console/terminal-output-mode'

describe('resolveTerminalOutputMode', () => {
  it('输出被重定向时降级为纯文本', () => {
    // e2e / CI / `| cat` 都属于这一支：没有 TTY，就不该画框。
    expect(resolveTerminalOutputMode(false, 80)).toBe('plain')
    expect(resolveTerminalOutputMode(false, undefined)).toBe('plain')
  })

  it('终端足够宽时输出完整卡片', () => {
    expect(resolveTerminalOutputMode(true, 80)).toBe('card')
    expect(resolveTerminalOutputMode(true, CARD_MIN_COLUMNS)).toBe('card')
  })

  it('终端过窄时去掉边框', () => {
    expect(resolveTerminalOutputMode(true, CARD_MIN_COLUMNS - 1)).toBe(
      'colored',
    )
    expect(resolveTerminalOutputMode(true, 20)).toBe('colored')
  })

  it('终端不上报列数时按宽终端处理', () => {
    // 宁可画框也不误降级：画框只是观感问题，降级会丢掉卡片形态。
    expect(resolveTerminalOutputMode(true, undefined)).toBe('card')
    expect(resolveTerminalOutputMode(true, Number.NaN)).toBe('card')
  })
})

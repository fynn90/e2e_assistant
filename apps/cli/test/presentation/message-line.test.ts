/**
 * 单行提示渲染的测试。
 *
 * 这些用例锁定「CLI 的单行提示长什么样」：统一的图标 + 配色，且**不再出现
 * `【cli】` 前缀**——那是被淘汰的旧风格（用户在终端里会看到新旧两种排版并存）。
 */
import { describe, expect, it } from 'vitest'
import {
  renderNoticeBlock,
  renderNoticeLine,
} from '../../src/presentation/console/message-line'
import { measureTextWidth } from '../../src/presentation/console/text-width'

/** 剥掉 ANSI 序列，便于断言纯文本内容。 */
function stripAnsi(text: string): string {
  return text.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g'),
    '',
  )
}

describe('renderNoticeLine', () => {
  it('按级别给出行首图标', () => {
    expect(stripAnsi(renderNoticeLine({ level: 'info', message: 'x' }))).toBe(
      'ℹ️ x',
    )
    expect(stripAnsi(renderNoticeLine({ level: 'warn', message: 'x' }))).toBe(
      '⚠️ x',
    )
    expect(stripAnsi(renderNoticeLine({ level: 'error', message: 'x' }))).toBe(
      '❌ x',
    )
  })

  it('不再残留旧的【cli】前缀', () => {
    // 旧风格的 `🚀【cli】 ...` 已淘汰；这里锁定它不会以任何形式回归。
    for (const level of ['info', 'warn', 'error'] as const) {
      const rendered = renderNoticeLine({ level, message: '测试消息' })

      expect(rendered).not.toContain('【cli】')
      expect(rendered).not.toContain('🚀')
    }
  })

  it('单行输出不含换行', () => {
    const rendered = renderNoticeLine({ level: 'warn', message: '单行' })

    expect(rendered).not.toContain('\n')
  })

  it('非 TTY 下输出纯文本（无 ANSI 转义）', () => {
    // 测试环境走管道，styleText 应自动降级；断言渲染结果与剥离 ANSI 后一致。
    const rendered = renderNoticeLine({ level: 'error', message: '失败' })

    expect(measureTextWidth(rendered)).toBe(
      measureTextWidth(stripAnsi(rendered)),
    )
  })
})

describe('renderNoticeBlock', () => {
  it('正文一行，细节行缩进且保留内容', () => {
    const rendered = renderNoticeBlock({
      level: 'error',
      message: 'Authine CLI 执行失败：boom',
      details: ['at foo (bar.js:1:1)', 'at baz (qux.js:2:2)'],
    })
    const plain = stripAnsi(rendered)
    const lines = plain.split('\n')

    expect(lines[0]).toBe('❌ Authine CLI 执行失败：boom')
    expect(lines).toHaveLength(3)
    expect(lines[1]?.startsWith('   at foo')).toBe(true)
    expect(lines[2]?.startsWith('   at baz')).toBe(true)
  })

  it('没有细节时退化为单行', () => {
    const rendered = renderNoticeBlock({
      level: 'warn',
      message: '仅一行',
      details: [],
    })

    expect(rendered).not.toContain('\n')
  })
})

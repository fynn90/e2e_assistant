/**
 * 验证脚本时间戳的中文相对时间和完整本地时间回退。
 */
import { describe, expect, it } from 'vitest'
import { formatTimestamp } from '../../src/modules/e2e-test-case/utils/format-timestamp'

describe('formatTimestamp', () => {
  it('formats recent timestamps as concise relative labels', () => {
    const value = formatTimestamp(
      '2026-07-18T10:00:00.000Z',
      new Date('2026-07-18T10:42:00.000Z'),
    )

    expect(value.label).toBe('42 分钟前')
    expect(value.title).not.toBe(value.label)
  })

  it('preserves invalid values for safe display', () => {
    expect(formatTimestamp('not-a-date')).toEqual({
      label: 'not-a-date',
      title: 'not-a-date',
    })
  })
})

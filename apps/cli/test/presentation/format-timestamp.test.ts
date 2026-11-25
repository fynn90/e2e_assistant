/**
 * 时间格式化测试：本地时刻与「已运行时长」。
 *
 * 时长用例全部注入固定的 `now`，因此断言是确定性的，不受执行时刻影响。
 */
import { describe, expect, it } from 'vitest'
import {
  formatElapsedDuration,
  formatLocalTimestamp,
} from '../../src/presentation/console/format-timestamp'

const NOW = new Date('2026-10-13T12:00:00.000Z')

/**
 * 构造相对 NOW 偏移若干毫秒的 ISO 时刻。
 *
 * @param offsetMs - 相对 NOW 的偏移（负数表示更早）。
 * @returns ISO 8601 字符串。
 */
function isoBefore(offsetMs: number): string {
  return new Date(NOW.getTime() - offsetMs).toISOString()
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

describe('formatLocalTimestamp', () => {
  it('格式化为本地时区的 YYYY-MM-DD HH:mm:ss', () => {
    const formatted = formatLocalTimestamp('2026-10-13T06:32:08.000Z')

    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('取值缺失时返回 null', () => {
    expect(formatLocalTimestamp(undefined)).toBeNull()
    expect(formatLocalTimestamp('')).toBeNull()
  })

  it('无法解析时返回 null 而不是抛错', () => {
    expect(formatLocalTimestamp('not-a-timestamp')).toBeNull()
  })
})

describe('formatElapsedDuration', () => {
  it('一分钟内显示「刚刚启动」', () => {
    expect(formatElapsedDuration(isoBefore(30_000), NOW)).toBe('刚刚启动')
  })

  it('一小时以内按分钟显示', () => {
    expect(formatElapsedDuration(isoBefore(5 * MINUTE), NOW)).toBe('5 分钟')
    expect(formatElapsedDuration(isoBefore(59 * MINUTE), NOW)).toBe('59 分钟')
  })

  it('一天以内按「小时 分钟」显示', () => {
    expect(formatElapsedDuration(isoBefore(2 * HOUR + 15 * MINUTE), NOW)).toBe(
      '2 小时 15 分',
    )
  })

  it('整小时省略分钟部分', () => {
    // 「运行了 2 小时 0 分」啰嗦且无信息量。
    expect(formatElapsedDuration(isoBefore(2 * HOUR), NOW)).toBe('2 小时')
  })

  it('超过一天改用「天 小时」', () => {
    expect(formatElapsedDuration(isoBefore(2 * DAY + 2 * HOUR), NOW)).toBe(
      '2 天 2 小时',
    )
  })

  it('整天的省略小时部分', () => {
    expect(formatElapsedDuration(isoBefore(3 * DAY), NOW)).toBe('3 天')
  })

  it('时钟回拨导致的负时长按「刚刚启动」处理', () => {
    // 显示负数会让用户以为出了故障。
    expect(formatElapsedDuration(isoBefore(-5 * MINUTE), NOW)).toBe('刚刚启动')
  })

  it('取值缺失或无法解析时返回 null（调用方据此不渲染该行）', () => {
    expect(formatElapsedDuration(undefined, NOW)).toBeNull()
    expect(formatElapsedDuration('', NOW)).toBeNull()
    expect(formatElapsedDuration('not-a-timestamp', NOW)).toBeNull()
  })

  it('边界值：恰好一分钟 / 一小时 / 一天', () => {
    expect(formatElapsedDuration(isoBefore(MINUTE), NOW)).toBe('1 分钟')
    expect(formatElapsedDuration(isoBefore(HOUR), NOW)).toBe('1 小时')
    expect(formatElapsedDuration(isoBefore(DAY), NOW)).toBe('1 天')
  })
})

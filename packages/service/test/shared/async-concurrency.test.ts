/**
 * 异步并发与超时辅助测试：验证并发上限、结果顺序与超时语义。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  mapWithConcurrencyLimit,
  withTimeout,
  withTimeoutRejection,
} from '../../src/shared/async-concurrency'

/**
 * 构造一个在指定毫秒后完成的 Promise。
 * @param value 完成值。
 * @param delayMs 延迟毫秒数。
 * @returns 延迟完成的 Promise。
 * @throws 不抛出异常。
 */
function resolveAfter<TValue>(value: TValue, delayMs: number): Promise<TValue> {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs))
}

describe('mapWithConcurrencyLimit', () => {
  it('preserves the input order regardless of completion order', async () => {
    const results = await mapWithConcurrencyLimit([30, 10, 20], 3, (delayMs) =>
      resolveAfter(delayMs, delayMs),
    )

    expect(results).toEqual([30, 10, 20])
  })

  it('never exceeds the concurrency limit', async () => {
    let activeCount = 0
    let peakCount = 0

    await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
      activeCount += 1
      peakCount = Math.max(peakCount, activeCount)
      await resolveAfter(value, 5)
      activeCount -= 1
      return value
    })

    expect(peakCount).toBeLessThanOrEqual(2)
  })

  it('treats a limit below one as a single worker', async () => {
    let activeCount = 0
    let peakCount = 0

    await mapWithConcurrencyLimit([1, 2, 3], 0, async (value) => {
      activeCount += 1
      peakCount = Math.max(peakCount, activeCount)
      await resolveAfter(value, 5)
      activeCount -= 1
      return value
    })

    expect(peakCount).toBe(1)
  })

  it('handles an empty input', async () => {
    await expect(
      mapWithConcurrencyLimit([], 4, async () => 1),
    ).resolves.toEqual([])
  })

  it('propagates the first mapper failure', async () => {
    await expect(
      mapWithConcurrencyLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) {
          throw new Error('mapper failed')
        }

        return value
      }),
    ).rejects.toThrow('mapper failed')
  })
})

describe('withTimeout', () => {
  it('returns the operation result when it settles in time', async () => {
    await expect(
      withTimeout(resolveAfter('ok', 5), 100, 'fallback'),
    ).resolves.toBe('ok')
  })

  it('returns the fallback value when the operation exceeds the timeout', async () => {
    await expect(
      withTimeout(resolveAfter('late', 200), 20, 'fallback'),
    ).resolves.toBe('fallback')
  })

  it('returns the fallback value when the operation rejects', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 100, 'fallback'),
    ).resolves.toBe('fallback')
  })
})

describe('withTimeoutRejection', () => {
  it('returns the operation result when it settles in time', async () => {
    await expect(
      withTimeoutRejection(
        resolveAfter('ok', 5),
        100,
        () => new Error('timeout'),
      ),
    ).resolves.toBe('ok')
  })

  it('rejects with the provided error when the operation exceeds the timeout', async () => {
    await expect(
      withTimeoutRejection(
        resolveAfter('late', 200),
        20,
        () => new Error('访问超时'),
      ),
    ).rejects.toThrow('访问超时')
  })

  it('propagates the original error when the operation rejects', async () => {
    await expect(
      withTimeoutRejection(
        Promise.reject(new Error('original')),
        100,
        () => new Error('timeout'),
      ),
    ).rejects.toThrow('original')
  })

  it('does not leave an unhandled rejection after timing out on a failing operation', async () => {
    const unhandledRejection = vi.fn()
    process.on('unhandledRejection', unhandledRejection)

    try {
      const failingOperation = new Promise((_resolve, reject) => {
        // 超时先触发，业务失败后到达，其拒绝必须被内部消费而不是泄漏为未处理拒绝。
        setTimeout(() => reject(new Error('late failure')), 60)
      })

      await expect(
        withTimeoutRejection(failingOperation, 10, () => new Error('timeout')),
      ).rejects.toThrow('timeout')

      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(unhandledRejection).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandledRejection)
    }
  })
})

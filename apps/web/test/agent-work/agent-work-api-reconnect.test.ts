/**
 * Agent 工作事件流订阅的重连行为测试。
 *
 * 重点覆盖一个曾导致线上问题的场景：服务端返回 5xx 时 fetch 依然 resolve，
 * 若把「fetch 返回」误判为「连接建立」并重置退避计数，重试间隔会永远停在
 * 最小值，形成每秒一次的请求风暴（控制台刷满 500 日志）。
 *
 * 断言方式：用假定时器推进时间，统计各时间窗口内的请求次数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeAgentWorkStream } from '../../src/services/agent-work-api'

/** 记录每次请求的 URL 与时刻。 */
let requests: Array<{ url: string; at: number }> = []

/** 构造固定返回 500 的响应（fetch resolve 但响应不可用）。 */
function serverErrorResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, code: 'INTERNAL_ERROR', message: 'boom' }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  vi.stubGlobal('fetch', (url: string) => {
    requests.push({ url: String(url), at: Date.now() })
    return Promise.resolve(serverErrorResponse())
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('subscribeAgentWorkStream 重连退避', () => {
  it('服务端持续 5xx 时按 1s→2s→4s 退避，而非固定 1s 重试', async () => {
    const subscription = subscribeAgentWorkStream('s1', () => undefined, {
      onEvent: () => undefined,
    })

    // 首次连接（立即发起）
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(1)

    // 第 1 次重连：1s 后
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(2)

    // 第 2 次重连：再过 2s（累计 3s）；1s 时不应有新请求
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(3)

    // 第 3 次重连：再过 4s（累计 7s）
    await vi.advanceTimersByTimeAsync(3000)
    expect(requests).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(4)

    subscription.close()
  })

  it('5xx 风暴不会无限加速：10 秒内的请求次数受退避上限约束', async () => {
    const subscription = subscribeAgentWorkStream('s1', () => undefined, {
      onEvent: () => undefined,
    })

    // 推进 10 秒：若退避被错误重置，这里会产生约 10 次以上请求。
    await vi.advanceTimersByTimeAsync(10_000)

    expect(requests.length).toBeLessThanOrEqual(4)
    subscription.close()
  })

  it('close() 后停止重连', async () => {
    const subscription = subscribeAgentWorkStream('s1', () => undefined, {
      onEvent: () => undefined,
    })
    await vi.advanceTimersByTimeAsync(0)
    const afterFirst = requests.length

    subscription.close()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(requests).toHaveLength(afterFirst)
  })
})

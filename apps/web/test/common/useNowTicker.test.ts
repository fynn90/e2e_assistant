/**
 * 实时时钟 composable 的单元测试。
 *
 * 覆盖：按间隔推进、启用条件控制启停、转为启用时立即对齐（不等首个间隔）、
 * 组件卸载与显式 dispose 后不再持有定时器。
 *
 * 全部用例必须用 fake timers：真实定时器会让断言依赖挂钟，天生不稳定。
 */
import { defineComponent, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNowTicker } from '../../src/common/time/useNowTicker'

/**
 * 挂载一个持有 useNowTicker 的宿主组件。
 *
 * useNowTicker 依赖 onBeforeUnmount 与 watch，必须在组件 setup 中运行。
 *
 * @param enabled - 启停条件引用。
 * @param intervalMs - 可选的轮询间隔。
 * @returns 组件实例与 ticker 返回值。
 * @throws 不抛出异常。
 */
function mountTicker(
  enabled: Ref<boolean>,
  intervalMs?: number,
): {
  wrapper: ReturnType<typeof mount>
  ticker: ReturnType<typeof useNowTicker>
} {
  let ticker!: ReturnType<typeof useNowTicker>
  const wrapper = mount(
    defineComponent({
      setup() {
        ticker = useNowTicker({ enabled, intervalMs })
        return () => null
      },
    }),
  )
  return { wrapper, ticker }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useNowTicker（实时时钟）', () => {
  it('启用时按间隔推进当前时间', async () => {
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'))
    const enabled = ref(true)
    const { ticker, wrapper } = mountTicker(enabled)

    const initial = ticker.now.value
    expect(initial).toBe(Date.now())

    await vi.advanceTimersByTimeAsync(1000)
    expect(ticker.now.value).toBe(initial + 1000)

    await vi.advanceTimersByTimeAsync(1000)
    expect(ticker.now.value).toBe(initial + 2000)

    wrapper.unmount()
  })

  it('挂载时立即对齐当前时间，不等到首个间隔（避免第一秒不动）', () => {
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'))
    const { ticker, wrapper } = mountTicker(ref(true))

    // 尚未推进任何时间，值就应该已经是此刻的时钟。
    expect(ticker.now.value).toBe(Date.now())

    wrapper.unmount()
  })

  it('启用条件转 false 后停止推进', async () => {
    const enabled = ref(true)
    const { ticker, wrapper } = mountTicker(enabled)

    await vi.advanceTimersByTimeAsync(1000)
    const frozen = ticker.now.value

    enabled.value = false
    await vi.advanceTimersByTimeAsync(5000)

    // 阶段到达终态后不应再每秒触发重渲染。
    expect(ticker.now.value).toBe(frozen)

    wrapper.unmount()
  })

  it('从停用转为启用时立即对齐时间，不等满一个间隔', async () => {
    const enabled = ref(false)
    const { ticker, wrapper } = mountTicker(enabled)
    const initial = ticker.now.value

    // 停用期间时钟已走过 5 秒。
    await vi.advanceTimersByTimeAsync(5000)
    expect(ticker.now.value).toBe(initial)

    enabled.value = true
    await vi.advanceTimersByTimeAsync(0)

    // 重新启用后必须立刻拿到新时间，否则会先显示 5 秒前的旧值。
    expect(ticker.now.value).toBe(initial + 5000)

    wrapper.unmount()
  })

  it('组件卸载后清除定时器，不再推进', async () => {
    const { ticker, wrapper } = mountTicker(ref(true))

    await vi.advanceTimersByTimeAsync(1000)
    const frozen = ticker.now.value

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5000)

    // 卸载后定时器不残留（否则长会话中每次挂载都会泄漏一个）。
    expect(ticker.now.value).toBe(frozen)
  })

  it('非组件作用域调用时可用 dispose 显式释放', async () => {
    const ticker = useNowTicker({ enabled: ref(true) })

    await vi.advanceTimersByTimeAsync(1000)
    const frozen = ticker.now.value

    ticker.dispose()
    await vi.advanceTimersByTimeAsync(5000)

    expect(ticker.now.value).toBe(frozen)
  })

  it('dispose 后再次调用不抛异常（幂等）', () => {
    const ticker = useNowTicker({ enabled: ref(false) })

    expect(() => {
      ticker.dispose()
      ticker.dispose()
    }).not.toThrow()
  })
})

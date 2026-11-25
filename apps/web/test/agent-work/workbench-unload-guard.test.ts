/**
 * 任务中断守卫的单元测试（v13 需求 1）。
 *
 * 需求：Agent 在工作时，用户刷新或关闭浏览器页签，要提醒「进行中的工作会中断」。
 * 实现手段是 `beforeunload` —— 浏览器只在 `preventDefault()` 被调用时才弹原生确认。
 *
 * 覆盖：
 *   - 有任务在跑 → 注册并触发确认（`defaultPrevented` 为真）；
 *   - 没有任务 → **不**触发确认（否则每次关页签都被拦，属于骚扰）；
 *   - 组件卸载 → 移除监听（避免守卫泄漏到应用其他部分）；
 *   - **不监听 pagehide**：切页签会触发它，而需求限定的是「刷新 / 关闭」。
 */
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchUnloadGuard } from '../../src/composables/useWorkbenchUnloadGuard'

/**
 * 挂载一个使用守卫的宿主组件。
 *
 * @param isWorking - 任务运行判定。
 * @returns 包装器；卸载它即可验证监听被移除。
 * @throws 不抛出异常。
 */
function mountGuard(isWorking: () => boolean) {
  return mount(
    defineComponent({
      setup() {
        useWorkbenchUnloadGuard({ isWorking })
        return () => null
      },
    }),
  )
}

/**
 * 派发一次 beforeunload 并返回该事件。
 *
 * @returns 派发后的事件对象（`defaultPrevented` 表示守卫是否要求确认）。
 * @throws 不抛出异常。
 */
function fireBeforeUnload(): BeforeUnloadEvent {
  const event = new Event('beforeunload', {
    cancelable: true,
  }) as BeforeUnloadEvent
  window.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useWorkbenchUnloadGuard（v13 需求 1）', () => {
  it('有任务在运行时：刷新/关闭页签触发浏览器确认', () => {
    const wrapper = mountGuard(() => true)

    const event = fireBeforeUnload()

    // 浏览器只在 preventDefault 被调用时才弹原生确认框。
    expect(event.defaultPrevented).toBe(true)
    wrapper.unmount()
  })

  it('没有任务时：不触发确认（避免每次关页签都被拦）', () => {
    const wrapper = mountGuard(() => false)

    const event = fireBeforeUnload()

    expect(event.defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('任务结束后的刷新不再提示（判定是实时的，不是注册时快照）', () => {
    let working = true
    const wrapper = mountGuard(() => working)

    expect(fireBeforeUnload().defaultPrevented).toBe(true)

    // 任务结束：后续的刷新不应再被拦。
    working = false
    expect(fireBeforeUnload().defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('组件卸载后移除监听，守卫不泄漏', () => {
    const wrapper = mountGuard(() => true)
    wrapper.unmount()

    // 无组件持有该守卫时，beforeunload 不应再被阻止。
    expect(fireBeforeUnload().defaultPrevented).toBe(false)
  })

  it('不监听 pagehide：切换页签不应被当作「刷新/关闭」拦截', () => {
    const wrapper = mountGuard(() => true)

    // 需求限定为「刷新或关闭页签」。切换页签会触发 pagehide，
    // 但任务在服务端照常运行，不该在此提醒。
    const pagehide = new Event('pagehide', { cancelable: true })
    window.dispatchEvent(pagehide)

    expect(pagehide.defaultPrevented).toBe(false)
    wrapper.unmount()
  })
})

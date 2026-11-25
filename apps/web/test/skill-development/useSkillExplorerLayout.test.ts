/**
 * 验证 Skill 文件树布局的默认宽度、断点同步和抽屉焦点恢复。
 */
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillExplorerLayout } from '../../src/modules/skill-development/composables/useSkillExplorerLayout'

interface IMediaHarness {
  media: MediaQueryList
  setMatches(value: boolean): void
}

function createMediaHarness(initialMatches: boolean): IMediaHarness {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(max-width: 760px)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    ),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList

  return {
    media,
    setMatches(value: boolean) {
      matches = value
      const event = {
        matches: value,
        media: media.media,
      } as MediaQueryListEvent
      for (const listener of listeners) listener(event)
    },
  }
}

function mountHost() {
  return mount(
    defineComponent({
      setup() {
        return { layout: useSkillExplorerLayout() }
      },
      template: '<button ref="mobileExplorerTrigger">文件树</button>',
    }),
    { attachTo: document.body },
  )
}

describe('useSkillExplorerLayout', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    })
  })

  it('uses the intended desktop default instead of clamping a missing value to 220px', () => {
    const mediaHarness = createMediaHarness(false)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaHarness.media),
    )
    const wrapper = mountHost()

    expect(wrapper.vm.layout.isMobile.value).toBe(false)
    expect(wrapper.vm.layout.explorerWidth.value).toBe(280)
    const keyboardEvent = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      cancelable: true,
    })
    wrapper.vm.layout.resizeWithKeyboard(keyboardEvent)
    expect(keyboardEvent.defaultPrevented).toBe(true)
    expect(wrapper.vm.layout.explorerWidth.value).toBe(296)
    expect(localStorage.getItem('authine.skill-explorer-width')).toBe('296')
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('closes the mobile drawer on breakpoint changes and restores trigger focus after close', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    })
    const mediaHarness = createMediaHarness(true)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => mediaHarness.media),
    )
    const wrapper = mountHost()
    const trigger = wrapper.get('button')

    wrapper.vm.layout.openMobileDrawer()
    expect(wrapper.vm.layout.mobileDrawerVisible.value).toBe(true)
    wrapper.vm.layout.updateMobileDrawerVisibility(false)
    await wrapper.vm.layout.restoreMobileTriggerFocus()
    await nextTick()
    expect(document.activeElement).toBe(trigger.element)

    wrapper.vm.layout.openMobileDrawer()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1280,
    })
    mediaHarness.setMatches(false)
    expect(wrapper.vm.layout.isMobile.value).toBe(false)
    expect(wrapper.vm.layout.mobileDrawerVisible.value).toBe(false)
    expect(wrapper.vm.layout.explorerWidth.value).toBe(280)
    wrapper.unmount()
    vi.unstubAllGlobals()
  })
})

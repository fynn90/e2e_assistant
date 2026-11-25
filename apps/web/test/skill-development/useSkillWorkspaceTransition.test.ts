/**
 * 验证 Skill 子工作区动画资格、导航失败处理与 Chat 入场后焦点安全策略。
 */
import { defineComponent } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  createMemoryHistory,
  createRouter,
  type Router,
  type RouteRecordRaw,
} from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSkillWorkspaceTransition } from '../../src/modules/skill-development/composables/useSkillWorkspaceTransition'
import { SKILL_DEVELOPMENT_ROUTE_NAMES } from '../../src/router/skill-development-navigation'

const EmptyRoute = defineComponent({ template: '<div />' })
const routes: RouteRecordRaw[] = [
  {
    path: '/skill-dev/:skillId/chat',
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    component: EmptyRoute,
  },
  {
    path: '/skill-dev/:skillId/code',
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.code,
    component: EmptyRoute,
  },
  {
    path: '/skill-dev/:skillId/e2e-test-case',
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
    component: EmptyRoute,
  },
  {
    path: '/legacy/:skillId',
    redirect: (to) => ({
      name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
      params: { skillId: to.params.skillId },
    }),
  },
]

interface ITransitionHarness {
  router: Router
  wrapper: VueWrapper
  focusComposer: ReturnType<typeof vi.fn>
  transition: ReturnType<typeof useSkillWorkspaceTransition>
}

/**
 * 创建装载真实内存路由的工作区动画测试宿主。
 * @param initialPath 测试开始时的规范化工作区地址。
 * @returns 路由、组件包装器、Chat 聚焦桩和组合式函数实例。
 * @throws 初始路由无法解析时由 Vue Router 抛出异常。
 */
async function mountHarness(initialPath: string): Promise<ITransitionHarness> {
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(initialPath)
  await router.isReady()

  const focusComposer = vi.fn()
  let transition!: ReturnType<typeof useSkillWorkspaceTransition>
  const Host = defineComponent({
    setup() {
      transition = useSkillWorkspaceTransition({
        getChatPanelHandle: () => ({ focusComposer }),
      })
      return { transition }
    },
    template: `
      <main>
        <button class="chat-trigger">Chat</button>
        <button class="header-control">返回</button>
        <button class="explorer">文件树</button>
        <button id="skill-explorer-drawer">抽屉</button>
        <button role="dialog">对话框</button>
      </main>
    `,
  })
  const wrapper = mount(Host, {
    attachTo: document.body,
    global: { plugins: [router] },
  })

  return { router, wrapper, focusComposer, transition }
}

/**
 * 卸载测试宿主并清理添加到 document.body 的节点。
 * @param harness 待清理的测试宿主。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function unmountHarness(harness: ITransitionHarness): void {
  harness.wrapper.unmount()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useSkillWorkspaceTransition', () => {
  it('keeps the initial route immediate and animates only same-Skill panel changes', async () => {
    const harness = await mountHarness('/skill-dev/skill-001/chat')

    expect(harness.transition.transitionName.value).toBe('skill-workspace-none')

    await harness.router.push('/skill-dev/skill-001/code?path=test.spec.ts')
    expect(harness.transition.transitionName.value).toBe(
      'skill-workspace-panel',
    )

    await harness.router.push('/skill-dev/skill-001/code?path=helpers.ts')
    expect(harness.transition.transitionName.value).toBe('skill-workspace-none')

    await harness.router.push('/skill-dev/skill-001/e2e-test-case')
    expect(harness.transition.transitionName.value).toBe(
      'skill-workspace-panel',
    )

    await harness.router.push('/skill-dev/skill-002/chat')
    expect(harness.transition.transitionName.value).toBe('skill-workspace-none')

    unmountHarness(harness)
  })

  it('suppresses animation for redirected canonical navigation', async () => {
    const harness = await mountHarness(
      '/skill-dev/skill-001/code?path=test.spec.ts',
    )

    await harness.router.push('/legacy/skill-001')

    expect(harness.router.currentRoute.value.redirectedFrom?.path).toBe(
      '/legacy/skill-001',
    )
    expect(harness.transition.transitionName.value).toBe('skill-workspace-none')
    unmountHarness(harness)
  })

  it('defers explicit Chat focus until the entered panel is ready', async () => {
    const harness = await mountHarness(
      '/skill-dev/skill-001/code?path=test.spec.ts',
    )
    const trigger = harness.wrapper.get('.chat-trigger').element as HTMLElement
    trigger.focus()

    harness.transition.queueChatFocus()
    await harness.router.push('/skill-dev/skill-001/chat')

    expect(harness.focusComposer).not.toHaveBeenCalled()

    await harness.transition.handleAfterEnter()
    expect(harness.focusComposer).toHaveBeenCalledTimes(1)

    await harness.transition.handleAfterEnter()
    expect(harness.focusComposer).toHaveBeenCalledTimes(1)
    unmountHarness(harness)
  })

  it.each([
    ['another header control', '.header-control'],
    ['the explorer', '.explorer'],
    ['the mobile drawer', '#skill-explorer-drawer'],
    ['a dialog', '[role="dialog"]'],
  ])('does not steal focus from %s', async (_label, selector) => {
    const harness = await mountHarness(
      '/skill-dev/skill-001/code?path=test.spec.ts',
    )
    const chatTrigger = harness.wrapper.get('.chat-trigger')
      .element as HTMLElement
    chatTrigger.focus()
    harness.transition.queueChatFocus()
    await harness.router.push('/skill-dev/skill-001/chat')
    const focusTarget = harness.wrapper.get(selector).element as HTMLElement
    focusTarget.focus()

    await harness.transition.handleAfterEnter()

    expect(harness.focusComposer).not.toHaveBeenCalled()
    unmountHarness(harness)
  })

  it('clears pending focus when a navigation guard cancels the panel change', async () => {
    const harness = await mountHarness(
      '/skill-dev/skill-001/code?path=test.spec.ts',
    )
    const removeGuard = harness.router.beforeEach((to) => {
      if (to.name === SKILL_DEVELOPMENT_ROUTE_NAMES.chat) return false
      return true
    })
    const chatTrigger = harness.wrapper.get('.chat-trigger')
      .element as HTMLElement
    chatTrigger.focus()
    harness.transition.queueChatFocus()

    await harness.router.push('/skill-dev/skill-001/chat')
    await harness.transition.handleAfterEnter()

    expect(harness.router.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.code,
    )
    expect(harness.transition.transitionName.value).toBe('skill-workspace-none')
    expect(harness.focusComposer).not.toHaveBeenCalled()
    removeGuard()
    unmountHarness(harness)
  })
})

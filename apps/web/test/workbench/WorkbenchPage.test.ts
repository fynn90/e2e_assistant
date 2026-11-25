// 工作台布局测试：验证路由元数据驱动侧栏状态以及菜单导航的浏览器历史行为。
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { describe, expect, it } from 'vitest'
import WorkbenchPage from '../../src/pages/WorkbenchPage.vue'

const WorkbenchShellStub = defineComponent({
  name: 'WorkbenchShell',
  props: {
    activeNavigationKey: { type: String, required: true },
    pageTitle: { type: String, required: true },
  },
  emits: ['navigate'],
  template: `
    <section :data-active="activeNavigationKey">
      <h1>{{ pageTitle }}</h1>
      <button data-testid="navigate-skills" type="button" @click="$emit('navigate', 'skills')">Skill</button>
      <button data-testid="navigate-config" type="button" @click="$emit('navigate', 'config')">配置</button>
      <slot />
    </section>
  `,
})

/**
 * 创建包含工作台布局和两个测试子页面的内存路由。
 * @returns 已完成初始 Skill 页面导航的路由实例。
 * @throws 路由配置或导航失败时由 Vue Router 抛出异常。
 */
async function createWorkbenchRouter(): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: WorkbenchPage,
        children: [
          {
            path: 'skills',
            name: 'workbench-skills',
            component: { template: '<p>Skill content</p>' },
            meta: {
              workbenchNavigationKey: 'skills',
              workbenchPageTitle: 'Skill 管理',
            },
          },
          {
            path: 'config',
            name: 'workbench-config',
            component: { template: '<p>Config content</p>' },
            meta: {
              workbenchNavigationKey: 'config',
              workbenchPageTitle: '系统配置',
            },
          },
        ],
      },
    ],
  })
  await router.push('/skills')
  await router.isReady()
  return router
}

/**
 * 等待下一次路由完成，用于观察无 Promise 返回值的 history 导航。
 * @param router 待观察的路由实例。
 * @returns 下一次导航完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
function waitForNextNavigation(router: Router): Promise<void> {
  return new Promise((resolve) => {
    const removeGuard = router.afterEach(() => {
      removeGuard()
      resolve()
    })
  })
}

describe('WorkbenchPage', () => {
  it('uses child route metadata and preserves push history between pages', async () => {
    const router = await createWorkbenchRouter()
    const wrapper = mount(WorkbenchPage, {
      global: {
        plugins: [router],
        stubs: { WorkbenchShell: WorkbenchShellStub },
      },
    })

    expect(wrapper.get('section').attributes('data-active')).toBe('skills')
    expect(wrapper.get('h1').text()).toBe('Skill 管理')
    expect(wrapper.text()).toContain('Skill content')

    await wrapper.get('[data-testid="navigate-config"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/config')
    expect(wrapper.get('section').attributes('data-active')).toBe('config')
    expect(wrapper.get('h1').text()).toBe('系统配置')
    expect(wrapper.text()).toContain('Config content')

    const backNavigation = waitForNextNavigation(router)
    router.back()
    await backNavigation
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/skills')
    expect(wrapper.get('section').attributes('data-active')).toBe('skills')
    expect(wrapper.get('h1').text()).toBe('Skill 管理')
  })
})

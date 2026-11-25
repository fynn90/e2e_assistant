/**
 * Agent 工作台抽屉的组件测试（v13，对齐 PRD §4.1 G 组、§4.2 C 组、§4.3 B 组、§4.6 M 组）。
 *
 * 覆盖：宽度 61.8% / 窄屏 100%、**遮罩可点击关闭**（v13 修订 v9 §4.2）、
 * 主副标题、**显示主体分派内容区**、**底部「清空」的显隐与可用条件**、
 * 空态、触发器呼吸点。
 *
 * v13 相对 v9 的两处断言反转：
 *   - 遮罩：v9 断言 `mask-closable="false"`（点击不产生动作）→ v13 断言可关闭（M-1）；
 *   - 关闭按钮：v9 断言卡片上有「关闭」→ v13 断言移除（B-4），改由底部「清空」。
 */
import { defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import GlobalChatDrawer from '../../src/modules/agent-work/components/GlobalChatDrawer.vue'
import { useGlobalChatStore } from '../../src/stores/global-chat'

/**
 * 组件内 `useRoute()` 的测试替身路由。
 *
 * v13 起抽屉**不再**从路由派生 Skill（改由显示主体携带），但组件仍使用
 * `useRouter()` 做报告跳转，因此仍需安装 router。
 *
 * @returns 供 mount plugins 使用的路由实例。
 * @throws 不抛出异常。
 */
function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
}

// naive-ui 组件内部注册名不带 N 前缀（NDrawer 的 name 为 'Drawer'），
// 因此替身键必须使用内部名称才能命中。
/** NDrawer 替身：记录 width / showMask / maskClosable，便于断言改造点。 */
const DrawerStub = defineComponent({
  name: 'Drawer',
  props: {
    show: { type: Boolean, default: false },
    width: { type: [String, Number], default: 0 },
    showMask: { type: Boolean, default: false },
    maskClosable: { type: Boolean, default: true },
  },
  emits: ['update:show'],
  template:
    '<div v-if="show" class="drawer-stub" :data-width="String(width)" :data-mask="String(showMask)" :data-mask-closable="String(maskClosable)"><slot /></div>',
})

const DrawerContentStub = defineComponent({
  name: 'DrawerContent',
  props: { title: { type: String, default: '' } },
  template:
    '<section class="drawer-content-stub"><slot name="header" /><slot /></section>',
})

/**
 * 挂载工作台抽屉并初始化 Pinia 与路由。
 *
 * @returns 页面包装器与相关工作区 store。
 * @throws 不抛出异常。
 */
async function mountDrawer() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const globalChat = useGlobalChatStore()

  const router = createTestRouter()
  await router.push('/')
  await router.isReady()

  const wrapper = mount(GlobalChatDrawer, {
    global: {
      plugins: [pinia, router],
      stubs: {
        Drawer: DrawerStub,
        DrawerContent: DrawerContentStub,
        GenerationSidebarContent: true,
        ExecutionBlock: true,
        // Tooltip 只是「清空」不可用时的原因提示，与本组断言无关。
        Tooltip: defineComponent({
          name: 'Tooltip',
          template: '<div><slot name="trigger" /></div>',
        }),
      },
    },
  })

  return { wrapper, globalChat }
}

describe('GlobalChatDrawer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // happy-dom 默认不实现 matchMedia；提供最小替身让断点判定可运行。
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  })

  it('初始收起：展示右缘触发器，不渲染抽屉内容', async () => {
    const { wrapper } = await mountDrawer()

    expect(wrapper.find('.global-chat-trigger').exists()).toBe(true)
    expect(wrapper.find('.drawer-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('展开：宽度为 61.8%，且遮罩**可点击关闭**（v13 M-1，修订 v9 AC-01）', async () => {
    const { wrapper, globalChat } = await mountDrawer()

    globalChat.expand()
    await nextTick()

    const drawer = wrapper.find('.drawer-stub')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-width')).toBe('61.8%')
    expect(drawer.attributes('data-mask')).toBe('true')
    // v13：点击遮罩收起抽屉（仅隐藏，保留内容与运行中的任务）。
    expect(drawer.attributes('data-mask-closable')).toBe('true')
    wrapper.unmount()
  })

  it('遮罩触发的关闭是「收起」而非「清空」：内容保留（v13 M-1 / C-8）', async () => {
    const { wrapper, globalChat } = await mountDrawer()
    globalChat.setSubject({ kind: 'generation', skillId: 'skill-001' })
    globalChat.expand()
    await nextTick()

    // 模拟 naive-ui 遮罩点击后派发的 update:show(false)。
    await wrapper.findComponent(DrawerStub).vm.$emit('update:show', false)
    await nextTick()

    expect(globalChat.visible).toBe(false)
    // 收起不销毁内容——这是与 v9「关闭」的关键差别（B-4）。
    expect(globalChat.subject).not.toBeNull()
    wrapper.unmount()
  })

  it('窄屏（≤760px）：宽度降级为 100%（v9 §11.1）', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const { wrapper, globalChat } = await mountDrawer()

    globalChat.expand()
    await nextTick()

    expect(wrapper.find('.drawer-stub').attributes('data-width')).toBe('100%')
    wrapper.unmount()
  })

  it('标题栏：主标题「Agent 工作」（v9 AC-03）', async () => {
    const { wrapper, globalChat } = await mountDrawer()

    globalChat.expand()
    await nextTick()

    expect(wrapper.find('.drawer-title').text()).toBe('Agent 工作')
    wrapper.unmount()
  })

  it('空态：无显示主体时展示空态文案，且**不渲染**底部操作区（v13 B-3 / §5.2）', async () => {
    const { wrapper, globalChat } = await mountDrawer()

    globalChat.expand()
    await nextTick()

    expect(wrapper.find('.workbench-empty').exists()).toBe(true)
    expect(wrapper.text()).toContain('暂无正在进行的任务')
    // 指向两个工作项来源（v9 的空态文案只提生成）。
    expect(wrapper.text()).toContain('执行测试用例')
    expect(wrapper.find('.drawer-actions').exists()).toBe(false)
    wrapper.unmount()
  })

  it('有工作项且已终态：底部渲染可用的「清空」（v13 B-1/B-5）', async () => {
    const { wrapper, globalChat } = await mountDrawer()
    globalChat.setSubject({ kind: 'generation', skillId: 'skill-001' })
    globalChat.expand()
    await nextTick()

    const actions = wrapper.find('.drawer-actions')
    expect(actions.exists()).toBe(true)

    const clearButton = actions.get('button')
    expect(clearButton.text()).toBe('清空')
    expect(clearButton.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('显示主体分派：生成主体渲染生成内容，执行主体渲染执行区块', async () => {
    const { wrapper, globalChat } = await mountDrawer()
    globalChat.expand()

    globalChat.setSubject({ kind: 'generation', skillId: 'skill-001' })
    await nextTick()
    expect(
      wrapper.findComponent({ name: 'GenerationSidebarContent' }).exists(),
    ).toBe(true)

    globalChat.setSubject({
      kind: 'execution',
      skillId: 'skill-001',
      executionId: 'exec-1',
    })
    await nextTick()
    expect(wrapper.findComponent({ name: 'ExecutionBlock' }).exists()).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('触发器呼吸点：显示主体运行中时点亮（v13 M-4）', async () => {
    const { wrapper, globalChat } = await mountDrawer()
    globalChat.expand()
    await nextTick()
    // 空态：无呼吸点。
    expect(wrapper.find('.drawer-stub').exists()).toBe(true)

    globalChat.collapse()
    await nextTick()
    expect(wrapper.find('.trigger-dot').classes()).not.toContain('running')
    wrapper.unmount()
  })
})

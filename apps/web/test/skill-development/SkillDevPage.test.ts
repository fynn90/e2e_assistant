/**
 * 验证 Skill 开发页在真实子路由切换下保留面板实例、Chat 草稿与代码路由身份。
 */
import { computed, defineComponent, nextTick, shallowRef } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import {
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
  type Router,
} from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SkillDevPage from '../../src/pages/SkillDevPage.vue'
import { SKILL_DEVELOPMENT_ROUTE_NAMES } from '../../src/router/skill-development-navigation'

const mocks = vi.hoisted(() => ({
  useSkillDevelopment: vi.fn(),
  useSkillExplorerLayout: vi.fn(),
  usePlatformStore: vi.fn(),
  useOnboardingStore: vi.fn(),
}))

vi.mock('../../src/modules/skill-development/useSkillDevelopment', () => ({
  useSkillDevelopment: mocks.useSkillDevelopment,
}))
vi.mock(
  '../../src/modules/skill-development/composables/useSkillExplorerLayout',
  () => ({
    useSkillExplorerLayout: mocks.useSkillExplorerLayout,
  }),
)
vi.mock('../../src/stores/platform', () => ({
  usePlatformStore: mocks.usePlatformStore,
}))
vi.mock('../../src/modules/onboarding/stores/onboarding', () => ({
  useOnboardingStore: mocks.useOnboardingStore,
}))
// v11 起页面持有 useGlobalMessage（删除报告/执行失败等提示）。它内部调用
// naive-ui 的 useMessage()，要求外层存在 <n-message-provider>——本测试直接
// mount 页面组件、没有 provider 子树，setup 阶段即抛错。本文件的既有策略是
// mock 页面重依赖（useSkillDevelopment / layout / stores），消息提示沿用同一
// 策略替身化；用例均不断言消息内容，只验证路由与面板实例的连续性。
vi.mock('../../src/composables/useGlobalMessage', () => ({
  useGlobalMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  }),
}))

const ChatRoute = defineComponent({
  name: 'SkillDevelopmentChatRoute',
  props: { context: { type: Object, required: true } },
  template: `
    <section class="route-chat">
      <input
        ref="composer"
        data-testid="chat-draft"
        :value="context.chatDraft.value"
        @input="context.chatDraft.value = $event.target.value"
      />
    </section>
  `,
})

let codeMountCount = 0
const CodeRoute = defineComponent({
  name: 'SkillDevelopmentCodeRoute',
  setup() {
    codeMountCount += 1
    return { instanceId: codeMountCount }
  },
  template:
    '<section class="route-code" :data-instance="instanceId">Code</section>',
})

const E2ERoute = defineComponent({
  name: 'SkillDevelopmentE2ETestCaseRoute',
  template: '<section class="route-e2e">E2E</section>',
})

const SkillDevHeaderStub = defineComponent({
  name: 'SkillDevHeader',
  emits: ['back', 'showChat'],
  template: `
    <header class="skill-dev-header">
      <button class="back-control" type="button" @click="$emit('back')">返回</button>
      <button class="show-chat" type="button" @click="$emit('showChat')">Chat</button>
    </header>
  `,
})

interface IPageHarness {
  router: Router
  wrapper: VueWrapper
}

/**
 * 创建包含真实 RouterView、Transition 和 KeepAlive 的 Skill 开发页测试宿主。
 * @param initialPath 初始工作区地址。
 * @returns 路由和页面包装器。
 * @throws 初始路由无法解析时由 Vue Router 抛出异常。
 */
async function mountPage(initialPath: string): Promise<IPageHarness> {
  const chatDraft = shallowRef('')
  const skill = shallowRef({
    id: 'abc123def',
    title: '连续工作区',
    description: '',
    readOnly: false,
  })
  const development = {
    pageState: shallowRef('ready'),
    errorMessage: shallowRef(''),
    skill,
    fileTree: shallowRef([]),
    refreshingTree: shallowRef(false),
    // v11：执行按钮显隐条件。模板以 `development.executionVisible.value` 直接求值
    // 传给 SkillExplorer（渲染期解引用），缺失会让整页渲染抛错。
    executionVisible: shallowRef(false),
    currentFile: shallowRef(null),
    selectedPath: shallowRef<string | undefined>(),
    messages: shallowRef([]),
    streaming: shallowRef(false),
    dirty: computed(() => false),
    saving: shallowRef(false),
    saveState: shallowRef('idle'),
    unsavedDialogVisible: shallowRef(false),
    loadPage: vi.fn(async () => undefined),
    activateWorkspaceTarget: vi.fn(async () => true),
    refreshTree: vi.fn(async () => true),
    refreshTreeManually: vi.fn(async () => undefined),
    retryChat: vi.fn(async () => undefined),
    saveCurrentFile: vi.fn(async () => true),
    openRawE2ETestCase: vi.fn(async () => undefined),
    setStructuredDirty: vi.fn(),
    updateSkillProjection: vi.fn(),
    structuredEditorHandle: shallowRef(null),
    registerStructuredEditor: vi.fn(),
    openFile: vi.fn(async () => true),
    confirmUnsavedSave: vi.fn(),
    confirmUnsavedDiscard: vi.fn(),
    cancelUnsavedNavigation: vi.fn(),
    returnToWorkbench: vi.fn(async () => undefined),
    sendChat: vi.fn(async () => undefined),
    stopChat: vi.fn(),
  }
  mocks.useSkillDevelopment.mockReturnValue(development)
  mocks.useSkillExplorerLayout.mockReturnValue({
    isMobile: shallowRef(false),
    explorerWidth: shallowRef(280),
    maximumExplorerWidth: shallowRef(576),
    mobileDrawerVisible: shallowRef(false),
    openMobileDrawer: vi.fn(),
    updateMobileDrawerVisibility: vi.fn(),
    closeMobileDrawer: vi.fn(),
    restoreMobileTriggerFocus: vi.fn(async () => undefined),
    startResize: vi.fn(),
    resizeWithKeyboard: vi.fn(),
  })
  mocks.usePlatformStore.mockReturnValue({
    chatReady: true,
    configSummary: null,
  })
  mocks.useOnboardingStore.mockReturnValue({
    shouldShowProgress: false,
    onboardingState: null,
    recordCaseReady: vi.fn(),
    recordReviewedScriptSaved: vi.fn(),
    dismissGuide: vi.fn(),
    acknowledgeCompletion: vi.fn(),
  })

  const routes: RouteRecordRaw[] = [
    {
      path: '/skill-dev/:skillId',
      component: SkillDevPage,
      children: [
        {
          path: 'chat',
          name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
          component: ChatRoute,
          meta: { skillDevelopmentPanel: 'chat' },
        },
        {
          path: 'code',
          name: SKILL_DEVELOPMENT_ROUTE_NAMES.code,
          component: CodeRoute,
          meta: { skillDevelopmentPanel: 'code' },
        },
        {
          path: 'e2e-test-case',
          name: SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
          component: E2ERoute,
          meta: { skillDevelopmentPanel: 'e2e-test-case' },
        },
      ],
    },
  ]
  const router = createRouter({ history: createMemoryHistory(), routes })
  await router.push(initialPath)
  await router.isReady()
  // v9 起页面持有生成流程 store（侧边栏内容与关闭时的 flush），必须安装 Pinia。
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(SkillDevPage, {
    attachTo: document.body,
    global: {
      plugins: [router, pinia],
      stubs: {
        transition: false,
        SkillDevHeader: SkillDevHeaderStub,
        SkillExplorer: true,
        OnboardingProgressStrip: true,
        SkillDevelopmentLoading: true,
        SkillDevelopmentError: true,
        UnsavedChangesDialog: true,
        GlobalChatDrawer: true,
        NDrawer: true,
        NDrawerContent: true,
        NModal: true,
        NCard: true,
        NSpace: true,
        NButton: true,
      },
    },
  })
  await settleWorkspace()

  return { router, wrapper }
}

/**
 * 等待路由、异步 watch 和 Transition 钩子完成。
 * @returns 当前异步界面更新完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function settleWorkspace(): Promise<void> {
  await flushPromises()
  await nextTick()
  await new Promise((resolve) => window.setTimeout(resolve, 20))
  await flushPromises()
}

beforeEach(() => {
  codeMountCount = 0
  localStorage.clear()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('SkillDevPage workspace continuity', () => {
  it('preserves cached Chat draft state across Code and E2E panel switches', async () => {
    const harness = await mountPage('/skill-dev/abc123def/chat')
    const chatInput = harness.wrapper.get('[data-testid="chat-draft"]')
    await chatInput.setValue('保留这段待发送内容')

    await harness.router.push('/skill-dev/abc123def/code?path=test.spec.ts')
    await settleWorkspace()
    expect(harness.wrapper.find('.route-code').exists()).toBe(true)

    await harness.router.push('/skill-dev/abc123def/e2e-test-case')
    await settleWorkspace()
    expect(harness.wrapper.find('.route-e2e').exists()).toBe(true)

    await harness.router.push('/skill-dev/abc123def/chat')
    await settleWorkspace()

    expect(
      harness.wrapper.get('[data-testid="chat-draft"]').element,
    ).toHaveProperty('value', '保留这段待发送内容')
    harness.wrapper.unmount()
  })

  it('reuses the Code route instance when only the file query changes', async () => {
    const harness = await mountPage(
      '/skill-dev/abc123def/code?path=test.spec.ts',
    )
    const firstInstance = harness.wrapper
      .get('.route-code')
      .attributes('data-instance')

    await harness.router.push('/skill-dev/abc123def/code?path=helpers.ts')
    await settleWorkspace()

    expect(harness.wrapper.get('.route-code').attributes('data-instance')).toBe(
      firstInstance,
    )
    expect(codeMountCount).toBe(1)
    harness.wrapper.unmount()
  })
})

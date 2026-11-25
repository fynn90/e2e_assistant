<!-- 组合 Skill 文件树、路由工作区、Chat、代码编辑器、结构化用例与激活引导。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  NButton,
  NCard,
  NDrawer,
  NDrawerContent,
  NModal,
  NSpace,
  NTag,
} from 'naive-ui'
import OnboardingProgressStrip from '../modules/onboarding/components/OnboardingProgressStrip.vue'
import { useOnboardingStore } from '../modules/onboarding/stores/onboarding'
import SkillDevHeader from '../modules/skill-development/SkillDevHeader.vue'
import UnsavedChangesDialog from '../modules/skill-development/UnsavedChangesDialog.vue'
import SkillDevelopmentError from '../modules/skill-development/SkillDevelopmentError.vue'
import SkillDevelopmentLoading from '../modules/skill-development/SkillDevelopmentLoading.vue'
import SkillExplorer from '../modules/skill-development/SkillExplorer.vue'
import { useSkillExplorerLayout } from '../modules/skill-development/composables/useSkillExplorerLayout'
import { useSkillWorkspaceTransition } from '../modules/skill-development/composables/useSkillWorkspaceTransition'
import { useSkillDevelopment } from '../modules/skill-development/useSkillDevelopment'
import { useExecutionStore } from '../stores/execution'
import { deleteTestReport } from '../services/execution-api'
import { deleteSkillFile } from '../services/skill-api'
import { useGlobalMessage } from '../composables/useGlobalMessage'
import type {
  IChatPanelHandle,
  ISkillDevelopmentWorkspaceContext,
} from '../modules/skill-development/types'
import {
  createSkillDevelopmentChatLocation,
  createSkillDevelopmentE2ETestCaseLocation,
  parseSkillDevelopmentWorkspaceTarget,
  type TSkillDevelopmentPanel,
} from '../router/skill-development-navigation'
import { WORKBENCH_ROUTE_NAMES } from '../router/workbench-navigation'
import { usePlatformStore } from '../stores/platform'
import { useGenerationFlowStore } from '../stores/generation-flow'
import { useGlobalChatStore } from '../stores/global-chat'
import {
  beginSubject,
  describeGenerationRejection,
} from '../modules/agent-work/workbench-subject'
import {
  activeGenerationFileName,
  clearSubjectContent,
  confirmSubjectSwitch,
  isSubjectRunning,
} from '../modules/agent-work/useWorkbenchSubject'

const route = useRoute()
const router = useRouter()
const platformStore = usePlatformStore()
const onboardingStore = useOnboardingStore()
const disclosureKey = computed(() => {
  const summary = platformStore.configSummary
  const destination = summary
    ? `${summary.llmApiBaseUrl}|${summary.llmModelName}`
    : 'unconfigured'
  return `authine.chat-disclosure.v1:${encodeURIComponent(destination)}`
})
const skillId = computed(() =>
  typeof route.params.skillId === 'string' ? route.params.skillId : '',
)
const activePanel = computed<TSkillDevelopmentPanel>(
  () => route.meta.skillDevelopmentPanel ?? 'chat',
)
// 顶栏副标题：代码面板展示当前文件路径，结构化 E2E 面板展示用例文件名，
// 图片面板展示当前预览的图片路径（与代码面板同一口径：副标题即当前文件）
const headerSubtitle = computed(() => {
  if (activePanel.value === 'code') {
    return development.currentFile.value?.relativePath ?? ''
  }
  if (activePanel.value === 'image') {
    return typeof route.query.path === 'string' ? route.query.path : ''
  }
  if (activePanel.value === 'e2e-test-case') {
    return structuredEditorHandle.value?.toolbarSubtitle ?? 'e2e_schema.json'
  }
  return ''
})
// 结构化编辑器句柄（面板未打开或测试替身未提供时为 null）
const structuredEditorHandle = computed(
  () => development.structuredEditorHandle?.value ?? null,
)
// 结构化 E2E 面板是否激活：决定是否在页头渲染其状态标签与操作按钮
const e2ePanelActive = computed(() => activePanel.value === 'e2e-test-case')
// 代码面板是否有打开的文件：文件名、状态标签与保存入口统一在页头展示
const codeFileOpen = computed(
  () => activePanel.value === 'code' && Boolean(development.currentFile.value),
)
// 当前文件是否只读（技能只读、文件只读或孤儿文件）
const currentFileReadOnly = computed(() =>
  Boolean(
    development.skill.value?.readOnly ||
    development.currentFile.value?.readOnly ||
    development.currentFile.value?.orphaned,
  ),
)
const onboardingForCurrentSkill = computed(
  () =>
    onboardingStore.shouldShowProgress &&
    onboardingStore.onboardingState?.activeSkillId === skillId.value,
)
const showOnboardingCaseHint = computed(
  () =>
    onboardingForCurrentSkill.value &&
    !onboardingStore.onboardingState?.milestones['case-ready'],
)
const chatReady = computed(() => platformStore.chatReady)
const development = useSkillDevelopment(skillId)
const generationFlow = useGenerationFlowStore()
const globalChatStore = useGlobalChatStore()
const executionStore = useExecutionStore()
const pageMessage = useGlobalMessage()
const explorerLayout = useSkillExplorerLayout()
const explorerExpandedKeys = ref<string[]>([])
const disclosureVisible = ref(false)
const pendingChatContent = ref('')
const chatDraft = ref('')
let chatPanelHandle: IChatPanelHandle | null = null
const workspaceTransition = useSkillWorkspaceTransition({
  getChatPanelHandle: () => chatPanelHandle,
})

// —— 执行（v11）：发起、按钮状态与文件树实时刷新 ——
const executionRunning = computed(() =>
  skillId.value ? executionStore.isRunning(skillId.value) : false,
)

/**
 * 「切换工作台显示内容」的确认动作（v13 PRD C-5 第 ① 条）。
 *
 * 必须在 `setup` 中创建：`useDialog()` 的依赖注入只在此刻可用。
 */

/** 文件树实时刷新的 300ms 防抖（X17：连续 files-changed 合并为一次刷新）。 */
let treeRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 发起执行测试用例（文件树按钮入口）。
 *
 * 顺序（v13 PRD §4.2 C-2/C-4 与 R-3）：
 *   1. 运行中直接返回（入口已置灰，这里是二道防线）；
 *   2. **发起前编排**（`beginSubject`）：有运行中的执行时先确认；有运行中的
 *      生成时直接拒绝（切换即中止生成）；
 *   3. J3 前置（草稿静默落盘 / 未保存用例阻断）；
 *   4. 经执行 store 发起；**真正启动**（返回 true）才落地显示主体并清空旧内容。
 *
 * 第 4 步的时机是关键：若在执行启动前落地主体，就绪校验失败（422）时
 * 主体会指向一个并不存在的执行，且违反 C-4「未启动则不清空」。
 *
 * @returns 无返回值。
 * @throws 不抛出异常；网络错误通过全局消息提示。
 */
async function handleExecute(): Promise<void> {
  if (executionRunning.value) return

  const outcome = await beginSubject({
    kind: 'execution',
    skillId: skillId.value,
    current: globalChatStore.subject,
    currentRunning: isSubjectRunning(),
    confirm: confirmSubjectSwitch,
  })

  if (outcome === 'rejected-running-generation') {
    // 生成运行中不得切换：切换会中止服务端的生成轮次（技术方案 §3.5）。
    pageMessage.warning(describeGenerationRejection(activeGenerationFileName()))
    return
  }
  if (outcome !== 'started') return

  if (!(await development.prepareForExecution())) {
    return
  }

  try {
    const launched = await executionStore.startExecution(skillId.value)
    if (!launched) return

    // 真正启动：清空旧工作项内容并落地新主体（PRD C-2）。
    clearSubjectContent()
    globalChatStore.setSubject({
      kind: 'execution',
      skillId: skillId.value,
      ...(executionStore.records[skillId.value]?.skillTitle
        ? { skillTitle: executionStore.records[skillId.value]!.skillTitle }
        : {}),
      executionId: executionStore.records[skillId.value]?.executionId ?? '',
    })
    globalChatStore.expand()
  } catch (error) {
    pageMessage.error(
      error instanceof Error ? error.message : '发起执行失败，请稍后重试。',
    )
  }
}

onBeforeUnmount(() => {
  if (treeRefreshDebounceTimer) {
    clearTimeout(treeRefreshDebounceTimer)
    treeRefreshDebounceTimer = null
  }
  executionStore.setTreeRefresher(null)
})

// 进入 / 切换 Skill 页面时恢复最近执行的展示状态并续连事件流（X16）。
watch(
  skillId,
  (nextSkillId) => {
    if (!nextSkillId) return
    void executionStore.restore(nextSkillId)
  },
  { immediate: true },
)

// 注入文件树实时刷新回调（X17）：执行事件携带 files-changed 时防抖刷新。
watch(
  skillId,
  (nextSkillId) => {
    if (!nextSkillId) return
    executionStore.setTreeRefresher(() => {
      if (treeRefreshDebounceTimer) {
        clearTimeout(treeRefreshDebounceTimer)
      }
      treeRefreshDebounceTimer = setTimeout(() => {
        treeRefreshDebounceTimer = null
        void development.refreshTree()
      }, 300)
    })
  },
  { immediate: true },
)

// 报告视图激活时展开文件树的目录链路（test_report → 时间戳目录，PRD V3）。
watch(
  () => [activePanel.value, route.params.runId] as const,
  ([panel, runId]) => {
    if (panel !== 'report' || typeof runId !== 'string') return

    const expandKeys = new Set(explorerExpandedKeys.value)
    expandKeys.add('test_report')
    expandKeys.add(`test_report/${runId}`)
    explorerExpandedKeys.value = [...expandKeys]
  },
  { immediate: true },
)

// 图片预览激活时展开该图片所在的目录链路（v13）。
// 不展开的话，深层图片（如 baselines/preview/x.png）在树里是收起的，
// 用户看不出当前预览的是哪个节点，侧栏与主区会失去视觉对应。
watch(
  () => [activePanel.value, route.query.path] as const,
  ([panel, path]) => {
    if (panel !== 'image' || typeof path !== 'string' || path.length === 0)
      return

    const segments = path.split('/')
    const expandKeys = new Set(explorerExpandedKeys.value)

    // 逐级累加目录前缀：baselines/preview/x.png → baselines、baselines/preview
    for (let index = 1; index < segments.length; index += 1) {
      expandKeys.add(segments.slice(0, index).join('/'))
    }

    explorerExpandedKeys.value = [...expandKeys]
  },
  { immediate: true },
)

const errorCopy = computed(() => {
  const state = development.pageState.value
  if (state === 'invalid-id')
    return {
      title: '无效的 Skill 地址',
      description: 'Skill ID 格式不正确。',
      retryable: false,
    }
  if (state === 'not-found')
    return {
      title: 'Skill 不存在或已被删除',
      description: development.errorMessage.value,
      retryable: false,
    }
  if (state === 'corrupted')
    return {
      title: 'Skill 加载失败',
      description: development.errorMessage.value,
      retryable: true,
    }
  if (state === 'permission-denied')
    return {
      title: '没有权限读取 Skill 目录',
      description: development.errorMessage.value,
      retryable: true,
    }
  if (state === 'service-unavailable')
    return {
      title: '本地服务不可用',
      description: development.errorMessage.value,
      retryable: true,
    }
  return {
    title: 'Skill 加载失败',
    description: development.errorMessage.value,
    retryable: true,
  }
})

const draftContent = computed({
  get: () => development.currentFile.value?.draftContent ?? '',
  set: (value: string) => {
    if (development.currentFile.value)
      development.currentFile.value.draftContent = value
  },
})

const workspaceContext: ISkillDevelopmentWorkspaceContext = {
  skill: development.skill,
  currentFile: development.currentFile,
  draftContent,
  chatDraft,
  messages: development.messages,
  streaming: development.streaming,
  dirty: development.dirty,
  saving: development.saving,
  saveState: development.saveState,
  autoSaveState: development.autoSaveState,
  autoSaveDiagnostics: development.autoSaveDiagnostics,
  autoSaveBlockedIssues: development.autoSaveBlockedIssues,
  autoSaveErrorMessage: development.autoSaveErrorMessage,
  envFileState: development.envFileState,
  retryAutoSave: development.retryAutoSave,
  reloadAutoSave: development.reloadAutoSave,
  chatReady,
  showOnboardingCaseHint,
  requestSend,
  stopChat,
  retryChat: development.retryChat,
  saveCurrentFile: development.saveCurrentFile,
  openRawE2ETestCase: development.openRawE2ETestCase,
  refreshTree: development.refreshTree,
  setStructuredDirty: development.setStructuredDirty,
  updateSkillProjection: development.updateSkillProjection,
  recordCaseReady: onboardingStore.recordCaseReady,
  recordReviewedScriptSaved: onboardingStore.recordReviewedScriptSaved,
  registerChatPanel,
  registerStructuredEditor: development.registerStructuredEditor,
}

watch(
  skillId,
  async () => {
    chatDraft.value = ''
    pendingChatContent.value = ''
    disclosureVisible.value = false
    await development.loadPage()
    await synchronizeWorkspaceRoute()
  },
  { immediate: true },
)
watch(
  () => route.fullPath,
  () => void synchronizeWorkspaceRoute(),
)
watch(
  () =>
    [
      development.pageState.value,
      development.skill.value?.id,
      onboardingForCurrentSkill.value,
    ] as const,
  ([pageState, loadedSkillId, activeOnboarding]) => {
    const target = parseSkillDevelopmentWorkspaceTarget(route)
    if (
      pageState !== 'ready' ||
      loadedSkillId !== skillId.value ||
      !activeOnboarding ||
      target?.panel !== 'chat' ||
      development.selectedPath.value
    ) {
      return
    }

    void router.replace(
      createSkillDevelopmentE2ETestCaseLocation(skillId.value),
    )
  },
)
onBeforeUnmount(() => {
  development.registerStructuredEditor(null)
  registerChatPanel(null)
  // 离开 Skill 开发页：只**静默 flush** 待发改动，**不销毁**工作台内容（v13 PRD R-7）。
  //
  // v9 在此调用 `generationFlow.close()`（清空 + 收起），那正是「离开页面就失联」
  // 的根因：正在运行的生成会从界面上消失，产物卡片也一并销毁。v13 的工作台是
  // 应用级单槽控制台，离开页面只应保存改动，内容的去留由用户通过「清空」决定。
  void generationFlow.flushAll()
})

/**
 * 根据当前 URL 激活对应工作区资源，并修复缺少有效子目标的地址。
 * @returns 路由同步完成后兑现的 Promise。
 * @throws 不抛出异常，资源错误由 useSkillDevelopment 展示并规范化路由。
 */
async function synchronizeWorkspaceRoute(): Promise<void> {
  if (
    development.pageState.value !== 'ready' ||
    development.skill.value?.id !== skillId.value
  ) {
    return
  }

  const target = parseSkillDevelopmentWorkspaceTarget(route)
  if (!target) {
    await router.replace(createSkillDevelopmentChatLocation(skillId.value))
    return
  }

  await development.activateWorkspaceTarget(target)
}

/**
 * 重试页面加载，并在成功后重新激活当前未变化的深链工作区。
 * @returns 页面加载与工作区同步完成后兑现的 Promise。
 * @throws 不抛出异常，加载错误由 useSkillDevelopment 映射到页面状态。
 */
async function retryPage(): Promise<void> {
  await development.loadPage()
  await synchronizeWorkspaceRoute()
}

/**
 * 注册缓存 Chat 子路由暴露的输入框聚焦句柄。
 * @param handle 当前 ChatPanel 句柄；组件卸载时传入 null。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function registerChatPanel(handle: IChatPanelHandle | null): void {
  chatPanelHandle = handle
}

/**
 * 在第三方模型披露已接受时发送 Chat，否则先展示确认对话框。
 * @param content 用户待发送的文本。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function requestSend(content: string): void {
  if (localStorage.getItem(disclosureKey.value) === 'accepted') {
    dispatchChat(content)
    return
  }

  pendingChatContent.value = content
  disclosureVisible.value = true
}

/**
 * 清空输入草稿并启动 Chat 流式请求。
 * @param content 已确认发送的用户文本。
 * @returns 无返回值。
 * @throws 不抛出异常，请求错误由 useSkillDevelopment 展示。
 */
function dispatchChat(content: string): void {
  chatDraft.value = ''
  void development.sendChat(content)
}

/**
 * 接受第三方模型披露并发送等待中的 Chat 内容。
 * @returns 无返回值。
 * @throws 本地存储不可用时由浏览器抛出异常。
 */
function acceptDisclosure(): void {
  localStorage.setItem(disclosureKey.value, 'accepted')
  disclosureVisible.value = false
  const content = pendingChatContent.value
  pendingChatContent.value = ''

  if (content) {
    dispatchChat(content)
  }
}

/**
 * 取消第三方模型披露并重新聚焦 Chat 输入框。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function declineDisclosure(): void {
  disclosureVisible.value = false
  pendingChatContent.value = ''
  void nextTick(() => chatPanelHandle?.focusComposer())
}

/**
 * 停止 Chat 流式请求并保持输入焦点。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function stopChat(): void {
  development.stopChat()
  void nextTick(() => chatPanelHandle?.focusComposer())
}

/**
 * 打开文件树资源，并在窄屏完成导航后关闭覆盖抽屉。
 * @param node 用户选中的 Skill 文件树节点。
 * @returns 路由导航完成后兑现的 Promise。
 * @throws 不主动抛出异常，导航失败由 Vue Router 处理。
 */
async function handleExplorerOpen(
  node: Parameters<typeof development.openFile>[0],
): Promise<void> {
  const opened = await development.openFile(node)

  if (opened && explorerLayout.isMobile.value) {
    explorerLayout.closeMobileDrawer()
  }
}

/**
 * 删除指定运行时间戳的测试报告（二次确认已由树上的 NPopconfirm 完成）。
 * 若当前正打开该报告视图，删除后回退到 Chat 面板。
 * @param runId 报告运行时间戳（yyyyMMdd-HHmmss）。
 * @returns 删除流程完成后兑现的 Promise。
 * @throws 不主动抛出异常，删除错误通过全局消息提示。
 */
async function handleDeleteReport(runId: string): Promise<void> {
  try {
    await deleteTestReport(skillId.value, runId)
    pageMessage.success('测试报告已删除。')

    const activeTarget = parseSkillDevelopmentWorkspaceTarget(route)
    if (activeTarget?.panel === 'report' && activeTarget.runId === runId) {
      await router.replace(createSkillDevelopmentChatLocation(skillId.value))
    }
    void development.refreshTree()
  } catch (error) {
    pageMessage.error(
      error instanceof Error ? error.message : '删除测试报告失败。',
    )
  }
}

/**
 * 删除文件树中的文件或目录（v13）。
 *
 * 二次确认已由树上的弹窗完成。删除成功后：
 *   1. **静默刷新**文件树——刷新会检测「当前打开的文件已不存在」，那是给
 *      **外部删除**（别处改了磁盘）用的提示；用户自己刚点的删除，再报一次
 *      「文件已不存在」是误报；
 *   2. 切换到结构化用例面板（落点理由见下）。
 *
 * **唯一不回退的情况**：被删文件有未保存修改。`refreshTree` 会把它保留为
 * 只读缓冲区供用户复制（PRD v4 §8.2），此时强制跳转会弹出离开确认，
 * 用户选「放弃」反而丢失内容。因此改由 `refreshTree` 的正常分支处理
 * （提示「已保留未保存内容供复制」并停在原地），不接续导航。
 *
 * **落点选结构化用例面板而非 Chat**：`e2e_schema.json` 属创建期保护文件、
 * 必不会被删（因此 `activateWorkspaceTarget` 的「不存在则回退」分支不会误触发）；
 * 且该面板会展示 Skill 文件，用户能直接看到删除结果，Chat 面板看不到。
 *
 * @param relativePath 被删内容在 Skill 内的相对路径。
 * @returns 删除流程完成后兑现的 Promise。
 * @throws 不主动抛出异常，删除错误通过全局消息提示。
 */
async function handleDeleteEntry(relativePath: string): Promise<void> {
  try {
    const result = await deleteSkillFile(skillId.value, relativePath)
    pageMessage.success(
      result.data.kind === 'directory' ? '目录已删除。' : '文件已删除。',
    )

    // 静默刷新：刷新会检测「当前打开的文件已不存在」，那是给外部删除用的提示，
    // 用户自己刚点的删除不该再被告知一次（详见 refreshTree 的参数说明）。
    // 该调用仍会保留未保存内容（如有）为只读缓冲区，此处只是不提示。
    await development.refreshTree({ suppressMissingNotice: true })

    // 被删文件若有未保存修改，refreshTree 已把它保留为 orphaned 缓冲区供复制。
    // 此时必须停在原地：跳转会在离开守卫处弹出确认，用户选「放弃」反而丢失内容。
    if (development.currentFile.value?.orphaned) return

    // 先刷新再跳转：`activateWorkspaceTarget` 以**内存中的文件树**校验
    // e2e_schema.json 是否存在，先刷新才能让它看到与磁盘一致的状态。
    const target = createSkillDevelopmentE2ETestCaseLocation(skillId.value)
    if (router.resolve(target).fullPath !== route.fullPath) {
      await router.replace(target)
    }

    // 跳转后再重载结构化用例文档（等一个 tick 让面板挂载、句柄就绪）。
    //
    // 被删的可能是 SKILL.md——按钮文案与 `skillDocumentVersion` 都取自编辑器
    // 缓存的文档状态，而 keep-alive 会缓存面板组件、`onMounted` 不再触发，
    // 不主动重载就会停在「更新 Skill 文档」按钮上（点下去被服务端版本比对拒绝）。
    // 重载后 exists 变 false，按钮自动显示「生成 Skill 文档」。
    await nextTick()
    await development.reloadStructuredDocument()
  } catch (error) {
    pageMessage.error(error instanceof Error ? error.message : '删除失败。')
  }
}
</script>

<template>
  <skill-development-loading v-if="development.pageState.value === 'loading'" />
  <skill-development-error
    v-else-if="development.pageState.value !== 'ready'"
    :title="errorCopy.title"
    :description="errorCopy.description"
    :retryable="errorCopy.retryable"
    @retry="retryPage"
    @back="router.push({ name: WORKBENCH_ROUTE_NAMES.skills })"
  />
  <div v-else-if="development.skill.value" class="skill-dev-page">
    <skill-dev-header
      :skill-title="development.skill.value.title"
      :skill-id="development.skill.value.id"
      :dirty="development.dirty.value"
      :subtitle="headerSubtitle"
      :file-open="codeFileOpen"
      :file-read-only="currentFileReadOnly"
      :save-state="development.saveState.value"
      :saving="development.saving.value"
      @back="development.returnToWorkbench"
      @save="development.saveCurrentFile"
    >
      <template v-if="e2ePanelActive && structuredEditorHandle" #status>
        <n-tag
          v-for="tag in structuredEditorHandle.toolbarTags"
          :key="tag.key"
          :type="tag.type"
          size="small"
          :title="tag.title"
          >{{ tag.label }}</n-tag
        >
      </template>
      <template v-if="e2ePanelActive && structuredEditorHandle" #actions>
        <n-button
          v-for="action in structuredEditorHandle.toolbarActions"
          :key="action.key"
          :type="action.primary ? 'primary' : 'default'"
          :secondary="action.secondary"
          :loading="action.loading"
          :disabled="!action.enabled"
          size="small"
          @click="action.run"
          >{{ action.label }}</n-button
        >
      </template>
    </skill-dev-header>

    <onboarding-progress-strip
      v-if="
        onboardingStore.shouldShowProgress &&
        onboardingForCurrentSkill &&
        onboardingStore.onboardingState
      "
      :state="onboardingStore.onboardingState"
      compact
      @dismiss="onboardingStore.dismissGuide"
      @acknowledge-completion="onboardingStore.acknowledgeCompletion"
    />

    <main class="skill-dev-main">
      <div
        v-if="!explorerLayout.isMobile.value"
        class="explorer-pane"
        :style="{ width: `${explorerLayout.explorerWidth.value}px` }"
      >
        <SkillExplorer
          v-model:expanded-keys="explorerExpandedKeys"
          :nodes="development.fileTree.value"
          :skill-id="skillId"
          :selected-path="development.selectedPath.value"
          :refreshing="development.refreshingTree.value"
          :execution-visible="development.executionVisible.value"
          :execution-running="executionRunning"
          :report-delete-enabled="development.skill.value?.readOnly !== true"
          :actions-enabled="development.skill.value?.readOnly !== true"
          @open="handleExplorerOpen"
          @refresh="development.refreshTreeManually"
          @created="development.refreshTree"
          @execute="handleExecute"
          @delete-report="handleDeleteReport"
          @delete-entry="handleDeleteEntry"
        />
      </div>
      <div
        v-if="!explorerLayout.isMobile.value"
        class="resize-handle"
        role="separator"
        tabindex="0"
        aria-label="调整文件树宽度"
        aria-orientation="vertical"
        aria-valuemin="220"
        :aria-valuemax="explorerLayout.maximumExplorerWidth.value"
        :aria-valuenow="Math.round(explorerLayout.explorerWidth.value)"
        @keydown="explorerLayout.resizeWithKeyboard"
        @pointerdown="explorerLayout.startResize"
      />
      <section class="workspace-pane" aria-label="Skill 编辑工作区">
        <div
          v-if="explorerLayout.isMobile.value"
          class="mobile-workspace-toolbar"
        >
          <button
            ref="mobileExplorerTrigger"
            type="button"
            class="mobile-explorer-trigger"
            aria-label="打开 Skill 文件树"
            aria-controls="skill-explorer-drawer"
            :aria-expanded="explorerLayout.mobileDrawerVisible.value"
            @click="explorerLayout.openMobileDrawer"
          >
            文件树
          </button>
          <span>当前文件：{{ development.selectedPath.value || 'Chat' }}</span>
        </div>
        <div class="workspace-content">
          <router-view v-slot="{ Component }">
            <transition
              :name="workspaceTransition.transitionName.value"
              mode="out-in"
              @after-enter="workspaceTransition.handleAfterEnter"
            >
              <keep-alive
                :key="development.skill.value.id"
                :include="[
                  'SkillDevelopmentChatRoute',
                  'SkillDevelopmentCodeRoute',
                  'SkillDevelopmentE2ETestCaseRoute',
                  'SkillDevelopmentReportRoute',
                  'SkillDevelopmentImageRoute',
                ]"
                :max="5"
              >
                <component :is="Component" :context="workspaceContext" />
              </keep-alive>
            </transition>
          </router-view>
        </div>
      </section>
    </main>

    <n-drawer
      v-if="explorerLayout.isMobile.value"
      id="skill-explorer-drawer"
      class="skill-explorer-drawer"
      aria-label="Skill 文件树"
      :show="explorerLayout.mobileDrawerVisible.value"
      display-directive="show"
      width="min(300px, calc(100vw - 24px))"
      placement="left"
      :auto-focus="true"
      :trap-focus="true"
      :mask-closable="true"
      @update:show="explorerLayout.updateMobileDrawerVisibility"
      @after-leave="explorerLayout.restoreMobileTriggerFocus"
    >
      <n-drawer-content
        title="Skill 文件树"
        closable
        body-content-style="padding: 0;"
      >
        <SkillExplorer
          v-model:expanded-keys="explorerExpandedKeys"
          :nodes="development.fileTree.value"
          :skill-id="skillId"
          :selected-path="development.selectedPath.value"
          :refreshing="development.refreshingTree.value"
          :execution-visible="development.executionVisible.value"
          :execution-running="executionRunning"
          :report-delete-enabled="development.skill.value?.readOnly !== true"
          :actions-enabled="development.skill.value?.readOnly !== true"
          @open="handleExplorerOpen"
          @refresh="development.refreshTreeManually"
          @created="development.refreshTree"
          @execute="handleExecute"
          @delete-report="handleDeleteReport"
          @delete-entry="handleDeleteEntry"
        />
      </n-drawer-content>
    </n-drawer>

    <!--
      工作台（v13）**不再**在此挂载：它已上移到应用外壳（App.vue），
      是全应用唯一实例。留在页面里会导致同屏渲染两个抽屉，
      且离开本页时随页面卸载而消失——正是 v13 要消除的问题。
    -->

    <n-modal :show="disclosureVisible" :mask-closable="false">
      <n-card
        title="发送到第三方模型服务"
        style="width: min(560px, calc(100vw - 32px))"
      >
        首次发送前请确认：Skill
        名称和描述、文件树摘要、当前已保存文件内容以及本页聊天消息会发送到你在平台配置中指定的第三方模型服务。未保存草稿不会发送。
        <template #footer>
          <n-space justify="end">
            <n-button @click="declineDisclosure">取消</n-button>
            <n-button type="primary" @click="acceptDisclosure"
              >同意并发送</n-button
            >
          </n-space>
        </template>
      </n-card>
    </n-modal>

    <unsaved-changes-dialog
      :show="development.unsavedDialogVisible.value"
      :saving="development.saving.value"
      :on-save="development.confirmUnsavedSave"
      :on-discard="development.confirmUnsavedDiscard"
      :on-cancel="development.cancelUnsavedNavigation"
    />
  </div>
</template>

<style scoped>
.skill-dev-page {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-border);
}

.skill-dev-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.explorer-pane {
  flex: 0 0 auto;
  min-width: 220px;
  max-width: 45vw;
}

.resize-handle {
  position: relative;
  width: 5px;
  cursor: col-resize;
  background: var(--color-border);
  transition: background-color var(--motion-fast) var(--ease-out);
}

.resize-handle:hover,
.resize-handle:focus-visible {
  background: var(--color-review);
}

.workspace-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-surface);
}

.workspace-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 裁剪面板溢出的内容，保证滚动只发生在面板内部的滚动容器中 */
  overflow: hidden;
}

.workspace-content > :deep(.chat-panel),
.workspace-content > :deep(.e2e-editor) {
  height: 100%;
}

.mobile-workspace-toolbar {
  display: none;
  align-items: center;
  gap: var(--space-md);
  min-height: 52px;
  padding: var(--space-xs) var(--space-md);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.mobile-workspace-toolbar > span {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-explorer-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 72px;
  height: 44px;
  padding-inline: var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink-body);
  box-shadow: 0 2px 8px rgb(15 23 42 / 8%);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.mobile-explorer-trigger:hover {
  border-color: var(--color-review);
  background: var(--color-well);
}

.mobile-explorer-trigger:focus-visible {
  outline: none;
  border-color: var(--color-review);
  box-shadow: var(--focus-ring);
}

.skill-explorer-drawer :deep(.n-drawer-header__close) {
  width: 44px;
  height: 44px;
}

@media (pointer: coarse) and (min-width: 761px) {
  .resize-handle::before {
    position: absolute;
    inset-block: 0;
    inset-inline: -20px;
    content: '';
  }
}

@media (max-width: 760px) {
  .mobile-workspace-toolbar {
    display: flex;
  }
}
</style>

<!-- 组合 E2E 基础信息、前置条件、步骤、就绪说明、冲突和生成流程；标题、状态标签与保存/生成操作通过句柄上移到页面顶栏。v9 起生成过程由侧边栏承载，编辑器内不再有生成弹窗。v10 起接收 env.json 状态：驱动敏感数据下拉、引用失效判定与就绪校验。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { NAlert, NButton, NSpin } from 'naive-ui'
import { useRouter } from 'vue-router'
import {
  findMissingEnvReferences,
  collectEnvReferences,
  SKILL_ENV_FILE_NAME,
  type IE2ETestCase,
  type IE2EValidationIssue,
} from '@authine-e2e-agent/types'
import E2ETestCaseBasicForm from './E2ETestCaseBasicForm.vue'
import E2ETestCaseReadinessPanel from './E2ETestCaseReadinessPanel.vue'
import PreconditionEditor from './PreconditionEditor.vue'
import TestStepTable from './TestStepTable.vue'
import ConflictDialog from './ConflictDialog.vue'
import { useE2ETestCase } from '../composables/useE2ETestCase'
import {
  useE2ETestCaseReadiness,
  type IE2EActionReason,
} from '../composables/useE2ETestCaseReadiness'
import { formatTimestamp } from '../utils/format-timestamp'
import { useGenerationFlowStore } from '../../../stores/generation-flow'
import { useGlobalChatStore } from '../../../stores/global-chat'
import { useGlobalMessage } from '../../../composables/useGlobalMessage'
import {
  beginSubject,
  describeGenerationRejection,
} from '../../agent-work/workbench-subject'
import {
  activeGenerationFileName,
  confirmSubjectSwitch,
  isSubjectRunning,
} from '../../agent-work/useWorkbenchSubject'
import { createSkillDevelopmentCodeLocation } from '../../../router/skill-development-navigation'
import type {
  IHeaderActionItem,
  IHeaderStatusTag,
  ISkillEnvFileState,
} from '../../skill-development/types'

const props = defineProps<{
  skillId: string
  chatReady: boolean
  readOnly: boolean
  showOnboardingHint?: boolean
  /** env.json 最新合法状态（v10）：下拉数据源、失效判定与就绪校验的数据源。 */
  envFileState?: ISkillEnvFileState
}>()
const router = useRouter()
const emit = defineEmits<{
  saved: [data: { title: string; description: string; version: string }]
  refreshTree: []
  openRaw: []
  dirtyChange: [dirty: boolean]
  caseReady: []
  reviewedScriptSaved: []
}>()
const skillIdRef = computed(() => props.skillId)
const readOnlyRef = computed(() => props.readOnly)
const chatReadyRef = computed(() => props.chatReady)
const activeReadiness = ref<'save' | 'generate' | null>(null)
const readinessPanelRef =
  useTemplateRef<InstanceType<typeof E2ETestCaseReadinessPanel>>(
    'readinessPanel',
  )
const stepTableRef =
  useTemplateRef<InstanceType<typeof TestStepTable>>('stepTable')
const editor = useE2ETestCase(skillIdRef, {
  onSaved: (data) => {
    emit('saved', {
      title: data.title,
      description: data.description,
      version: data.version,
    })

    if (data.generationReady) {
      emit('caseReady')
    }
  },
})
// v9：生成流程由侧边栏承载，两个阶段的状态机与产物卡片都收拢在 store 中。
// 本组件只负责「注入依赖」与「触发入口」，不再持有生成状态与弹窗。
const generationFlow = useGenerationFlowStore()
// v13：工作台改为应用级，本组件需要读写显示主体与查看是否已有运行中的工作项。
const globalChatStore = useGlobalChatStore()
const pageMessage = useGlobalMessage()
/** 「切换工作台显示内容」的确认动作；须在 setup 中创建（`useDialog` 依赖注入）。 */
generationFlow.setDependencies(
  {
    skill: {
      skillId: skillIdRef,
      draft: editor.draft,
      version: editor.version,
      sourceHash: editor.sourceHash,
      skillDocument: editor.skillDocument,
      dirty: editor.dirty,
      canGenerate: editor.canGenerate,
      saveTestCase: editor.save,
      onSaved: async () => {
        await editor.load()
        emit('refreshTree')
      },
    },
    script: {
      skillId: skillIdRef,
      draft: editor.draft,
      version: editor.version,
      sourceHash: editor.sourceHash,
      script: editor.script,
      dirty: editor.dirty,
      canGenerate: editor.canGenerate,
      saveTestCase: editor.save,
      onScriptSaved: async () => {
        emit('refreshTree')
        emit('reviewedScriptSaved')
        // 刷新用例版本与脚本状态：页头的「脚本最新」标签依赖它。
        await editor.load()
      },
    },
  },
  editor.sourceHash.value,
)
// 「重新加载」需要重新同步来源哈希：冲突多半来自用例变更。
generationFlow.setRefreshHandler(async () => {
  await editor.load()
  generationFlow.setSourceHash(editor.sourceHash.value)
})

// v10：env 引用就绪问题（PRD 6.3 / 7.3 J1–J3）。
// 由草稿 + envFileState 前端派生，仅注入 generate 与 generateScript 动作；
// save 动作不注入——保存用例不因引用失效被阻断（用户可能想先保存再补 env.json）。
const envReferenceIssues = computed<IE2EValidationIssue[]>(() => {
  const envState = props.envFileState
  const draft = editor.draft.value

  if (!envState || !draft || editor.status.value !== 'ready') return []
  // 读取中的暂不判定，避免闪现；用例无任何引用时 env.json 的任何状态都不阻断（J3）。
  if (envState.status.value === 'loading') return []
  if (collectEnvReferences(draft).length === 0) return []

  if (envState.status.value !== 'ok') {
    return [
      envState.status.value === 'invalid'
        ? {
            path: [SKILL_ENV_FILE_NAME],
            message: 'env.json 存在格式错误，请先修复后再生成。',
          }
        : {
            path: [SKILL_ENV_FILE_NAME],
            message:
              'env.json 缺失，无法承载用例引用的敏感数据，请先创建或恢复该文件。',
          },
    ]
  }

  // J1：逐个失效引用产出带定位的问题，path 与字段跳转机制同构。
  return findMissingEnvReferences(draft, new Set(envState.keys.value)).map(
    (finding) => ({
      path: finding.path,
      message: `引用的 key "${finding.key}" 在 env.json 中不存在，请在 env.json 中补充该 key 或移除此引用。`,
    }),
  )
})

const readiness = useE2ETestCaseReadiness({
  draft: editor.draft,
  status: editor.status,
  dirty: editor.dirty,
  saveIssues: editor.saveIssues,
  generationIssues: editor.generationIssues,
  envReferenceIssues,
  chatReady: chatReadyRef,
  readOnly: readOnlyRef,
  generationRunning: computed(() => generationFlow.isRunning),
  skillDocumentExists: computed(() =>
    Boolean(editor.skillDocument.value?.exists),
  ),
  // 只有「已基于当前用例」的 SKILL.md 才能支撑脚本生成：
  // 服务端会校验来源哈希一致，untracked（无生成元数据）与 stale 都会被拒绝。
  skillDocumentCurrent: computed(
    () => editor.skillDocument.value?.status === 'current',
  ),
  scriptGenerationRunning: computed(() => generationFlow.isRunning),
})
const activeAction = computed(() => {
  if (activeReadiness.value === 'save') return readiness.save.value
  if (activeReadiness.value === 'generate') return readiness.generate.value
  return null
})
const showReadinessPanel = computed(
  () =>
    Boolean(activeAction.value?.reasons.length) ||
    Boolean(
      activeReadiness.value === 'generate' &&
      readiness.generate.value.requiresSave,
    ),
)
const scriptTime = computed(() => {
  const value = editor.script.value?.updatedAt
  return value ? formatTimestamp(value) : null
})

/**
 * 替换整个结构化用例草稿。
 * @param value 最新结构化用例。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateDraft(value: IE2ETestCase): void {
  editor.draft.value = value
}

/**
 * 更新前置条件集合。
 * @param value 最新前置条件数组。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updatePreconditions(value: IE2ETestCase['preconditions']): void {
  if (editor.draft.value)
    editor.draft.value = { ...editor.draft.value, preconditions: value }
}

/**
 * 更新测试步骤集合。
 * @param value 最新测试步骤数组。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateSteps(value: IE2ETestCase['steps']): void {
  if (editor.draft.value)
    editor.draft.value = { ...editor.draft.value, steps: value }
}

/**
 * 关闭版本冲突对话框并继续保留本地草稿。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function closeConflict(): void {
  editor.conflictDocument.value = null
  editor.status.value = 'ready'
}

/**
 * 执行保存动作；不可用或校验失败时展示并聚焦原因摘要。
 * @returns 保存是否成功。
 * @throws API 异常由编辑器组合式函数捕获并转换为页面状态。
 */
async function handleSave(): Promise<boolean> {
  editor.showSaveValidation()

  if (!readiness.save.value.enabled) {
    await showReadiness('save')
    return false
  }

  activeReadiness.value = null
  const saved = await editor.save()

  if (
    !saved &&
    (editor.saveIssues.value.length > 0 || editor.status.value === 'error')
  ) {
    await showReadiness('save')
  }

  return saved
}

/**
 * 执行生成动作；草稿有效但未保存时明确进入“保存并生成”流程。
 * @returns 生成启动完成后兑现的 Promise。
 * @throws 生成异常由生成组合式函数捕获并展示。
 */
async function handleGenerate(): Promise<void> {
  editor.showGenerationValidation()

  if (!readiness.generate.value.enabled) {
    await showReadiness('generate')
    return
  }

  // v13 发起前编排（PRD §4.2 C-2/C-4/C-5）：
  //   空态或有终态主体 → 清空旧内容后切换；
  //   执行运行中 → 先确认；生成运行中 → 拒绝（切换即中止生成）。
  const outcome = await beginSubject({
    kind: 'generation',
    skillId: skillIdRef.value,
    current: globalChatStore.subject,
    currentRunning: isSubjectRunning(),
    confirm: confirmSubjectSwitch,
  })

  if (outcome === 'rejected-running-generation') {
    pageMessage.warning(describeGenerationRejection(activeGenerationFileName()))
    return
  }
  if (outcome !== 'started') return

  activeReadiness.value = readiness.generate.value.requiresSave
    ? 'generate'
    : null
  // 就绪校验失败时 startSkillGeneration 不展开侧边栏、不创建阶段记录（v9 PRD 4.4 规则 3）。
  //
  // 清空旧内容与落地显示主体都在 `startSkillGeneration` **内部**完成
  // （在就绪守卫之后、启动之前），调用方不要在此再清一次：
  // 那会连同刚创建、正在运行的阶段实例一起销毁（v13 技术方案 §3.7）。
  await generationFlow.startSkillGeneration()
}

/**
 * 展示指定动作的就绪摘要并将键盘焦点移入摘要。
 * @param action 需要解释的保存或生成动作。
 * @returns DOM 更新和聚焦完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function showReadiness(action: 'save' | 'generate'): Promise<void> {
  activeReadiness.value = action
  await nextTick()
  readinessPanelRef.value?.focus()
}

/**
 * 打开 env.json 编辑页（v10）：就绪摘要与敏感数据空数据源提示的跳转入口。
 * @returns 导航完成后兑现的 Promise。
 * @throws 不抛出异常，导航失败由 Vue Router 处理。
 */
async function openEnvFile(): Promise<void> {
  await router.push(
    createSkillDevelopmentCodeLocation(props.skillId, SKILL_ENV_FILE_NAME),
  )
}

/**
 * 展开目标步骤并聚焦就绪摘要指定的字段；env.json 类原因跳转到代码面板。
 * @param reason 包含字段路径和 DOM 目标的动作阻塞原因。
 * @returns 展开、滚动、聚焦或导航完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function navigateToReason(reason: IE2EActionReason): Promise<void> {
  // v10：「env.json 存在格式错误/缺失」类原因路由到 code 面板的 env.json。
  if (reason.path === SKILL_ENV_FILE_NAME) {
    await openEnvFile()
    return
  }

  const stepMatch = /^steps\.(\d+)/.exec(reason.path ?? '')
  if (stepMatch) {
    await stepTableRef.value?.revealStep(Number(stepMatch[1]))
  }

  await nextTick()
  const target = reason.targetId
    ? document.getElementById(reason.targetId)
    : null
  target?.scrollIntoView({ block: 'center', behavior: 'auto' })
  target?.focus()
}

// 页头状态标签：原编辑器工具栏标签上移后的响应式数据源
const toolbarTags = computed<IHeaderStatusTag[]>(() => {
  const tags: IHeaderStatusTag[] = [
    editor.dirty.value
      ? { key: 'dirty', label: '未保存', type: 'warning' }
      : { key: 'saved', label: '已保存', type: 'success' },
  ]
  const scriptStatus = editor.script.value?.status
  if (scriptStatus === 'stale') {
    tags.push({ key: 'script-stale', label: '脚本可能已过期', type: 'warning' })
  } else if (scriptStatus === 'current') {
    tags.push({ key: 'script-current', label: '脚本最新', type: 'success' })
  } else if (scriptStatus === 'untracked') {
    tags.push({ key: 'script-untracked', label: '存在手工脚本', type: 'info' })
  } else {
    tags.push({ key: 'script-none', label: '脚本未生成', type: 'default' })
  }
  if (scriptTime.value) {
    tags.push({
      key: 'script-time',
      label: `修改于 ${scriptTime.value.label}`,
      type: 'default',
      title: scriptTime.value.title,
    })
  }
  return tags
})
// 页头操作按钮：保存用例和生成 SKILL.md。
const toolbarActions = computed<IHeaderActionItem[]>(() => {
  const actions: IHeaderActionItem[] = [
    {
      key: 'save',
      label: readiness.save.value.label,
      primary: false,
      secondary: false,
      loading: editor.status.value === 'saving',
      enabled: readiness.save.value.enabled,
      run: () => void handleSave(),
    },
    {
      key: 'generate',
      label: readiness.generate.value.label,
      primary: true,
      secondary: false,
      loading: generationFlow.isRunning,
      enabled: readiness.generate.value.enabled,
      run: () => void handleGenerate(),
    },
  ]

  return actions
})

watch(editor.dirty, (dirty) => emit('dirtyChange', dirty), { immediate: true })
// 用例保存后同步来源哈希：产物实时保存需要它，陈旧哈希会被服务端拒绝。
watch(editor.sourceHash, (hash) => {
  if (hash) generationFlow.setSourceHash(hash)
})
onMounted(() => void editor.load())
// v13：**不再**在卸载时释放生成流程。
//
// v9 在此调用 `generationFlow.close()`，会销毁阶段实例（中止时间线订阅）
// 并清空卡片——但工作台已上移为应用级（PRD G-1），用户离开本编辑器后
// 仍需继续看到进度、继续编辑产物卡片。内容与实例的生命周期改由
// 工作台的「清空」统一管理（PRD B-6/R-7）。
defineExpose({
  toolbarSubtitle: 'e2e_schema.json',
  toolbarTags,
  toolbarActions,
  save: handleSave,
  discard: editor.discard,
  reload: editor.load,
  markSourceMissing: editor.markSourceMissing,
  getSavedFileContext: () =>
    editor.version.value
      ? { relativePath: 'e2e_schema.json', version: editor.version.value }
      : undefined,
})
</script>

<template>
  <section class="e2e-editor" aria-label="结构化 E2E 用例编辑器">
    <div v-if="editor.status.value === 'loading'" class="center-state">
      <n-spin size="large" />
    </div>
    <div v-else-if="editor.status.value === 'invalid'" class="center-state">
      <n-alert type="error" title="无法打开结构化 E2E 用例">{{
        editor.errorMessage.value
      }}</n-alert>
      <n-button @click="emit('openRaw')">使用原始 JSON 编辑器打开</n-button>
    </div>
    <div
      v-else-if="editor.status.value === 'error' && !editor.draft.value"
      class="center-state"
    >
      <n-alert type="error" title="E2E 用例加载失败">{{
        editor.errorMessage.value
      }}</n-alert>
      <n-button @click="editor.load">重试</n-button>
    </div>
    <template v-else-if="editor.draft.value">
      <n-alert
        v-if="editor.status.value === 'missing'"
        type="error"
        title="源文件已删除"
      >
        {{ editor.errorMessage.value }} 请复制草稿内容或在文件恢复后重新加载。
      </n-alert>
      <n-alert
        v-if="editor.status.value === 'error'"
        type="error"
        title="用例保存失败"
      >
        <p>{{ editor.errorMessage.value }} 当前草稿仍保留在页面中。</p>
        <n-button size="small" @click="editor.resumeEditing"
          >继续编辑并重试</n-button
        >
      </n-alert>
      <n-alert
        v-if="props.showOnboardingHint"
        type="info"
        title="先完成一份可生成的结构化用例"
      >
        填写标题、描述、目标
        URL，并添加至少一个启用步骤。敏感数据请通过测试数据中的
        <strong>「添加敏感数据」</strong>
        引用 env.json；生成前会先保存最新用例，当前不会运行测试。
      </n-alert>
      <n-alert v-if="!chatReady" type="warning"
        >模型配置无效，保存仍可使用；生成 Skill
        文档按钮会说明需要检查的配置。</n-alert
      >
      <n-alert v-if="readOnly" type="warning"
        >当前 Skill 只读，无法保存或生成 SKILL.md。</n-alert
      >
      <E2ETestCaseReadinessPanel
        v-if="showReadinessPanel && activeAction"
        ref="readinessPanel"
        :action-label="activeAction.label"
        :reasons="activeAction.reasons"
        :requires-save="
          activeReadiness === 'generate' &&
          readiness.generate.value.requiresSave &&
          activeAction.reasons.length === 0
        "
        @navigate="navigateToReason"
      />
      <div class="editor-scroll" role="region" aria-label="结构化用例字段">
        <section class="editor-card" aria-labelledby="basic-information-title">
          <h2 id="basic-information-title">基础信息</h2>
          <E2ETestCaseBasicForm
            :model-value="editor.draft.value"
            :errors="editor.fieldErrors.value"
            @update:model-value="updateDraft"
          />
        </section>
        <section class="editor-card">
          <PreconditionEditor
            :model-value="editor.draft.value.preconditions"
            :errors="editor.fieldErrors.value"
            :env-file-state="props.envFileState"
            :read-only-skill="props.readOnly"
            @open-env-file="openEnvFile"
            @update:model-value="updatePreconditions"
          />
        </section>
        <section class="editor-card">
          <TestStepTable
            ref="stepTable"
            :model-value="editor.draft.value.steps"
            :errors="editor.fieldErrors.value"
            :env-file-state="props.envFileState"
            :read-only-skill="props.readOnly"
            @open-env-file="openEnvFile"
            @update:model-value="updateSteps"
          />
        </section>
      </div>
      <ConflictDialog
        :draft="editor.draft.value"
        :disk-document="editor.conflictDocument.value"
        @reload="editor.useDiskVersion"
        @close="closeConflict"
      />
    </template>
  </section>
</template>

<style scoped>
.e2e-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--color-canvas);
}

.center-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-lg);
  padding: var(--space-page);
}

.editor-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--space-card);
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.editor-card {
  padding: var(--space-card);
  border: 1px solid #dbe3ee;
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  box-shadow: 0 3px 10px rgb(15 23 42 / 4%);
}

.editor-card h2 {
  margin: 0 0 var(--space-lg);
  color: var(--color-ink-deep);
  font-size: 18px;
}

@media (max-width: 720px) {
  .editor-scroll {
    padding: 10px;
  }

  .editor-card {
    padding: var(--space-md);
  }
}
</style>

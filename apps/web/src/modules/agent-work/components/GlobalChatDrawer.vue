<!--
  Agent 工作台抽屉（v13）：应用级单槽控制台。

  v9 建立时的形态（宽度 61.8%、遮罩防误触、主副标题、收起 vs 关闭）大部分保留，
  v13 的三处关键变化：

    1. **全局唯一实例**：从 Skill 开发页上移到应用外壳（App.vue），
       因此「当前是哪个 Skill」不能再从路由派生（PRD G-1/G-4、E-3）。
    2. **显示主体驱动内容**：内容区渲染谁由 `globalChat.subject` 决定，
       取代 v9 的「执行运行中优先 → 否则生成数据 → 否则已结束执行」三条启发式
       （它们都依赖「当前 Skill」，全局化后失效）。
    3. **清空与收起解耦**：卡片上的「关闭」按钮移除，改为底部「清空」
       （只清内容、不收起）；「收起」由遮罩点击 / 收起图标 / Esc 承担
       （PRD B-1/B-4、M-1）。

  执行工作项与生成工作项的进度分别来自 `execution` 与 `generation-flow` store；
  本组件只负责「渲染谁」与「发出清空动作」，不持有任何进度数据。

  v11 的执行结束通知（含「查看报告」）**已迁至应用外壳**——挂在抽屉上的话，
  抽屉收起时该 watch 不存在，通知会被静默丢弃，恰好违反需求「收起时也要提示」。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NDrawer, NDrawerContent, NTooltip } from 'naive-ui'
import { useGenerationFlowStore } from '../../../stores/generation-flow'
import { useExecutionStore } from '../../../stores/execution'
import { useGlobalChatStore } from '../../../stores/global-chat'
import {
  createSkillDevelopmentCodeLocation,
  createSkillDevelopmentReportLocation,
} from '../../../router/skill-development-navigation'

/** 测试脚本的文件名（跳转到代码编辑器时作为 `path` 查询参数）。 */
const SCRIPT_FILE_NAME = 'test.spec.ts'
import GenerationSidebarContent from './GenerationSidebarContent.vue'
import ExecutionBlock from '../../test-execution/components/ExecutionBlock.vue'

const router = useRouter()
const globalChat = useGlobalChatStore()
const generationFlow = useGenerationFlowStore()
const executionStore = useExecutionStore()

/** 当前显示主体（PRD C-1：同一时刻只有一个）。 */
const subject = computed(() => globalChat.subject)

/**
 * 显示主体是否仍在运行（触发器呼吸点与「清空」可用条件的依据，PRD M-4/B-5）。
 *
 * 按主体种类分别取各自的运行态——两处若用不同口径（如生成看 `isRunning`、
 * 执行看记录状态），呼吸点与实际状态迟早分叉。
 */
const subjectRunning = computed(() => {
  const current = subject.value
  if (!current) return false
  if (current.kind === 'generation') return generationFlow.isRunning
  return executionStore.isRunning(current.skillId)
})

/** 抽屉副标题：生成侧沿用流程文案；执行侧由区块自身表达状态。 */
const subtitle = computed(() =>
  subject.value?.kind === 'generation' ? generationFlow.subtitle : '',
)

/** 是否渲染底部操作区（PRD B-3：空态不渲染）。 */
const showActionBar = computed(() => globalChat.hasSubject)

/** 「清空」是否可用（PRD B-5：有内容且无运行中任务）。 */
const canClear = computed(() => globalChat.hasSubject && !subjectRunning.value)

/** 抽屉宽度：61.8% 黄金分割；窄屏降级为全宽（PRD §5.1，沿用 v9）。 */
const NARROW_QUERY = '(max-width: 760px)'
const isNarrow = ref(false)
let mediaQuery: MediaQueryList | null = null

/**
 * 同步窄屏断点状态。
 * @param event 媒体查询变化事件。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function syncNarrow(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches
}

onMounted(() => {
  mediaQuery = window.matchMedia(NARROW_QUERY)
  syncNarrow(mediaQuery)
  mediaQuery.addEventListener('change', syncNarrow)
})

onBeforeUnmount(() => {
  mediaQuery?.removeEventListener('change', syncNarrow)
})

const sidebarWidth = computed(() => (isNarrow.value ? '100%' : '61.8%'))

/**
 * 抽屉显隐回调。
 *
 * v13 起**关闭即收起**（PRD B-4 把销毁职责移交底部「清空」）：
 * 遮罩点击、关闭图标、Esc 都只隐藏界面，保留内容与运行中的任务。
 *
 * @param visible 抽屉目标显隐状态。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleUpdateShow(visible: boolean): void {
  if (visible) globalChat.expand()
  else globalChat.collapse()
}

/**
 * 打开测试报告（PRD E-4）。
 *
 * 跳转目标恒为**显示主体记录的来源 Skill**，与用户当前所在页面无关——
 * 这正是 v9 从路由取 skillId 的写法在全局化后必须改掉的原因。
 *
 * @param reportRelativePath 报告在该 Skill 内的相对路径。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openReport(reportRelativePath: string): void {
  const current = subject.value
  if (!current) return

  const runId = reportRelativePath.split('/')[1]
  if (!runId) return

  // 先收起让出视野（仅隐藏，不销毁内容）。
  globalChat.collapse()
  void router.push(createSkillDevelopmentReportLocation(current.skillId, runId))
}

/**
 * 打开测试脚本（v13 需求方补充）。
 *
 * 跳转到**工作项来源 Skill** 的开发页并打开 `test.spec.ts`——与报告跳转同口径
 * （E-4）：目标由显示主体携带，与用户当前所在页面无关。
 *
 * 为什么要收起抽屉：目标页面的代码编辑器在主内容区，遮罩会挡住它。
 *
 * @returns 无返回值。
 * @throws 不抛出异常；导航失败由 Vue Router 处理。
 */
function openScript(): void {
  const current = subject.value
  if (!current) return

  globalChat.collapse()
  void router.push(
    createSkillDevelopmentCodeLocation(current.skillId, SCRIPT_FILE_NAME),
  )
}

/**
 * 清空工作台内容（PRD B-6 / B-8）。
 *
 * 收尾顺序不能颠倒：先静默 flush 待发改动（用户无感），再处理「保存失败」
 * 的二次确认（v9 唯一保留的确认例外），最后才销毁内容。
 *
 * 清空**只销毁内容、不收起抽屉**——这是与 v9「关闭」的关键差别。
 *
 * @returns 清空流程完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function handleClear(): Promise<void> {
  if (!canClear.value) return

  if (generationFlow.hasUnsavedFailure) {
    const confirmed = window.confirm(
      '有未保存的改动，清空后将丢失。仍要清空吗？',
    )
    if (!confirmed) return
  }

  await generationFlow.flushAll()

  // 生成侧销毁内容；执行侧只丢弃主体引用——执行记录与 `/agent` 的卡片共享，
  // 删掉会让那一边的卡片失去数据（技术方案 F19 / R-5）。
  if (subject.value?.kind === 'generation') generationFlow.reset()
  globalChat.dropSubject()
}
</script>

<template>
  <!-- 收起状态下的右缘触发器：运行中的任务展示绿色呼吸点提示（PRD M-4） -->
  <button
    v-if="!globalChat.visible"
    type="button"
    class="global-chat-trigger"
    aria-label="展开 Agent 工作台"
    @click="globalChat.expand()"
  >
    <span
      class="trigger-dot"
      :class="{ running: subjectRunning }"
      aria-hidden="true"
    />
    Agent 工作
  </button>

  <n-drawer
    :show="globalChat.visible"
    :show-mask="true"
    :mask-closable="true"
    :auto-focus="false"
    display-directive="show"
    placement="right"
    :width="sidebarWidth"
    class="global-chat-drawer"
    aria-label="Agent 工作台"
    @update:show="handleUpdateShow"
  >
    <n-drawer-content
      title="Agent 工作"
      closable
      body-content-style="padding: 0; display: flex; flex-direction: column;"
    >
      <template #header>
        <!-- 主标题 + 副标题：主标题 16px/600，副标题 12px/400（PRD §5.1） -->
        <div class="drawer-heading">
          <span class="drawer-title">Agent 工作</span>
          <!-- 副标题随状态切换时播报：稳定、可理解的阶段信息 -->
          <span
            v-if="subtitle"
            class="drawer-subtitle"
            role="status"
            aria-live="polite"
          >
            {{ subtitle }}
          </span>
        </div>
      </template>

      <!-- 内容区：由显示主体分派（PRD C-1） -->
      <div class="drawer-body">
        <template v-if="subject">
          <execution-block
            v-if="subject.kind === 'execution'"
            class="drawer-content"
            :key="subject.executionId ?? subject.skillId"
            :skill-id="subject.skillId"
            :execution-id="subject.executionId"
            :on-open-report="openReport"
          />
          <generation-sidebar-content
            v-else
            class="drawer-content"
            @open-script="openScript"
          />
        </template>

        <!-- 空态：文案同时指向生成与执行两个入口（PRD §5.2） -->
        <div v-else class="workbench-empty">
          <p class="empty-title">暂无正在进行的任务</p>
          <p class="empty-hint">
            点击页头「生成 Skill 文档」，或在文件树点击「执行测试用例」，
            这里将实时展示 Agent 的工作进度。
          </p>
        </div>
      </div>

      <!-- 底部操作区：仅「清空」（PRD B-1/B-2/B-3） -->
      <footer v-if="showActionBar" class="drawer-actions">
        <n-tooltip :disabled="canClear" trigger="hover">
          <template #trigger>
            <n-button
              size="small"
              secondary
              :disabled="!canClear"
              :aria-disabled="canClear ? undefined : 'true'"
              aria-label="清空 Agent 工作内容"
              @click="handleClear"
            >
              清空
            </n-button>
          </template>
          任务运行中，结束后可清空
        </n-tooltip>
      </footer>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.drawer-heading {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  min-width: 0;
}

.drawer-title {
  color: var(--color-ink-deep);
  font-size: 16px;
  font-weight: 600;
}

.drawer-subtitle {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 窄屏下主副标题上下折行（v9 §11.1） */
@media (max-width: 760px) {
  .drawer-heading {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
}

/* 内容区与底部操作区同处 flex 列：内容滚动，操作区固定 */
.drawer-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.drawer-content {
  flex: 1;
  min-height: 0;
}

.workbench-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-page);
  text-align: center;
}

.empty-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 14px;
  font-weight: 600;
}

.empty-hint {
  max-width: 360px;
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 13px;
  line-height: 1.6;
}

.drawer-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: var(--space-sm) var(--space-card) 20px;
  border-top: 1px solid var(--color-border);
}

.global-chat-trigger {
  position: fixed;
  top: 50%;
  right: 0;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border: 1px solid var(--color-border);
  border-right: none;
  border-radius: var(--radius-control) 0 0 var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink-body);
  font-size: 12px;
  line-height: 1;
  writing-mode: vertical-rl;
  box-shadow: 0 2px 8px rgb(15 23 42 / 8%);
  cursor: pointer;
  transform: translateY(-50%);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out);
}

.global-chat-trigger:hover {
  border-color: var(--color-review);
  background: var(--color-well);
}

.global-chat-trigger:focus-visible {
  outline: none;
  border-color: var(--color-review);
  box-shadow: var(--focus-ring);
}

.trigger-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border);
}

/* 任务运行中：绿色呼吸点提示用户工作台内有进行中的工作 */
.trigger-dot.running {
  background: #18a058;
  animation: trigger-pulse 1.2s ease-in-out infinite;
}

@keyframes trigger-pulse {
  50% {
    opacity: 0.35;
  }
}
</style>

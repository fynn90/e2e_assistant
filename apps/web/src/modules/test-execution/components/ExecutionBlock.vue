<!--
  执行区块（v11，PRD X7/X8）：侧边栏中承载一次执行任务的独立区块。
  内容分区：① 状态条（状态 + 已耗时）② 就绪摘要（422 问题 + 跳转）
  ③ 日志流（流式增量、自动滚底、上滚暂停）④ 步骤进度（stepId → 用例步骤描述映射）
  ⑤ 结束后的测试报告总结卡片。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NEmpty, NSpin, NTag } from 'naive-ui'
import type { IE2ETestCase } from '@fynn90-e2e_assistant/types'
import { fetchE2ETestCase } from '../../e2e-test-case/services/e2e-test-case-api'
import {
  createSkillDevelopmentCodeLocation,
  createSkillDevelopmentE2ETestCaseLocation,
} from '../../../router/skill-development-navigation'
import { useExecutionStore } from '../../../stores/execution'
import { useNowTicker } from '../../../common/time/useNowTicker'
import ReportSummaryCard from './ReportSummaryCard.vue'

const props = defineProps<{
  /** 当前 Skill ID（区块只展示该 Skill 的执行）。 */
  skillId: string
  /**
   * 期望展示的执行 ID（v13）。
   *
   * 执行记录按 Skill 存放，同一 Skill 的新执行会**覆盖**旧记录。
   * 不校验它的话，历史卡片会显示成另一次执行的内容（技术方案 F10）。
   * v16 的 `WorkbenchExecutionBody` 已有同款守卫，两处口径必须一致。
   *
   * 缺省时不校验（保留 v11 在 Skill 开发页内「只看该 Skill 最近一次」的行为）。
   */
  executionId?: string
  /** 「查看详细报告」回调（由调用方注入：负责路由 + 文件树选中联动）。 */
  onOpenReport: (reportRelativePath: string) => void
}>()

const router = useRouter()
const executionStore = useExecutionStore()

/**
 * 记录是否属于本次要展示的执行。
 *
 * 未传 `executionId`（v11 的页面内用法）时一律视为匹配；传了则必须相等，
 * 否则说明该记录已被同一 Skill 的另一次执行覆盖。
 */
const matchesExpectedExecution = computed(() => {
  if (!props.executionId) return true
  return (
    executionStore.records[props.skillId]?.executionId === props.executionId
  )
})

const record = computed(() =>
  matchesExpectedExecution.value
    ? executionStore.records[props.skillId]
    : undefined,
)
const running = computed(
  () =>
    matchesExpectedExecution.value && executionStore.isRunning(props.skillId),
)

/** 当前执行的目标 Skill 标题（服务端随发起响应/快照下发；旧记录回退为 ID）。 */
const skillTitle = computed(() => {
  const title = record.value?.skillTitle
  return title || (record.value ? `Skill ${props.skillId}` : '')
})

// —— ① 状态条：运行中每秒推进的已耗时（useNowTicker 只在运行时持有定时器） ——
const ticker = useNowTicker({ enabled: running })

const statusText = computed(() => {
  switch (record.value?.status) {
    case 'prechecking':
      return '就绪校验中…'
    case 'running':
      return '执行中'
    case 'completed':
      return '已结束'
    case 'failed':
      return '启动失败'
    case 'interrupted':
      return '已中断'
    default:
      return ''
  }
})

const statusTagType = computed(() => {
  switch (record.value?.status) {
    case 'completed':
      return 'success' as const
    case 'failed':
      return 'error' as const
    case 'interrupted':
      return 'warning' as const
    default:
      return 'info' as const
  }
})

/** 已耗时（运行中用 ticker 实时推进；结束后用 summary 的时长）。 */
const elapsedText = computed(() => {
  const current = record.value
  if (!current) return ''

  if (current.summary) {
    return formatDuration(current.summary.durationMs)
  }

  return formatDuration(Math.max(0, ticker.now.value - current.startedAtMs))
})

/** 把毫秒时长格式化为可读文本。 */
function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}

// —— ③ 日志流：自动滚底，用户上滚查看历史时暂停（PRD X9） ——
const logContainer = ref<HTMLElement | null>(null)
const autoScrollEnabled = ref(true)

watch(
  () => record.value?.logs.length,
  async () => {
    if (!autoScrollEnabled.value) return
    await nextTick()
    const container = logContainer.value
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  },
)

/**
 * 用户滚动时同步自动滚底开关：贴近底部视为「回到实时」。
 * @param event 滚动事件。
 * @returns 无返回值。
 */
function handleLogScroll(event: Event): void {
  const container = event.target as HTMLElement
  const distanceFromBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight
  autoScrollEnabled.value = distanceFromBottom < 40
}

// —— ④ 步骤进度：stepId → 用例步骤描述映射（PRD X8；未命中显示 stepId 原名） ——
const stepTitles = ref<Record<string, string>>({})
let stepTitleAbortController: AbortController | null = null

watch(
  () => props.skillId,
  async () => {
    stepTitleAbortController?.abort()
    const controller = new AbortController()
    stepTitleAbortController = controller
    try {
      const response = await fetchE2ETestCase(props.skillId, controller.signal)
      if (controller.signal.aborted) return
      const testCase: IE2ETestCase = response.data.testCase
      stepTitles.value = Object.fromEntries(
        testCase.steps.map((step) => [step.id, step.description]),
      )
    } catch {
      // 用例读取失败不阻断区块：步骤退化为显示 stepId 原名。
      if (!controller.signal.aborted) stepTitles.value = {}
    }
  },
  { immediate: true },
)

/** 步骤展示名：优先用例描述，未映射时显示 stepId 原名（用户手改的 step id）。 */
function stepDisplayName(stepId: string): string {
  return stepTitles.value[stepId] ?? stepId
}

// —— 就绪摘要的跳转（对齐 v10 生成前就绪摘要的交互） ——
/**
 * 跳转到 env.json 编辑页。
 * @returns 无返回值。
 */
function jumpToEnvFile(): void {
  void router.push(
    createSkillDevelopmentCodeLocation(props.skillId, 'env.json'),
  )
}

/**
 * 跳转到用例编辑页。
 * @returns 无返回值。
 */
function jumpToTestCase(): void {
  void router.push(createSkillDevelopmentE2ETestCaseLocation(props.skillId))
}

/**
 * 打开详细报告：把报告相对路径交给页面注入的回调（路由 + 文件树选中联动）。
 * @returns 无返回值。
 */
function openReport(): void {
  const reportRelativePath = record.value?.summary?.reportRelativePath
  if (reportRelativePath) {
    props.onOpenReport(reportRelativePath)
  }
}

onBeforeUnmount(() => {
  stepTitleAbortController?.abort()
  ticker.dispose()
})
</script>

<template>
  <section class="execution-block" aria-label="测试执行">
    <!-- ⓪ 区块头：告知用户当前正在执行哪个 Skill -->
    <header v-if="skillTitle" class="block-head">
      <span class="head-label">正在执行测试的 Skill</span>
      <span class="skill-name">{{ skillTitle }}</span>
    </header>

    <!-- ① 状态条 -->
    <header class="block-status">
      <div class="status-left">
        <n-tag :type="statusTagType" size="small" round>
          {{ statusText }}
        </n-tag>
        <span v-if="elapsedText" class="elapsed">已耗时 {{ elapsedText }}</span>
        <n-spin v-if="running" :size="12" />
      </div>
      <n-button
        v-if="running"
        size="tiny"
        type="warning"
        secondary
        @click="executionStore.stop(props.skillId)"
      >
        停止执行
      </n-button>
    </header>

    <!-- 执行过程清单：阶段推进一目了然 -->
    <div v-if="record?.stages.length" class="stage-process">
      <p class="section-title">执行过程</p>
      <ul class="stage-list">
        <li v-for="item in record.stages" :key="item.stage">
          <span
            class="stage-mark"
            :class="{ ok: item.status === 'done', bad: item.status === 'fail' }"
          >
            {{
              item.status === 'done' ? '✓' : item.status === 'fail' ? '✗' : '…'
            }}
          </span>
          <span class="stage-label">{{ item.label }}</span>
        </li>
      </ul>
    </div>

    <!-- ② 就绪摘要（422 问题 + 跳转，PRD 5.2） -->
    <n-alert
      v-if="record?.issues.length"
      type="warning"
      title="就绪校验未通过"
      class="issue-alert"
    >
      <ul class="issue-list">
        <li
          v-for="(issue, index) in record.issues"
          :key="`${issue.code}-${index}`"
        >
          <span>{{ issue.message }}</span>
          <n-button
            v-if="issue.target === 'env-file'"
            size="tiny"
            quaternary
            type="primary"
            @click="jumpToEnvFile"
          >
            前往 env.json
          </n-button>
          <n-button
            v-else-if="issue.target === 'test-case'"
            size="tiny"
            quaternary
            type="primary"
            @click="jumpToTestCase"
          >
            前往用例编辑
          </n-button>
        </li>
      </ul>
    </n-alert>

    <!-- ⑤ 测试报告总结卡片（结束后展示，PRD V1） -->
    <report-summary-card
      v-if="record?.summary"
      :summary="record.summary"
      :report-available="Boolean(record.summary.reportRelativePath)"
      @open-report="openReport"
    />

    <!-- ③ 日志流 -->
    <template v-if="record">
      <div
        ref="logContainer"
        class="log-stream"
        aria-label="执行日志"
        @scroll="handleLogScroll"
      >
        <p v-for="(line, index) in record.logs" :key="index" class="log-line">
          {{ line }}
        </p>
        <p v-if="record.logs.length === 0" class="log-placeholder">
          {{
            record.issues.length
              ? '就绪校验未通过，未开始执行。'
              : running
                ? '等待执行输出…'
                : '（无日志）'
          }}
        </p>
      </div>

      <!-- ④ 步骤进度 -->
      <div v-if="record.steps.length" class="step-progress">
        <p class="section-title">步骤进度</p>
        <ul class="step-list">
          <li v-for="step in record.steps" :key="step.stepId">
            <span
              class="step-mark"
              :class="{ ok: step.ok === true, bad: step.ok === false }"
            >
              {{ step.ok === true ? '✓' : step.ok === false ? '✗' : '…' }}
            </span>
            <span class="step-name">{{ stepDisplayName(step.stepId) }}</span>
            <span class="step-id">{{ step.stepId }}</span>
          </li>
        </ul>
      </div>

      <!-- 每条测试结果行（结束即出现，先于报告） -->
      <ul v-if="record.tests.length" class="test-list">
        <li v-for="test in record.tests" :key="test.title">
          <n-tag
            size="tiny"
            round
            :type="
              test.status === 'passed'
                ? 'success'
                : test.status === 'interrupted'
                  ? 'warning'
                  : test.status === 'skipped'
                    ? 'default'
                    : 'error'
            "
          >
            {{
              test.status === 'passed'
                ? '通过'
                : test.status === 'failed'
                  ? '失败'
                  : test.status === 'timedOut'
                    ? '超时'
                    : test.status === 'interrupted'
                      ? '中断'
                      : '跳过'
            }}
          </n-tag>
          <span class="test-title">{{ test.title }}</span>
        </li>
      </ul>
    </template>

    <!-- 记录不属于本次展示（被同 Skill 的新执行覆盖）或不存在：明确降级，不渲染他人内容 -->
    <n-alert
      v-else-if="!matchesExpectedExecution"
      type="info"
      title="该执行的过程记录已不可用"
      class="block-empty"
    >
      同一 Skill
      已发起过新的执行，本次执行的过程记录不再保留。结果请以此前的工作台通知或该
      Skill 的报告目录为准。
    </n-alert>

    <n-empty
      v-else
      size="small"
      description="暂无执行记录"
      class="block-empty"
    />
  </section>
</template>

<style scoped>
.execution-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  /* 内容与抽屉边缘的内边距（对齐生成内容区的留白节奏） */
  padding: var(--space-card);
  /* 底部固定 20px：内容不贴抽屉底缘 */
  padding-bottom: 20px;
  /* 抽屉内容区是 flex 容器：区块自身滚动（与 GenerationSidebarContent 同机制），否则内容溢出不可见 */
  min-height: 0;
  overflow-y: auto;
}

.block-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  min-width: 0;
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-border);
}

.head-label {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.skill-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-ink-deep);
}

.stage-process {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  padding: var(--space-sm) var(--space-md);
  background: var(--color-surface);
}

.stage-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.stage-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  min-width: 0;
}

.stage-mark {
  flex: 0 0 auto;
  color: var(--color-ink-muted);
}

.stage-mark.ok {
  color: #15803d;
  font-weight: 600;
}

.stage-mark.bad {
  color: #b91c1c;
  font-weight: 600;
}

.stage-label {
  min-width: 0;
  color: var(--color-ink-body);
  word-break: break-all;
}

.block-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.status-left {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.elapsed {
  font-size: 12px;
  color: var(--color-ink-muted);
  white-space: nowrap;
}

.issue-alert .issue-list {
  margin: 0;
  padding-inline-start: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.issue-alert .issue-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.log-stream {
  min-height: 120px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-sm) var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-well);
}

.log-line {
  margin: 0 0 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-ink-body);
  word-break: break-all;
  white-space: pre-wrap;
}

.log-placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.section-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink-deep);
}

.step-progress {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  padding: var(--space-sm) var(--space-md);
  background: var(--color-surface);
}

.step-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-list li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.step-mark {
  flex: 0 0 auto;
  color: var(--color-ink-muted);
}

.step-mark.ok {
  color: #15803d;
}

.step-mark.bad {
  color: #b91c1c;
  font-weight: 600;
}

.step-name {
  color: var(--color-ink-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-id {
  margin-left: auto;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-ink-muted);
}

.test-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.test-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.test-title {
  font-size: 12px;
  color: var(--color-ink-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block-empty {
  padding: var(--space-lg) 0;
}
</style>

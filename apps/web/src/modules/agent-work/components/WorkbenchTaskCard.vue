<!--
  工作台任务卡片（v16，PRD RUN-6 / GEN-3）：执行与生成共用一种卡片，按 taskKind 分派。

  分派依据是 `taskKind` 而非内容嗅探（与 v14「按字段分派」的约定一致）：
    - execution  → 内嵌执行区块（订阅执行总线，复用 v11 的 ExecutionBlock）；
    - generation → 内嵌子会话时间线（订阅工作总线，复用 useAgentWorkTimeline）。

  本卡片只承载**过程**（日志流、步骤进度、停止按钮）与失败原因。执行**结果**
  （统计、运行时间、目标 URL、报告入口）由对话流里**平级的报告卡片**承载
  （`WorkbenchReportCard`，RPT-2/RPT-3）——一张卡片一个结果区，避免在执行卡片
  内部再套一张表。

  过程细节由内嵌组件各自的流负责，父会话的块数不随日志增长（技术方案 R6）。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NSpin, NTag } from 'naive-ui'
import type { IWorkbenchTaskTimelineItem } from '../timeline'
import { useNowTicker } from '../../../common/time/useNowTicker'
import WorkbenchGenerationBody from './WorkbenchGenerationBody.vue'
import WorkbenchExecutionBody from './WorkbenchExecutionBody.vue'
import WorkbenchBatchCard from './WorkbenchBatchCard.vue'

const props = defineProps<{
  /** 任务卡片项。 */
  item: IWorkbenchTaskTimelineItem
}>()

const emit = defineEmits<{
  /** 批次：确认开始（v17 R4a）。 */
  batchConfirm: [item: IWorkbenchTaskTimelineItem]
  /** 批次：取消（待确认态，不产生执行记录）。 */
  batchCancel: [item: IWorkbenchTaskTimelineItem]
  /** 批次：停止（终止整批，剩余标记未执行）。 */
  batchStop: [item: IWorkbenchTaskTimelineItem]
  /** 批次：打开某条执行的报告。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
}>()

/** 是否运行中（决定计时器与转圈）。 */
const running = computed(() => props.item.taskStatus === 'running')

// 计时器只在运行时持有定时器（与执行区块同一取舍：空闲时不空转）。
const ticker = useNowTicker({ enabled: running })

/** 卡片标题前缀：执行 / 生成 / 连续执行。 */
const kindLabel = computed(() => {
  switch (props.item.taskKind) {
    case 'execution':
      return '执行'
    case 'generation':
      return '生成'
    case 'batch':
      return '连续执行'
  }
})

/** 状态文案。 */
const statusText = computed(() => {
  switch (props.item.taskStatus) {
    case 'running':
      return props.item.taskKind === 'generation' ? '生成中' : '执行中'
    case 'completed':
      return '已结束'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '已中断'
  }
})

/** 状态徽标配色。 */
const statusTagType = computed(() => {
  switch (props.item.taskStatus) {
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

/** 卡片标题：执行 / 生成 / 连续执行 + 目标用例名。 */
const title = computed(() => `${kindLabel.value}：${props.item.skillTitle}`)

/** 已耗时（运行中实时推进；结束后用摘要时长）。 */
const elapsedText = computed(() => {
  const durationMs = props.item.summary?.durationMs
  if (typeof durationMs === 'number') {
    return formatDuration(durationMs)
  }
  if (!running.value) return ''
  return formatDuration(Math.max(0, ticker.now.value - props.item.startedAt))
})

/** 生成产物的诊断计数（v15 的「N 项提示」徽标）。 */
const diagnosticsCount = computed(() =>
  props.item.taskKind === 'generation'
    ? (props.item.summary?.diagnostics ?? 0)
    : 0,
)

/** 运行中的执行任务对应的执行 ID（内嵌区块的取数键）。 */
const executionId = computed(() =>
  props.item.taskKind === 'execution'
    ? (props.item.executionId ?? props.item.taskId)
    : '',
)

/**
 * 把毫秒时长格式化为可读文本（与执行区块同一口径）。
 * @param durationMs 毫秒时长。
 * @returns 形如「850ms / 12.3s / 2m 05s」的文本。
 * @throws 不抛出异常。
 */
function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}
</script>

<template>
  <section class="workbench-task" aria-label="任务卡片">
    <header class="task-head">
      <div class="head-left">
        <span class="task-title">{{ title }}</span>
        <n-tag :type="statusTagType" size="small" round>{{ statusText }}</n-tag>
        <n-spin v-if="running" :size="12" />
        <span v-if="elapsedText" class="elapsed">已耗时 {{ elapsedText }}</span>
      </div>
      <div class="head-right">
        <!-- L2d：目标用例已被删除时如实标注（入口由内嵌组件按需禁用） -->
        <n-tag
          v-if="item.skillMissing"
          size="small"
          type="warning"
          :bordered="false"
        >
          用例已删除
        </n-tag>
        <n-tag
          v-if="diagnosticsCount > 0"
          size="small"
          type="warning"
          :bordered="false"
        >
          {{ diagnosticsCount }} 项提示
        </n-tag>
      </div>
    </header>

    <!-- 过程区：执行内嵌执行区块，生成内嵌子会话时间线，连续执行内嵌批次卡。
         分派顺序注意：batch 分支必须排在 v-else 之前——否则未知 taskKind
         会被兜底成「生成」并去订阅一个不存在的子会话。 -->
    <div class="task-body">
      <WorkbenchExecutionBody
        v-if="item.taskKind === 'execution'"
        :skill-id="item.skillId"
        :execution-id="executionId"
        :finished="!running"
      />
      <WorkbenchBatchCard
        v-else-if="item.taskKind === 'batch'"
        :item="item"
        @confirm="(value) => emit('batchConfirm', value)"
        @cancel="(value) => emit('batchCancel', value)"
        @stop="(value) => emit('batchStop', value)"
        @open-report="(value) => emit('openReport', value)"
      />
      <WorkbenchGenerationBody
        v-else
        :session-id="item.taskId"
        :finished="!running"
      />
    </div>

    <!-- 终态：只留失败原因。结果的统计与报告入口由**平级的报告卡片**承载
         （RPT-2/RPT-3），卡片内不再画一张表——一张卡片一个结果区。 -->
    <footer v-if="!running && item.errorMessage" class="task-foot">
      <p class="error">{{ item.errorMessage }}</p>
    </footer>
  </section>
</template>

<style scoped>
.workbench-task {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  overflow: hidden;
}

.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  flex: none;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-well);
}

.head-left,
.head-right {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.task-title {
  color: var(--color-ink-deep);
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.elapsed {
  color: var(--color-ink-muted);
  font-size: 12px;
  white-space: nowrap;
}

.task-body {
  min-height: 0;
  padding: 12px 16px;
}

.task-foot {
  flex: none;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--color-border);
}

.error {
  margin: 4px 0 0;
  color: #b91c1c;
  font-size: 12.5px;
  line-height: 1.6;
}
</style>

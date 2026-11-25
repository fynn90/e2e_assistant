<!--
  连续执行卡（v17，PRD R4a–R4f）：三态分派（待确认 / 执行中 / 已完成）。

  三处**必须提前写明**的产品要求：

    1. **停止语义**（R4e）：停止 = 终止整个批次、剩余条目标记为「未执行」。
       确认前就要写清楚，不能让用户以为只跳过当前这一个；
    2. **未就绪的条目不执行但也不阻断**（R4c）：逐条标注就绪状态与原因；
    3. **批次不产生新的任务种类**（R4h）：每个条目仍是标准单次执行，报告写进
       该用例自己的目录，因此汇总里给的是逐条的报告入口，不是批次报告。

  当前条目的执行过程复用 `WorkbenchExecutionBody`（v16 的执行区块），
  与单次执行卡片是同一个组件——过程呈现不分叉。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { IBatchItem, TBatchItemStatus } from '@charlie_deng/e2e-assistant-types'
import type { IWorkbenchTaskTimelineItem } from '../timeline'
import WorkbenchExecutionBody from './WorkbenchExecutionBody.vue'
import {
  formatDuration,
  formatRunCounts,
  runOutcomeKind,
} from './workbench-format'

const props = defineProps<{
  /** 连续执行的任务卡片项（batch 分支）。 */
  item: IWorkbenchTaskTimelineItem
  /** 停止 / 确认请求进行中。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 用户确认开始批次（R4a）。 */
  confirm: [item: IWorkbenchTaskTimelineItem]
  /** 用户取消待确认的批次（不产生执行记录）。 */
  cancel: [item: IWorkbenchTaskTimelineItem]
  /** 用户停止批次（终止整批，剩余标记未执行）。 */
  stop: [item: IWorkbenchTaskTimelineItem]
  /** 用户请求打开某条执行的报告。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
}>()

const items = computed<IBatchItem[]>(() => props.item.items ?? [])

/** 目标用例是否已被删除（v17 L2d）：终态的报告入口同样要禁用。 */
const skillMissing = computed(() => props.item.skillMissing === true)

/** 批次状态（缺省按「执行中」处理：v16 的物化块没有该字段时不该当作已结束）。 */
const status = computed(() => props.item.batchStatus ?? 'running')

/** 待确认态（R4a）。 */
const awaiting = computed(() => status.value === 'awaiting-confirmation')

/** 执行中态（R4d）。 */
const running = computed(() => status.value === 'running')

/** 终态（completed / interrupted / cancelled）。 */
const settled = computed(() => !running.value && !awaiting.value)

/** 当前条目（执行中态：显示名称与内嵌过程）。 */
const currentItem = computed(() => {
  if (!running.value) return undefined
  return items.value.find((entry) => entry.status === 'running')
})

/** 已完成条目数（总体进度「第几个 / 共几个」）。 */
const finishedCount = computed(
  () =>
    items.value.filter((entry) =>
      ['passed', 'failed', 'interrupted', 'skipped'].includes(entry.status),
    ).length,
)

/**
 * 汇总计数（R4f：通过 N / 失败 M / 跳过 K / 未执行 J）。
 *
 * `interrupted` 一并计入：R4e 规定「点击停止 = 当前条目按中断处理、余下标记
 * 未执行」——被中断的那条既不是通过也不是失败，但**必须出现在总数里**，
 * 否则「通过 1 / 失败 0 / 跳过 0 / 未执行 2」会漏掉它，四数相加对不上条目数，
 * 用户会以为有条目凭空消失。为 0 时不展示（零值行是噪音，与报告卡同一口径）。
 */
const summaryCounts = computed(() => {
  const count = (target: TBatchItemStatus): number =>
    items.value.filter((entry) => entry.status === target).length
  return {
    passed: count('passed'),
    failed: count('failed'),
    interrupted: count('interrupted'),
    skipped: count('skipped'),
    notExecuted: count('not-executed'),
  }
})

/**
 * 条目状态徽标文案。
 * @param status - 条目状态。
 * @returns 中文文案。
 * @throws 不抛出异常。
 */
function itemStatusText(status: TBatchItemStatus): string {
  switch (status) {
    case 'pending':
      return '待执行'
    case 'running':
      return '执行中'
    case 'passed':
      return '通过'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '中断'
    case 'skipped':
      return '跳过'
    case 'not-executed':
      return '未执行'
  }
}

/**
 * 条目状态徽标配色。
 * @param status - 条目状态。
 * @returns naive-ui 的 tag type。
 * @throws 不抛出异常。
 */
function itemStatusType(status: TBatchItemStatus) {
  switch (status) {
    case 'passed':
      return 'success' as const
    case 'failed':
      return 'error' as const
    case 'interrupted':
      return 'warning' as const
    case 'skipped':
    case 'not-executed':
      return 'default' as const
    default:
      return 'info' as const
  }
}

/**
 * 打开某条执行的报告（仅在该条有 runId 时可用）。
 * @param entry - 批次条目。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openReport(entry: IBatchItem): void {
  if (!entry.runId) return
  emit('openReport', {
    skillId: entry.skillId,
    skillTitle: entry.skillTitle,
    runId: entry.runId,
  })
}
</script>

<template>
  <div class="batch-card">
    <!-- 待确认态（R4a）：清单 + 逐条就绪 + 明确写出停止/取消语义 -->
    <template v-if="awaiting">
      <p class="batch-hint">
        将按顺序执行 {{ items.length }} 个用例（单批上限
        {{ item.batchLimit ?? items.length }}）。
        未就绪的条目会跳过并注明原因，不阻断其余条目。
      </p>
      <ul class="batch-list">
        <li v-for="entry in items" :key="entry.skillId" class="batch-row">
          <span class="row-title">{{ entry.skillTitle }}</span>
          <span class="ready" :class="entry.readyCheck?.ok ? 'ok' : 'bad'">
            {{
              entry.readyCheck?.ok
                ? '就绪'
                : `不就绪${entry.readyCheck?.reason ? '：' + entry.readyCheck.reason : ''}`
            }}
          </span>
        </li>
      </ul>
      <p class="batch-warn">
        点击「开始执行」后开始；点击「取消」不做任何事、不产生执行记录。
      </p>
      <div class="batch-actions">
        <n-button
          size="small"
          :disabled="Boolean(busy)"
          @click="emit('cancel', item)"
        >
          取消
        </n-button>
        <n-button
          type="primary"
          size="small"
          :loading="Boolean(busy)"
          @click="emit('confirm', item)"
        >
          开始执行
        </n-button>
      </div>
    </template>

    <!-- 执行中态（R4d）：总体进度 + 当前条目 + 停止（语义提前写明） -->
    <template v-else-if="running">
      <div class="progress-line">
        <span class="progress-text">
          第 {{ Math.min(finishedCount + 1, items.length) }} /
          {{ items.length }} 个
        </span>
        <n-button
          size="tiny"
          type="warning"
          secondary
          :disabled="Boolean(busy)"
          :loading="Boolean(busy)"
          @click="emit('stop', item)"
        >
          停止
        </n-button>
      </div>
      <p class="batch-warn">
        停止会终止整个批次，剩余条目标记为未执行（不是只跳过当前这一个）。
      </p>
      <p v-if="currentItem" class="current-line">
        当前条目：{{ currentItem.skillTitle }}
      </p>

      <ul class="batch-list">
        <li v-for="entry in items" :key="entry.skillId" class="batch-row">
          <span class="row-title">{{ entry.skillTitle }}</span>
          <n-tag
            size="tiny"
            :type="itemStatusType(entry.status)"
            :bordered="false"
          >
            {{ itemStatusText(entry.status) }}
          </n-tag>
        </li>
      </ul>

      <!-- 当前条目的执行过程：复用 v16 的执行区块（过程呈现不分叉） -->
      <WorkbenchExecutionBody
        v-if="currentItem && currentItem.executionId"
        :skill-id="currentItem.skillId"
        :execution-id="currentItem.executionId"
        :finished="false"
      />
    </template>

    <!-- 终态（R4f）：汇总 + 逐条结果与报告入口 -->
    <template v-else-if="settled">
      <p class="summary-line">
        汇总：通过 {{ summaryCounts.passed }} · 失败 {{ summaryCounts.failed
        }}<template v-if="summaryCounts.interrupted > 0"
          >· 中断 {{ summaryCounts.interrupted }}</template
        >· 跳过 {{ summaryCounts.skipped }} · 未执行
        {{ summaryCounts.notExecuted }}
      </p>
      <p v-if="status === 'interrupted'" class="batch-warn">
        批次已停止，剩余条目按未执行处理。
      </p>
      <ul class="batch-list">
        <li v-for="entry in items" :key="entry.skillId" class="batch-row">
          <div class="row-main">
            <span class="row-title">{{ entry.skillTitle }}</span>
            <span v-if="entry.summary" class="row-summary">
              <span :class="runOutcomeKind(entry.summary)">
                {{ formatRunCounts(entry.summary) }}
              </span>
              <span
                v-if="entry.summary.durationMs !== undefined"
                class="row-duration"
              >
                · {{ formatDuration(entry.summary.durationMs) }}
              </span>
            </span>
            <span v-else-if="entry.skippedReason" class="row-summary muted">
              {{ entry.skippedReason }}
            </span>
          </div>
          <n-button
            v-if="entry.runId && !skillMissing"
            size="tiny"
            quaternary
            type="primary"
            @click="openReport(entry)"
          >
            查看报告
          </n-button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.batch-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.batch-hint {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.batch-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow-y: auto;
}

.batch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  min-width: 0;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.row-title {
  color: var(--color-ink-body);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-summary {
  font-size: 11.5px;
}

.row-summary.muted {
  color: var(--color-ink-muted);
}

.row-summary .passed {
  color: #15803d;
}

.row-summary .failed {
  color: #b91c1c;
  font-weight: 600;
}

.row-summary .interrupted {
  color: #b45309;
}

.row-duration {
  color: var(--color-ink-muted);
}

.ready {
  flex-shrink: 0;
  font-size: 11.5px;
}

.ready.ok {
  color: #15803d;
}

.ready.bad {
  color: #b45309;
}

.progress-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.progress-text {
  color: var(--color-ink-deep);
  font-size: 12.5px;
  font-weight: 600;
}

.current-line {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 12.5px;
}

/* 停止 / 取消语义的提前告知（R4e：确认前就要写清） */
.batch-warn {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.summary-line {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 12.5px;
  font-weight: 600;
}

.batch-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
}
</style>

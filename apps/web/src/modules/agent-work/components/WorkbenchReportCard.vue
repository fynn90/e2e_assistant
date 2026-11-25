<!--
  工作台报告卡片（v16，PRD RPT-2/RPT-3）：执行结束后出现在对话流中的**独立卡片**。

  与执行卡片（`WorkbenchTaskCard`）的分工：执行卡片记**过程**（日志流、步骤进度、
  停止按钮），本卡片记**结果**（统计、运行时间、目标 URL、报告入口）。两者是对话流
  里先后出现的两张平级卡片（靠 seq 排序），而不是「卡片里套卡片」。

  与 Skill 开发页的 `ReportSummaryCard`（v11）的分工：那一个是「执行区块」的一部分、
  按钮跳转到报告路由；本卡片服务于 `/agent` 对话流，按钮打开**弹窗**（RPT-3）。
  展示口径一致，但下钻方式不同，故各持一份。

  数据全部来自服务端物化的摘要（LOG-2）：历史回看时无需重新订阅任何流即可还原。

  只展示**结构化数据**，「失败原因」这类自然语言解读由 Agent 在对话文本里给出——
  卡片与 Agent 文本互补，不在两处重复同一句判断。

  v17（L2d）：目标用例被删除后，报告入口必须不可用并如实标注——**不得出现点了
  打不开的入口**；统计仍保留在卡片里（那是历史事实，不该随用例消失）。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { IWorkbenchReportTimelineItem } from '../timeline'

const props = defineProps<{
  /** 报告卡片项（含统计摘要与关联的执行）。 */
  item: IWorkbenchReportTimelineItem
}>()

const emit = defineEmits<{
  /** 用户请求打开报告弹窗（由页面级组件承载弹窗）。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
}>()

const summary = computed(() => props.item.summary)

/** 失败计数（含超时，与执行服务口径一致）。 */
const failedCount = computed(() => summary.value.failed ?? 0)
const passedCount = computed(() => summary.value.passed ?? 0)
const totalCount = computed(() => summary.value.total ?? 0)
const skippedCount = computed(() => summary.value.skipped ?? 0)
const interruptedCount = computed(() => summary.value.interrupted ?? 0)

/** 一句话结论（由统计直接推导，不臆测失败原因——那属于 Agent 的解读职责）。 */
const verdict = computed(() => {
  if (props.item.taskStatus === 'interrupted') return '执行已中断'
  if (props.item.taskStatus === 'failed') return '执行未能完成'
  if (failedCount.value > 0) return '存在失败用例'
  return '全部通过'
})

/** 结论文案配色。 */
const verdictTagType = computed(() => {
  if (props.item.taskStatus === 'interrupted') return 'warning' as const
  if (props.item.taskStatus === 'failed' || failedCount.value > 0)
    return 'error' as const
  return 'success' as const
})

/** 运行编号（报告目录名）。 */
const runId = computed(() => summary.value.runId ?? '')

/** 运行时间（本地时区的可读格式）。 */
const startedAtText = computed(() => {
  const startedAt = summary.value.startedAt
  if (!startedAt) return ''
  const parsed = Date.parse(startedAt)
  return Number.isNaN(parsed) ? startedAt : new Date(parsed).toLocaleString()
})

/** 总耗时的可读格式。 */
const durationText = computed(() => formatDuration(summary.value.durationMs))

/** 目标用例是否已被删除（v17 L2d：标注并禁用报告入口）。 */
const skillMissing = computed(() => props.item.skillMissing === true)

/** 报告可打开：有运行编号、且目标用例仍存在（L2d 要求报告入口不可用）。 */
const canOpenReport = computed(
  () => runId.value.length > 0 && !skillMissing.value,
)

/**
 * 请求打开报告弹窗。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openReport(): void {
  if (!canOpenReport.value) return
  emit('openReport', {
    skillId: props.item.skillId,
    skillTitle: props.item.skillTitle,
    runId: runId.value,
  })
}

/**
 * 把毫秒时长格式化为可读文本。
 * @param durationMs 毫秒时长；缺失时返回 '-'。
 * @returns 形如「850ms / 12.3s / 2m 05s」的文本。
 * @throws 不抛出异常。
 */
function formatDuration(durationMs: number | undefined): string {
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return '-'
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`
}
</script>

<template>
  <section class="report-card" aria-label="测试报告总结">
    <header class="head">
      <span class="title">执行结果结论</span>
      <n-tag size="small" :type="verdictTagType" round>{{ verdict }}</n-tag>
    </header>

    <p class="skill-line">
      用例「{{ item.skillTitle }}」本次执行已完成
      <span v-if="runId" class="run-id">（运行编号 {{ runId }}）</span>
    </p>

    <!-- L2d：用例已删除时如实标注，避免用户点了打不开的报告入口 -->
    <p v-if="skillMissing" class="missing-note">
      该用例已被删除，报告入口不可用；统计仍保留在这张卡片里。
    </p>

    <table class="stat-table">
      <thead>
        <tr>
          <th>指标</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>用例总数</td>
          <td>{{ totalCount }} 条</td>
        </tr>
        <tr>
          <td>通过</td>
          <td class="pass">{{ passedCount }} 条</td>
        </tr>
        <tr>
          <td>失败</td>
          <td :class="failedCount > 0 ? 'fail' : ''">{{ failedCount }} 条</td>
        </tr>
        <!-- 跳过与中断仅在非零时展示：零值行是噪音，会稀释真正要看的两行 -->
        <tr v-if="skippedCount > 0">
          <td>跳过</td>
          <td>{{ skippedCount }} 条</td>
        </tr>
        <tr v-if="interruptedCount > 0">
          <td>中断</td>
          <td class="warn">{{ interruptedCount }} 条</td>
        </tr>
        <tr>
          <td>总耗时</td>
          <td>{{ durationText }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="startedAtText" class="meta">运行时间：{{ startedAtText }}</p>
    <p v-if="summary.baseUrl" class="meta">
      目标地址：<span class="url">{{ summary.baseUrl }}</span>
    </p>

    <n-button
      v-if="canOpenReport"
      type="primary"
      block
      size="small"
      class="open-report"
      @click="openReport"
    >
      查看测试报告
    </n-button>
  </section>
</template>

<style scoped>
.report-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--color-ink-deep);
}

.skill-line {
  margin: 0;
  font-size: 12.5px;
  color: var(--color-ink-muted);
}

.run-id {
  color: var(--color-ink-muted);
}

.missing-note {
  margin: 0;
  color: #b45309;
  font-size: 12px;
  line-height: 1.5;
}

.meta {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.url {
  color: var(--color-ink-body);
  word-break: break-all;
}

.stat-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.stat-table th,
.stat-table td {
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  text-align: left;
}

.stat-table th {
  width: 40%;
  font-weight: 600;
  color: var(--color-ink-deep);
  background: var(--color-well);
}

.stat-table td {
  color: var(--color-ink-body);
}

.stat-table td.pass {
  color: #15803d;
  font-weight: 600;
}

.stat-table td.fail {
  color: #b91c1c;
  font-weight: 600;
}

.stat-table td.warn {
  color: #b45309;
  font-weight: 600;
}

.open-report {
  margin-top: 4px;
}
</style>

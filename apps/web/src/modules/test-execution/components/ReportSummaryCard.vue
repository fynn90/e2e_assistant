<!--
  测试报告总结卡片（v11，PRD V1）：执行结束后出现在执行区块内的结果摘要。
  内容：结果统计（通过/失败/中断/跳过）、总耗时、运行时间；
  底部固定提供「查看详细报告」按钮（点击行为由父级路由到报告视图）。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { IExecutionSummary } from '@authine-e2e-agent/types'

const props = defineProps<{
  summary: IExecutionSummary
  /** 是否存在可打开的报告文件（磁盘写入失败时为 false，按钮隐藏）。 */
  reportAvailable?: boolean
  /** 报告打开中（文件被删除时反馈「报告文件不存在」）。 */
  opening?: boolean
}>()

const emit = defineEmits<{ openReport: [] }>()

/** 失败计数（含超时，PRD 第 9 章）。 */
const failedCount = computed(() => props.summary.failed)

/** 运行时间（本地时区的可读格式）。 */
const startedAtText = computed(() => {
  const startedAt = Date.parse(props.summary.startedAt)
  if (Number.isNaN(startedAt)) return props.summary.startedAt
  return new Date(startedAt).toLocaleString()
})

/** 总耗时的可读格式。 */
const durationText = computed(() => formatDuration(props.summary.durationMs))

/**
 * 把毫秒时长格式化为可读文本。
 * @param durationMs 毫秒时长。
 * @returns 形如「850ms / 12.3s / 2m 05s」的文本。
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
  <section class="report-summary-card" aria-label="测试报告总结">
    <header class="card-head">
      <span class="card-title">测试报告总结</span>
      <n-tag
        size="small"
        :type="
          props.summary.status === 'interrupted'
            ? 'warning'
            : failedCount > 0
              ? 'error'
              : 'success'
        "
        round
      >
        {{
          props.summary.status === 'interrupted'
            ? '已中断'
            : failedCount > 0
              ? '存在失败'
              : '全部通过'
        }}
      </n-tag>
    </header>

    <div class="stat-grid">
      <div class="stat">
        <span class="stat-num">{{ props.summary.total }}</span>
        <span class="stat-label">总数</span>
      </div>
      <div class="stat">
        <span class="stat-num pass">{{ props.summary.passed }}</span>
        <span class="stat-label">通过</span>
      </div>
      <div class="stat">
        <span class="stat-num" :class="{ fail: failedCount > 0 }">{{
          failedCount
        }}</span>
        <span class="stat-label">失败</span>
      </div>
      <div class="stat">
        <span
          class="stat-num"
          :class="{ warn: props.summary.interrupted > 0 }"
          >{{ props.summary.interrupted }}</span
        >
        <span class="stat-label">中断</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ props.summary.skipped }}</span>
        <span class="stat-label">跳过</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ durationText }}</span>
        <span class="stat-label">总耗时</span>
      </div>
    </div>

    <p class="run-time">运行时间：{{ startedAtText }}</p>

    <!-- 底部固定入口（PRD V1） -->
    <n-button
      v-if="props.reportAvailable"
      type="primary"
      block
      :loading="props.opening"
      class="open-report-button"
      @click="emit('openReport')"
    >
      查看详细报告
    </n-button>
    <p v-else class="no-report-hint">本次执行未生成报告文件。</p>
  </section>
</template>

<style scoped>
.report-summary-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink-deep);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-xs);
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 2px;
  border-radius: var(--radius-control);
  background: var(--color-well);
}

.stat-num {
  font-size: 15px;
  font-weight: 700;
  color: var(--color-ink-deep);
  white-space: nowrap;
}

.stat-num.pass {
  color: #15803d;
}

.stat-num.fail {
  color: #b91c1c;
}

.stat-num.warn {
  color: #b45309;
}

.stat-label {
  font-size: 11px;
  color: var(--color-ink-muted);
}

.run-time {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
}

.open-report-button {
  margin-top: auto;
}

.no-report-hint {
  margin: 0;
  font-size: 12px;
  color: var(--color-ink-muted);
  text-align: center;
}
</style>

<!--
  执行历史卡（v17，PRD Q7）。

  两条如实呈现的要求：
    1. **历史以持久化报告为准**：未生成报告的执行（就绪不通过、启动失败）
       不在这里，但在对话流里的执行卡片仍然保留——卡片需要如实说明这一区别，
       否则用户会以为「跑过的没记录」；
    2. **更早的报告不在卡内列出**（`truncatedAt` 大于实际行数时补一句），
       指向该用例的开发页。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { readRunHistoryPayload } from '../workbench-view-payloads'
import {
  formatDuration,
  formatRunCounts,
  formatTimestamp,
  runOutcomeKind,
} from './workbench-format'

const props = defineProps<{
  /** 历史卡载荷（原始 `Record`，本组件内一次窄化）。 */
  payload: Record<string, unknown>
}>()

const emit = defineEmits<{
  /** 用户请求打开某次执行的报告。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
}>()

const data = computed(() => readRunHistoryPayload(props.payload))

/** 是否被截断（更早的报告未列出，Q7 要求如实说明）。 */
const truncated = computed(
  () => data.value.truncatedAt > data.value.runs.length,
)

/**
 * 打开某次执行的报告。
 * @param runId - 报告目录名。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openReport(runId: string): void {
  emit('openReport', {
    skillId: data.value.skillId,
    skillTitle: data.value.skillTitle,
    runId,
  })
}
</script>

<template>
  <div class="run-history">
    <p class="head-line">
      用例「{{ data.skillTitle || '未命名用例' }}」的执行记录
    </p>

    <p v-if="data.neverExecuted" class="empty">
      这个用例还没有执行过。执行会生成报告，历史据此记录。
    </p>

    <template v-else>
      <ul class="run-list">
        <li v-for="run in data.runs" :key="run.runId" class="run-row">
          <div class="run-main">
            <span class="run-time">{{ formatTimestamp(run.startedAt) }}</span>
            <span class="run-verdict" :class="runOutcomeKind(run)">
              {{ formatRunCounts(run) }}
            </span>
            <span class="run-duration"
              >耗时 {{ formatDuration(run.durationMs) }}</span
            >
          </div>
          <n-button
            size="tiny"
            quaternary
            type="primary"
            @click="openReport(run.runId)"
          >
            查看报告
          </n-button>
        </li>
      </ul>

      <p v-if="truncated" class="foot-note">
        更早的报告可在该用例的开发页查看。
      </p>
      <p class="foot-note">
        未生成报告的执行（如就绪校验未通过、启动失败）不计入历史，但仍保留在对话流的执行卡片中。
      </p>
    </template>
  </div>
</template>

<style scoped>
.run-history {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.head-line {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-ink-body);
  font-size: 12.5px;
}

.empty {
  margin: 0;
  padding: 16px;
  color: var(--color-ink-muted);
  font-size: 12.5px;
}

.run-list {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 360px;
  overflow-y: auto;
}

.run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
}

.run-row:last-child {
  border-bottom: none;
}

.run-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  font-size: 12px;
}

.run-time {
  color: var(--color-ink-body);
}

.run-verdict.passed {
  color: #15803d;
}

.run-verdict.failed {
  color: #b91c1c;
  font-weight: 600;
}

.run-verdict.interrupted {
  color: #b45309;
}

.run-duration {
  color: var(--color-ink-muted);
}

.foot-note {
  margin: 0;
  padding: 6px 16px;
  color: var(--color-ink-muted);
  font-size: 11.5px;
  line-height: 1.5;
}
</style>

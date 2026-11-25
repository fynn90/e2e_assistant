<!--
  用例清单卡（v17，PRD Q1/Q2/Q3/Q6）。

  三条硬约束：
    1. **卡内可浏览全部结果**（Q2）：正文区固定上限 + 内滚动，不要求用户用
       多轮对话翻页；
    2. **行内快捷操作按字段渲染**（Q6）：只有行上带了 `inlineActionId` 才画按钮
       ——服务端登记失败时字段缺省，前端据此不渲染（好过点了报错的按钮）；
    3. **不提供删除**（Q6）：删除只在用例删除卡里做，避免清单里误触。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import {
  describeSkillListFilter,
  readSkillListPayload,
} from '../workbench-view-payloads'
import {
  formatDuration,
  formatRunCounts,
  formatTimestamp,
  runOutcomeKind,
} from './workbench-format'

const props = defineProps<{
  /** 清单卡载荷（原始 `Record`，本组件内一次窄化）。 */
  payload: Record<string, unknown>
  /** 行内动作请求中：对应 actionId 的按钮置 loading 并禁用。 */
  pendingActionId?: string
}>()

const emit = defineEmits<{
  /** 用户点击某行的行内快捷操作。 */
  inlineAction: [actionId: string]
}>()

const data = computed(() => readSkillListPayload(props.payload))

/** 顶部筛选说明（Q3：一句话说明筛选条件与命中数量）。 */
const filterSummary = computed(() =>
  describeSkillListFilter(data.value.filter, data.value.total),
)

/** 行内按钮文案（与服务端 `inlineActionLabel` 同一口径）。 */
function inlineLabel(action: string | undefined): string {
  switch (action) {
    case 'generate-skill-document':
      return '生成 SKILL.md'
    case 'generate-playwright-script':
      return '生成脚本'
    default:
      return '执行'
  }
}

/**
 * 触发某行的行内操作。
 * @param actionId - 该行的动作登记 ID。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function trigger(actionId: string): void {
  emit('inlineAction', actionId)
}
</script>

<template>
  <div class="skill-list">
    <p class="list-summary">
      <span v-if="filterSummary">{{ filterSummary }}</span>
      <span v-else>共 {{ data.total }} 个用例</span>
      <span
        v-if="data.overallTotal && data.overallTotal !== data.total"
        class="overall"
      >
        （工作区共 {{ data.overallTotal }} 个）
      </span>
    </p>

    <p v-if="data.rows.length === 0" class="list-empty">
      当前条件下没有命中的用例，可放宽筛选条件再试。
    </p>

    <!-- 卡内滚动（Q2）：结果多时在卡内浏览，不要求用户翻页对话 -->
    <ul v-else class="list-body">
      <li v-for="row in data.rows" :key="row.skillId" class="row">
        <div class="row-main">
          <span class="row-title">{{ row.title || '未命名用例' }}</span>
          <p v-if="row.description" class="row-desc">{{ row.description }}</p>
          <div class="row-tags">
            <n-tag
              size="tiny"
              :type="row.hasSkillDocument ? 'success' : 'warning'"
              :bordered="false"
            >
              {{ row.hasSkillDocument ? '已有文档' : '缺文档' }}
            </n-tag>
            <n-tag
              size="tiny"
              :type="row.hasPlaywrightScript ? 'success' : 'warning'"
              :bordered="false"
            >
              {{ row.hasPlaywrightScript ? '已有脚本' : '缺脚本' }}
            </n-tag>
            <n-tag v-if="row.baseUrl" size="tiny" :bordered="false">
              {{ row.baseUrl }}
            </n-tag>
          </div>
        </div>

        <div class="row-meta">
          <span v-if="row.latestRun" class="run-line">
            <span class="run-verdict" :class="runOutcomeKind(row.latestRun)">
              {{ formatRunCounts(row.latestRun) }}
            </span>
            <span class="run-time">
              {{ formatTimestamp(row.latestRun.at) }} ·
              {{ formatDuration(row.latestRun.durationMs) }}
            </span>
          </span>
          <span v-else class="run-line muted">未执行过</span>

          <!-- 行内操作：无 inlineActionId 时不渲染按钮（Q6「登记与呈现解耦」） -->
          <n-button
            v-if="row.inlineActionId"
            size="tiny"
            type="primary"
            secondary
            :disabled="pendingActionId === row.inlineActionId"
            :loading="pendingActionId === row.inlineActionId"
            @click="trigger(row.inlineActionId)"
          >
            {{ inlineLabel(row.inlineAction) }}
          </n-button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.skill-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.list-summary {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-ink-muted);
  font-size: 12px;
}

.overall {
  color: var(--color-ink-muted);
}

.list-empty {
  margin: 0;
  padding: 16px;
  color: var(--color-ink-muted);
  font-size: 12.5px;
}

/* 卡内滚动（Q2）：上限之外在卡内滚动，不拉长整条时间线 */
.list-body {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 420px;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-md);
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
}

.row:last-child {
  border-bottom: none;
}

.row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.row-title {
  color: var(--color-ink-deep);
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-desc {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.row-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.row-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.run-line {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 11.5px;
}

.run-line.muted {
  color: var(--color-ink-muted);
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

.run-time {
  color: var(--color-ink-muted);
}
</style>

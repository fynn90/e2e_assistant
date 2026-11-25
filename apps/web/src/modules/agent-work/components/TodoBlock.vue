<!-- 待办清单块：展示 Agent 的多步骤计划与实时进度（v12-pre）。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { IAgentTodoItem } from '@charlie_deng/e2e-assistant-types'
import IconFont from '../../../common/icon/IconFont.vue'
import { TODO_BLOCK_ICON } from '../icons'
import type { ITodoTimelineItem } from '../timeline'

const props = defineProps<{
  /** 待办清单块时间线项。 */
  item: ITodoTimelineItem
}>()

/** 已完成条数。 */
const completedCount = computed(
  () => props.item.items.filter((entry) => entry.status === 'completed').length,
)

/** 进度百分比（清单为空时按 0 处理，避免除零得到 NaN）。 */
const progressPercent = computed(() => {
  if (props.item.items.length === 0) return 0
  return Math.round((completedCount.value / props.item.items.length) * 100)
})

/** 是否全部完成（用于把整块切换为完成态配色）。 */
const allCompleted = computed(
  () =>
    props.item.items.length > 0 &&
    completedCount.value === props.item.items.length,
)

/**
 * 取单个待办项的状态图标字形。
 *
 * @param status - 待办项状态。
 * @returns 图标字符：完成 ✓、进行中 ▸、待开始 ○。
 */
function statusGlyph(status: IAgentTodoItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '▸'
  return '○'
}
</script>

<template>
  <div class="todo-block" :class="{ completed: allCompleted }">
    <div class="todo-header">
      <IconFont class="todo-icon" :name="TODO_BLOCK_ICON" :size="14" />
      <span class="todo-title">任务清单</span>
      <span class="todo-progress"
        >{{ completedCount }}/{{ item.items.length }}</span
      >
    </div>

    <!-- 进度条：让「做到哪了」一眼可见，不需要逐条读文字 -->
    <div
      class="todo-bar"
      role="progressbar"
      :aria-valuenow="progressPercent"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="todo-bar-fill" :style="{ width: `${progressPercent}%` }" />
    </div>

    <ol class="todo-list">
      <li
        v-for="entry in item.items"
        :key="entry.id"
        class="todo-entry"
        :class="entry.status"
      >
        <span class="todo-glyph" :class="entry.status">{{
          statusGlyph(entry.status)
        }}</span>
        <span class="todo-text">{{ entry.content }}</span>
        <span v-if="entry.activeForm" class="todo-active">{{
          entry.activeForm
        }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.todo-block {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
  padding: 10px 12px;
}
.todo-block.completed {
  border-color: #bbf7d0;
  background: #f0fdf4;
}
/* 与 ThinkingBlock / AskUserQuestion 的头部同构：图标与文字居中对齐、8px 间距。
   原先为 space-between + baseline，加入图标后改用 space-between 的等价写法
   （进度计数走 margin-left: auto），避免图标参与基线对齐时与文字错位 */
.todo-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 图标随标题排版；颜色统一为中性墨色，与时间线其余图标成一套（字号走 size prop） */
.todo-icon {
  flex-shrink: 0;
  color: var(--color-ink-muted);
}
.todo-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink-deep);
}
/* 进度计数推到行尾：它此前靠 header 的 space-between 撑到右侧，
   现由标题前的图标占位，故改用自动外边距 */
.todo-progress {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-ink-muted);
  font-variant-numeric: tabular-nums;
}
.todo-bar {
  margin-top: 6px;
  height: 4px;
  border-radius: 2px;
  background: var(--color-border);
  overflow: hidden;
}
.todo-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: #2563eb;
  transition: width var(--motion-fast) var(--ease-out);
}
.todo-block.completed .todo-bar-fill {
  background: #059669;
}
.todo-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.todo-entry {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--color-ink-body);
}
.todo-entry.completed .todo-text {
  color: var(--color-ink-muted);
  text-decoration: line-through;
}
.todo-entry.in_progress .todo-text {
  font-weight: 600;
  color: var(--color-ink-deep);
}
.todo-glyph {
  flex-shrink: 0;
  width: 12px;
  font-size: 11px;
  color: var(--color-ink-muted);
}
.todo-glyph.completed {
  color: #059669;
}
.todo-glyph.in_progress {
  color: #2563eb;
}
.todo-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.todo-active {
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--color-ink-muted);
}
</style>

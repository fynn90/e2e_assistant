<!-- 思考块：折叠的 Agent 推理过程，流式期间行内滚动，结束后展示耗时。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import IconFont from '../../../common/icon/IconFont.vue'
import { THINKING_ICON } from '../icons'
import type { IThinkingTimelineItem } from '../timeline'

const props = defineProps<{
  /** 思考块时间线项。 */
  item: IThinkingTimelineItem
}>()

const expanded = ref(false)

const thinking = computed(() => props.item.status === 'streaming')

/** 头部文案：思考中… / 已思考 N 秒。 */
const headerText = computed(() => {
  if (thinking.value) return '思考中…'
  const seconds = ((props.item.durationMs ?? 0) / 1000).toFixed(1)
  return `已思考 ${seconds} 秒`
})

/** 折叠时行内展示的最新一句思考。 */
const latestLine = computed(() => {
  const lines = props.item.text
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
  return lines[lines.length - 1] ?? ''
})
</script>

<template>
  <div class="thinking-block" :class="{ streaming: thinking }">
    <button class="thinking-header" type="button" @click="expanded = !expanded">
      <IconFont class="thinking-icon" :name="THINKING_ICON" :size="13" />
      <span class="thinking-title">{{ headerText }}</span>
      <span v-if="!expanded && latestLine" class="thinking-latest">{{
        latestLine
      }}</span>
      <span class="thinking-caret" aria-hidden="true">{{
        expanded ? '▾' : '▸'
      }}</span>
    </button>
    <pre v-if="expanded" class="thinking-content">{{ item.text }}</pre>
  </div>
</template>

<style scoped>
.thinking-block {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-well);
  overflow: hidden;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.thinking-block.streaming {
  border-color: #c7d2fe;
  background: #eef2ff;
}
.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--color-ink-muted);
  text-align: left;
}
.thinking-header:hover {
  color: var(--color-ink-body);
}
/* 不声明 color：继承 .thinking-header 的墨色，hover 时随标题一同转深 */
.thinking-icon {
  flex-shrink: 0;
}
.thinking-title {
  font-weight: 600;
  flex-shrink: 0;
}
.thinking-latest {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #9ca3af;
}
.thinking-caret {
  flex-shrink: 0;
  color: #c4c9d1;
}
.thinking-content {
  margin: 0;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  font-size: 12px;
  line-height: 1.65;
  color: var(--color-ink-body);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
</style>

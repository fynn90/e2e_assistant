<!--
  生成任务卡片的过程区（v16，PRD GEN-3）。

  数据来源：**子会话**（stage 为 generation 的会话）的工作事件流——
  与 Skill 开发页生成侧边栏同源同构（同一事件流、同一归约语义、同一展示组件族）。
  复用 `useAgentWorkTimeline`（它存在的唯一理由就是「同一套归约语义可被多处并行使用」）。

  为什么折叠而非全展开：生成过程可能很长（页面核对 + 生成 + 校验），
  用户在工作台里关心的是「进行到哪、有没有结果」；展开/收起把细节交给用户按需查看。
-->
<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { NCollapseTransition } from 'naive-ui'
import { useAgentWorkTimeline } from '../timeline'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolBlock from './ToolBlock.vue'
import ContentBlock from './ContentBlock.vue'
import TodoBlock from './TodoBlock.vue'

const props = defineProps<{
  /** 生成子会话 ID（卡片的事件流来源）。 */
  sessionId: string
  /** 任务是否已结束（结束后默认收起，减少视觉噪音）。 */
  finished: boolean
}>()

/** 展开状态：运行中默认展开（用户要看进展），结束后默认收起（看结论）。 */
const expanded = ref(!props.finished)

// 复用工作台的时间线 composable：它按 sessionId 订阅子会话的 SSE 流并归约。
const { items } = useAgentWorkTimeline({
  sessionId: toRef(props, 'sessionId'),
})

/** 只展示过程类块（思考 / 工具 / 待办 / 内容）：生成子会话不会产生交互与卡片。 */
const processItems = computed(() =>
  items.value.filter(
    (item) =>
      item.kind === 'thinking' ||
      item.kind === 'tool' ||
      item.kind === 'todo' ||
      item.kind === 'content',
  ),
)

/** 最近一条工具调用的摘要（收起状态下的一行概览）。 */
const latestSummary = computed(() => {
  for (let index = processItems.value.length - 1; index >= 0; index -= 1) {
    const item = processItems.value[index]!
    if (item.kind === 'tool') {
      return `${item.title}${item.summary ? ` · ${item.summary}` : ''}`
    }
  }
  return ''
})
</script>

<template>
  <div class="generation-body">
    <button
      type="button"
      class="body-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="toggle-text">
        {{ expanded ? '收起生成过程' : `展开生成过程（${processItems.length} 步）` }}
      </span>
      <span v-if="!expanded && latestSummary" class="toggle-summary">
        {{ latestSummary }}
      </span>
    </button>

    <n-collapse-transition :show="expanded">
      <div class="body-items">
        <template v-for="item in processItems" :key="item.blockId">
          <ThinkingBlock v-if="item.kind === 'thinking'" :item="item" />
          <ToolBlock v-else-if="item.kind === 'tool'" :item="item" />
          <TodoBlock v-else-if="item.kind === 'todo'" :item="item" />
          <ContentBlock v-else-if="item.kind === 'content'" :item="item" />
        </template>
        <p v-if="processItems.length === 0" class="placeholder">
          正在准备生成…
        </p>
      </div>
    </n-collapse-transition>
  </div>
</template>

<style scoped>
.generation-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  min-height: 0;
}

.body-toggle {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--color-ink-muted);
  font-size: 12.5px;
  text-align: left;
}

.body-toggle:hover .toggle-text {
  color: var(--color-ink-body);
}

.toggle-text {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.toggle-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: var(--space-sm);
  max-height: 380px;
  overflow-y: auto;
}

.placeholder {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}
</style>

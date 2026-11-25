<!--
  只读视图卡片（v17，PRD Q1–Q7 / R3 / H2）：按 `viewKind` 分派到五个子视图。

  为什么合成一种卡：五张卡全部**只读、无状态迁移、发布即终态**（技术方案 §3.1），
  差异只在渲染分派——拆成五种块会让物化、恢复、归约各写五遍。

  分派依据是结构化的 `viewKind` 字段，不做内容嗅探（v14 立下的约定）。
  未知 viewKind（服务端比前端新）落到兜底文案，而不是渲染空白卡片。
-->
<script setup lang="ts">
import { computed } from 'vue'
import type { IWorkbenchViewTimelineItem } from '../timeline'
import WorkbenchSkillList from './WorkbenchSkillList.vue'
import WorkbenchSkillDetail from './WorkbenchSkillDetail.vue'
import WorkbenchRunHistory from './WorkbenchRunHistory.vue'
import WorkbenchReadiness from './WorkbenchReadiness.vue'
import WorkbenchCapability from './WorkbenchCapability.vue'

const props = defineProps<{
  /** 只读视图卡片项。 */
  item: IWorkbenchViewTimelineItem
  /** 行内动作请求中（禁用该行按钮，避免重复点击）。 */
  pendingActionId?: string
}>()

const emit = defineEmits<{
  /** 用户点击清单卡的行内快捷操作（点击即触发，不产生新轮次）。 */
  inlineAction: [item: IWorkbenchViewTimelineItem, actionId: string]
  /** 用户请求打开报告弹窗（历史卡的报告入口）。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
}>()

/** 卡片标题：按 viewKind 取，未知种类给中性标题。 */
const title = computed(() => {
  switch (props.item.viewKind) {
    case 'skill-list':
      return '用例清单'
    case 'skill-detail':
      return '用例详情'
    case 'run-history':
      return '执行历史'
    case 'readiness':
      return '执行前体检'
    case 'capability':
      return '我能做什么'
    default:
      return '工作区视图'
  }
})

/** viewKind 是否已知（未知时渲染兜底提示）。 */
const known = computed(() =>
  (
    [
      'skill-list',
      'skill-detail',
      'run-history',
      'readiness',
      'capability',
    ] as const
  ).includes(props.item.viewKind),
)
</script>

<template>
  <section class="workbench-view" aria-label="工作区视图">
    <header class="view-head">
      <span class="view-title">{{ title }}</span>
    </header>

    <WorkbenchSkillList
      v-if="item.viewKind === 'skill-list'"
      :payload="item.payload"
      :pending-action-id="pendingActionId"
      @inline-action="(actionId) => emit('inlineAction', item, actionId)"
    />
    <WorkbenchSkillDetail
      v-else-if="item.viewKind === 'skill-detail'"
      :payload="item.payload"
    />
    <WorkbenchRunHistory
      v-else-if="item.viewKind === 'run-history'"
      :payload="item.payload"
      @open-report="(input) => emit('openReport', input)"
    />
    <WorkbenchReadiness
      v-else-if="item.viewKind === 'readiness'"
      :payload="item.payload"
      :pending-action-id="pendingActionId"
      @inline-action="(actionId) => emit('inlineAction', item, actionId)"
    />
    <WorkbenchCapability
      v-else-if="item.viewKind === 'capability'"
      :payload="item.payload"
    />
    <!-- 未知 viewKind（服务端比前端新）：如实说明，不渲染空白卡片 -->
    <p v-else-if="!known" class="view-fallback">
      这个视图的展示形式当前版本还不支持，请升级前端后再查看。
    </p>
  </section>
</template>

<style scoped>
.workbench-view {
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  overflow: hidden;
}

.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-well);
}

.view-title {
  color: var(--color-ink-deep);
  font-size: 13.5px;
  font-weight: 600;
}

.view-fallback {
  margin: 0;
  padding: 12px 16px;
  color: var(--color-ink-muted);
  font-size: 12.5px;
}
</style>

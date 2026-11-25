<!--
  阶段区块的标题行（PRD 5.3）：折叠箭头 + 阶段名 + 实时统计 + 状态徽标。

  ┌────────────────────────────────────────────────────────┐
  │ ⌄  SKILL 阶段      已思考 5 秒 · 3 次工具调用  [进行中] │ ← 整行即折叠开关
  └────────────────────────────────────────────────────────┘

  **整行是一个 `<button>`**：展开态与折叠态渲染的内容**完全相同**（此前两态各
  显示一套信息、还有一个独立的「收起」按钮，用户需要跨状态对照才能拼出全貌）。
  整行热区也让折叠操作不再需要瞄准左侧的一小块标题。

  **纯展示组件**：折叠状态、统计文案、状态徽标全部由父组件（`StageBlock`）传入，
  本组件不读 store、不做任何状态判定——判定逻辑集中在
  `modules/generation-flow/card-model.ts`，与 `SaveStateBadge.vue` 的定位一致。
-->
<script setup lang="ts">
import { NTag } from 'naive-ui'
import IconFont from '../../../common/icon/IconFont.vue'
import { STAGE_COLLAPSED_ICON, STAGE_EXPANDED_ICON } from '../icons'

defineProps<{
  /** 阶段显示名（`SKILL 阶段` / `Playwright 脚本阶段`）。 */
  title: string
  /** 是否已折叠；决定箭头朝向与 `aria-expanded`。 */
  collapsed: boolean
  /** 实时统计文案（已思考 N 秒 · N 次工具调用 · N 次命令执行）。 */
  summary: string
  /** 状态徽标：`type` 决定配色，`text` 为「进行中 / 已完成 / 失败 / 已停止」。 */
  status: { type: 'success' | 'error' | 'default' | 'info'; text: string }
}>()

const emit = defineEmits<{
  /** 用户点击标题行，请求切换折叠状态。 */
  toggle: []
}>()
</script>

<template>
  <button
    type="button"
    class="stage-head"
    :aria-expanded="!collapsed"
    @click="emit('toggle')"
  >
    <!-- 箭头字号走 size prop：IconFont 的字体族带 !important，CSS 里的
         font-size 会被内联样式覆盖，写在这里是死代码 -->
    <IconFont
      class="stage-head__chevron"
      :name="collapsed ? STAGE_COLLAPSED_ICON : STAGE_EXPANDED_ICON"
      :size="16"
    />
    <span class="stage-head__title">{{ title }}</span>
    <!-- 统计在左、状态徽标在最右：统计是过程数据，徽标是结论 -->
    <span class="stage-head__stats">{{ summary }}</span>
    <span class="stage-head__status">
      <n-tag size="small" :type="status.type" round>{{ status.text }}</n-tag>
    </span>
  </button>
</template>

<style scoped>
.stage-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  width: 100%;
  min-height: 44px;
  padding: 0 12px 0 8px;
  border: none;
  background: none;
  color: var(--color-ink-deep);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

/* 整行热区需要比小按钮更强的可点感知（与 ToolBlock 的 .tool-header:hover 一致） */
.stage-head:hover {
  background: rgb(0 0 0 / 2%);
}

.stage-head:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.stage-head__chevron {
  flex-shrink: 0;
  color: var(--color-ink-muted);
}

/* flex: 1 把右侧的统计与徽标推到行尾；不用 space-between——四个子元素下
   它会把间距摊得七零八落 */
.stage-head__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 空间不足时优先截断统计而非标题（标题是识别区块归属的唯一信息） */
.stage-head__stats {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-head__status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}
</style>

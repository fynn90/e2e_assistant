<!--
  SKILL.md 卡片的交互按钮（PRD 14.3 独立组件）。

  单一职责：只根据状态决定按钮的文案、可用性、置灰与显隐，
  **不感知产物内容**（不解析 SKILL.md 正文）。

  操作区规则（v13 修订）：
    - 最新卡片：`[生成 Playwright 脚本]`（主）
    - 历史卡片：`[生成 Playwright 脚本 ✓ 已于 {时间} 生成]`（主按钮置灰）

  v13 移除了 `[关闭]` 按钮：销毁内容的职责移到底部「清空」，
  收起由遮罩点击 / 收起图标 / Esc 承担（PRD B-4），
  因此本组件不再需要 `isLatest` —— 它是 v9「关闭按钮只出现在最新卡片上」
  这条规则的唯一用途。
-->
<script setup lang="ts">
import { NButton } from 'naive-ui'

defineProps<{
  /** 主按钮的执行结果标记；有值时按钮置灰并展示该文案（PRD 6.7）。 */
  primaryAction: { executedAt: string; label: string } | null
  /** 是否禁止主按钮（有阶段运行中时不允许再次触发）。 */
  primaryDisabled?: boolean
}>()

const emit = defineEmits<{
  /** 用户点击「生成 Playwright 脚本」。 */
  generateScript: []
}>()
</script>

<template>
  <template v-if="primaryAction">
    <!-- 执行成功后按钮不消失而是置灰，并保留完整文案含时间戳，
         使回看时能明确读到「这一步已经做过了、什么时候做的」（PRD 6.7）。 -->
    <n-button size="small" type="primary" disabled>{{
      primaryAction.label
    }}</n-button>
  </template>
  <template v-else>
    <n-button
      size="small"
      type="primary"
      :disabled="primaryDisabled"
      @click="emit('generateScript')"
    >
      生成 Playwright 脚本
    </n-button>
  </template>
</template>

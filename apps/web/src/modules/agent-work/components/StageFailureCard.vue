<!--
  终止卡片（PRD 6.5）：任一阶段失败或被用户停止时出现。

  单一职责：渲染终止状态（错误信息、部分写入说明、下一步建议），
  **不感知业务流程**。交互按钮由 StageFailureCardActions 负责。

  正文内容：
    - 错误信息（失败原因摘要，遵循既有脱敏与截断约束；取消情形展示「已停止」说明）
    - 已完成的部分（若失败前已有部分产物写入，给出明确说明，PRD 10.3）
    - 下一步建议
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NTag } from 'naive-ui'
import type { IFailureCard } from '../../../modules/generation-flow/types'
import CardShell from './CardShell.vue'

const props = defineProps<{
  /** 终止卡片数据。 */
  card: IFailureCard
}>()

const cancelled = computed(() => props.card.status === 'cancelled')
/** 状态徽标：失败用错误色，已停止用中性色。 */
const statusTag = computed(() =>
  cancelled.value
    ? { type: 'default' as const, text: '已停止' }
    : { type: 'error' as const, text: '失败' },
)
</script>

<template>
  <CardShell :file-name="card.fileName">
    <!-- 操作区插槽透传：交互按钮由 StageFailureCardActions 提供（PRD 14.3 分层约束） -->
    <template #actions>
      <slot name="actions" />
    </template>
    <template #badges>
      <n-tag size="small" :type="statusTag.type" round>{{
        statusTag.text
      }}</n-tag>
    </template>

    <n-alert
      :type="cancelled ? 'info' : 'error'"
      :title="cancelled ? '已停止' : '生成失败'"
    >
      {{ card.errorMessage }}
    </n-alert>

    <!-- 部分写入说明：失败前已有产物写入时，必须说明磁盘上可能仍是旧版本（PRD 10.3） -->
    <n-alert
      v-if="card.partialWriteHint"
      class="failure-hint"
      type="warning"
      title="磁盘内容可能未更新"
    >
      {{ card.partialWriteHint }}
    </n-alert>

    <p class="failure-next-step">{{ card.nextStepHint }}</p>
  </CardShell>
</template>

<style scoped>
.failure-hint {
  margin: 12px 0;
}

.failure-next-step {
  margin: 12px 0 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}
</style>

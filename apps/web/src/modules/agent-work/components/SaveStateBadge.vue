<!-- 保存状态徽标（PRD 7.4）：极简的圆点 + 文字形式，不用大面积色块，避免干扰阅读。 -->
<script setup lang="ts">
import { computed } from 'vue'
import {
  AUTO_SAVE_STATE_LABELS,
  type TAutoSaveState,
} from '../../../common/autosave/types'

const props = defineProps<{
  /** 当前保存状态。 */
  state: TAutoSaveState
  /**
   * 是否以「状态」角色播报。
   *
   * PRD 10.1 第 4 条要求保存状态变化**不主动播报**（用户输入时频繁变化会干扰），
   * 因此默认关闭；仅在失败时由外部单独播报一次。
   */
  announce?: boolean
}>()

/** 展示文案。 */
const label = computed(() => AUTO_SAVE_STATE_LABELS[props.state])
</script>

<template>
  <span
    class="save-state-badge"
    :class="state"
    :role="announce ? 'status' : undefined"
    :aria-live="announce ? 'polite' : 'off'"
  >
    <span class="save-state-dot" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<style scoped>
.save-state-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-ink-muted);
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
}

.save-state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
}

/* 有未保存改动：警示色，提示磁盘尚未追上屏幕 */
.save-state-badge.pending {
  color: var(--color-warning);
}

/* 保存失败与冲突：危险色 */
.save-state-badge.failed,
.save-state-badge.conflict {
  color: var(--color-danger);
}
</style>

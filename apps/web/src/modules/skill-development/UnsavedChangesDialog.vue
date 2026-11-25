<!-- 统一处理 Skill 编辑页未保存修改的保存、放弃和取消导航选择。 -->
<script setup lang="ts">
import { NModal, NCard, NSpace } from 'naive-ui'

const props = withDefaults(
  defineProps<{
    show: boolean
    saving?: boolean
    onSave: () => void
    onDiscard: () => void
    onCancel: () => void
  }>(),
  {
    saving: false,
  },
)
</script>

<template>
  <n-modal :show="props.show" :mask-closable="false" :close-on-esc="false">
    <n-card
      title="存在未保存修改"
      style="width: min(560px, calc(100vw - 32px))"
      role="dialog"
      aria-label="存在未保存修改"
      aria-modal="true"
    >
      可以先保存后继续，也可以放弃当前修改。选择继续编辑将取消本次导航。
      <template #footer>
        <n-space justify="end">
          <button class="dialog-button" type="button" @click="props.onCancel">
            继续编辑
          </button>
          <button
            class="dialog-button discard-button"
            type="button"
            @click="props.onDiscard"
          >
            放弃修改
          </button>
          <button
            class="dialog-button save-button"
            type="button"
            :disabled="props.saving"
            @click="props.onSave"
          >
            {{ props.saving ? '保存中…' : '保存并继续' }}
          </button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.dialog-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 var(--space-lg);
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink-body);
  text-decoration: none;
  cursor: pointer;
  font: inherit;
}

.dialog-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.discard-button {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.save-button {
  border-color: var(--color-action);
  background: var(--color-action);
  color: var(--color-surface);
}

.save-button:hover {
  border-color: var(--color-action-hover);
  background: var(--color-action-hover);
}

@media (pointer: coarse), (max-width: 760px) {
  .dialog-button {
    min-height: 44px;
  }
}
</style>

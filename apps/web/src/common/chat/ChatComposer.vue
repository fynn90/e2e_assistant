<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { InputInst } from 'naive-ui'
import { CHAT_MAX_MESSAGE_CHARACTERS } from './limits'

const props = defineProps<{
  modelValue: string
  disabled?: boolean
  streaming?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  send: [content: string]
  stop: []
}>()
const inputRef = ref<InputInst | null>(null)
const content = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
})
const showCount = computed(
  () => content.value.length >= CHAT_MAX_MESSAGE_CHARACTERS * 0.8,
)

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
    return
  }

  event.preventDefault()

  if (!props.streaming) {
    send()
  }
}

function send(): void {
  const value = content.value.trim()

  if (!value || props.disabled || props.streaming) {
    return
  }

  emit('send', value)
}

function handleAction(): void {
  if (props.streaming) {
    emit('stop')
    return
  }

  send()
}

function focus(): void {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <form
    class="composer-shell"
    aria-label="发送 Chat 消息"
    @submit.prevent="send"
  >
    <n-input
      ref="inputRef"
      v-model:value="content"
      type="textarea"
      :bordered="false"
      :autosize="{ minRows: 1, maxRows: 5 }"
      :disabled="props.disabled"
      :maxlength="CHAT_MAX_MESSAGE_CHARACTERS"
      :input-props="{
        'aria-label': '给 Agent 发送消息',
        'aria-describedby': 'chat-composer-help',
      }"
      placeholder="输入消息，Enter 发送，Shift+Enter 换行"
      @keydown="handleKeydown"
    />

    <div class="composer-actions">
      <span id="chat-composer-help" class="composer-help">
        Enter 发送 · Shift+Enter 换行
      </span>
      <span v-if="showCount" class="composer-count">
        {{ content.length }}/{{ CHAT_MAX_MESSAGE_CHARACTERS }}
      </span>
      <n-button
        class="composer-action"
        :type="props.streaming ? 'error' : 'primary'"
        :secondary="props.streaming"
        :disabled="!props.streaming && (props.disabled || !content.trim())"
        attr-type="button"
        @click="handleAction"
      >
        {{ props.streaming ? '停止' : '发送' }}
      </n-button>
    </div>
  </form>
</template>

<style scoped>
.composer-shell {
  width: 100%;
  padding: 8px 10px 8px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.08);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
}

.composer-shell:focus-within {
  border-color: #3b82f6;
  box-shadow:
    0 0 0 3px rgba(59, 130, 246, 0.12),
    0 8px 28px rgba(15, 23, 42, 0.08);
}

.composer-shell :deep(.n-input) {
  background: transparent;
}

.composer-shell :deep(.n-input-wrapper),
.composer-shell :deep(.n-input__textarea-el) {
  padding-left: 0;
  padding-right: 0;
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding-top: 4px;
}

.composer-help {
  margin-right: auto;
  color: #94a3b8;
  font-size: 12px;
}

.composer-count {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}

.composer-action {
  min-width: 64px;
  min-height: 38px;
  border-radius: 12px;
}

@container chat-panel (max-width: 520px) {
  .composer-shell {
    border-radius: 16px;
  }

  .composer-help {
    display: none;
  }

  .composer-count {
    margin-right: auto;
  }

  .composer-action {
    min-height: 42px;
  }
}
</style>

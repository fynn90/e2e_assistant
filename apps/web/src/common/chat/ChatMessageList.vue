<script setup lang="ts">
import { computed } from 'vue'
import type { IChatMessageViewModel } from './types'
import ChatMessageItem from './ChatMessageItem.vue'

const props = defineProps<{ messages: IChatMessageViewModel[] }>()
const emit = defineEmits<{ retry: [messageId: string] }>()
const streamingAnnouncement = computed(() => {
  const lastAssistantMessage = [...props.messages]
    .reverse()
    .find((message) => message.role === 'assistant')

  if (!lastAssistantMessage) {
    return ''
  }

  switch (lastAssistantMessage.status) {
    case 'streaming':
      return 'Agent 正在生成回复。'
    case 'failed':
      return 'Agent 回复生成失败，可以重试。'
    case 'stopped':
      return '已停止生成。'
    default:
      return 'Agent 回复已完成。'
  }
})
</script>

<template>
  <div class="message-list" role="list">
    <chat-message-item
      v-for="message in props.messages"
      :key="message.id"
      :message="message"
      @retry="emit('retry', $event)"
    />
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ streamingAnnouncement }}
    </p>
  </div>
</template>

<style scoped>
.message-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

/* .sr-only 播报样式使用 style.css 中的全局工具类（fixed 定位，不影响滚动） */
</style>

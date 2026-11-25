<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag } from 'naive-ui'
import type { IChatMessageViewModel } from './types'
import { renderSafeMarkdown, splitMessageParts } from './markdown'
import ChatCodeBlock from './ChatCodeBlock.vue'
import ChatToolCallList from './ChatToolCallList.vue'

const props = defineProps<{ message: IChatMessageViewModel }>()
const emit = defineEmits<{ retry: [messageId: string] }>()
const parts = computed(() => splitMessageParts(props.message.content))
const accessibleLabel = computed(() =>
  props.message.role === 'user' ? '你的消息' : 'Agent 回复',
)
</script>

<template>
  <article
    class="message"
    :class="props.message.role"
    role="listitem"
    :aria-label="accessibleLabel"
  >
    <div class="message-meta">
      <strong>{{ props.message.role === 'user' ? '你' : 'Agent' }}</strong>
      <n-tag v-if="props.message.status === 'streaming'" size="small">
        生成中
      </n-tag>
      <n-tag v-if="props.message.status === 'failed'" size="small" type="error">
        失败
      </n-tag>
      <n-tag
        v-if="props.message.status === 'stopped'"
        size="small"
        type="warning"
      >
        已停止
      </n-tag>
    </div>

    <div v-if="props.message.contextFile" class="context-file">
      使用文件：{{ props.message.contextFile.relativePath }}（{{
        props.message.contextFile.version.slice(0, 8)
      }}）
    </div>

    <div v-if="props.message.contextWarnings?.length" class="context-warning">
      <div v-for="warning in props.message.contextWarnings" :key="warning">
        {{ warning }}
      </div>
    </div>

    <chat-tool-call-list
      v-if="
        props.message.role === 'assistant' && props.message.toolCalls?.length
      "
      :tool-calls="props.message.toolCalls"
    />

    <div class="message-content">
      <template v-for="(part, index) in parts" :key="index">
        <chat-code-block
          v-if="part.type === 'code'"
          :code="part.content"
          :language="part.language"
        />
        <div
          v-else
          class="markdown"
          v-html="renderSafeMarkdown(part.content)"
        />
      </template>
    </div>

    <n-button
      v-if="props.message.status === 'failed'"
      class="retry-button"
      size="small"
      secondary
      type="primary"
      @click="emit('retry', props.message.id)"
    >
      重试
    </n-button>
  </article>
</template>

<style scoped>
.message {
  min-width: 0;
  color: #0f172a;
  overflow-wrap: anywhere;
}

.message.user {
  align-self: flex-end;
  width: fit-content;
  max-width: min(78%, 720px);
  padding: 10px 14px;
  border: 1px solid #cbd5e1;
  border-radius: 18px;
  background: #ffffff;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.035);
}

.message.assistant {
  align-self: stretch;
  width: 100%;
  max-width: 100%;
  padding: 8px 0 14px;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  color: #475569;
  font-size: 13px;
}

.message.user .message-meta {
  margin-bottom: 4px;
  color: #64748b;
  font-size: 12px;
}

.context-file {
  margin-bottom: 8px;
  color: #64748b;
  font-size: 12px;
}

.context-warning {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff7ed;
  color: #9a3412;
  font-size: 12px;
}

.message-content,
.markdown {
  min-width: 0;
  max-width: 100%;
  line-height: 1.72;
  overflow-wrap: anywhere;
}

.markdown :deep(p:first-child) {
  margin-top: 0;
}

.markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.markdown :deep(a) {
  color: #2563eb;
  word-break: break-all;
}

.markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}

.markdown :deep(th),
.markdown :deep(td) {
  padding: 7px 10px;
  border: 1px solid #e2e8f0;
  text-align: left;
}

.markdown :deep(blockquote) {
  margin-inline: 0;
  padding-left: 12px;
  border-left: 3px solid #cbd5e1;
  color: #475569;
}

.markdown :deep(code) {
  overflow-wrap: anywhere;
}

.retry-button {
  margin-top: 8px;
}

@container chat-panel (max-width: 520px) {
  .message.user {
    max-width: 88%;
    border-radius: 16px;
  }
}
</style>

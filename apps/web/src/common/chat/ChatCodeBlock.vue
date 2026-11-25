<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useGlobalMessage } from '../../composables/useGlobalMessage'

const props = defineProps<{ code: string; language?: string }>()
const message = useGlobalMessage()

async function copyCode(): Promise<void> {
  await navigator.clipboard.writeText(props.code)
  message.success('代码已复制')
}
</script>

<template>
  <div class="code-block">
    <div class="code-header">
      <span>{{ props.language || 'text' }}</span>
      <n-button text size="tiny" @click="copyCode">复制</n-button>
    </div>
    <pre><code>{{ props.code }}</code></pre>
  </div>
</template>

<style scoped>
.code-block {
  margin: 10px 0;
  overflow: hidden;
  border: 1px solid #334155;
  border-radius: 10px;
  background: #0f172a;
  color: #e2e8f0;
}
.code-header {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid #334155;
  color: #94a3b8;
  font-size: 12px;
}
pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre;
}
</style>

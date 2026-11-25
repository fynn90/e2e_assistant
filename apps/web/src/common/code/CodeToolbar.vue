<script setup lang="ts">
import { NButton, NTag } from 'naive-ui'

const props = defineProps<{
  filePath: string
  readOnly: boolean
  saving: boolean
  dirty: boolean
  saveState?: 'idle' | 'saved' | 'failed' | 'conflict'
}>()

const emit = defineEmits<{ save: [] }>()
</script>

<template>
  <div class="code-toolbar">
    <div class="file-meta">
      <strong>{{ props.filePath }}</strong>
      <n-tag v-if="props.readOnly" size="small">只读</n-tag>
      <n-tag v-else-if="props.dirty" type="warning" size="small">未保存</n-tag>
      <n-tag v-else-if="props.saveState === 'saved'" type="success" size="small"
        >已保存</n-tag
      >
      <n-tag v-if="props.saveState === 'failed'" type="error" size="small"
        >保存失败</n-tag
      >
      <n-tag v-if="props.saveState === 'conflict'" type="error" size="small"
        >外部修改冲突</n-tag
      >
    </div>
    <n-button
      type="primary"
      size="small"
      :disabled="props.readOnly || !props.dirty"
      :loading="props.saving"
      @click="emit('save')"
    >
      保存
    </n-button>
  </div>
</template>

<style scoped>
.code-toolbar {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #1e293b;
  background: #0f172a;
  color: #e2e8f0;
}
.file-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.file-meta strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

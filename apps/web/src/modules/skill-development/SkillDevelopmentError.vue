<script setup lang="ts">
import { NButton, NResult, NSpace } from 'naive-ui'

const props = defineProps<{
  title: string
  description: string
  retryable?: boolean
}>()
const emit = defineEmits<{ retry: []; back: [] }>()
</script>

<template>
  <div class="error-shell">
    <n-result
      status="error"
      :title="props.title"
      :description="props.description"
    >
      <template #footer>
        <n-space justify="center">
          <n-button v-if="props.retryable" type="primary" @click="emit('retry')"
            >重试</n-button
          >
          <n-button @click="emit('back')">返回 Skill 管理页</n-button>
        </n-space>
      </template>
    </n-result>
  </div>
</template>

<style scoped>
.error-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #f8fafc;
}
</style>

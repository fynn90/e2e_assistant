<script setup lang="ts">
import type { IProjectFileItem } from '@authine-e2e-agent/types'
import { NButton, NCard, NEmpty, NSpace, NTag } from 'naive-ui'

const props = defineProps<{
  files: IProjectFileItem[]
  refreshingFiles: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

/**
 * 触发父组件刷新文件列表逻辑。
 * @returns 触发完成后无返回值。
 */
function handleRefresh(): void {
  emit('refresh')
}
</script>

<template>
  <n-card :bordered="false" size="large">
    <template #header>
      <div class="card-header">
        <div>
          <h2 class="card-title">项目文件</h2>
          <p class="card-description">
            展示当前项目目录下的文件结构，便于初始化后继续进入工作台操作。
          </p>
        </div>

        <n-button
          secondary
          type="primary"
          :loading="props.refreshingFiles"
          @click="handleRefresh"
        >
          刷新项目文件
        </n-button>
      </div>
    </template>

    <n-space
      v-if="props.files.length > 0"
      vertical
      size="medium"
      class="file-list"
    >
      <div
        v-for="fileItem in props.files"
        :key="fileItem.relativePath"
        class="file-item"
        :style="{ paddingLeft: String(14 + fileItem.depth * 18) + 'px' }"
      >
        <n-tag
          size="small"
          :type="fileItem.kind === 'directory' ? 'success' : 'default'"
        >
          {{ fileItem.kind === 'directory' ? '目录' : '文件' }}
        </n-tag>
        <span class="file-name">{{ fileItem.relativePath }}</span>
      </div>
    </n-space>

    <n-empty
      v-else
      description="当前项目目录还是空目录，后续生成的项目文件会显示在这里。"
    />
  </n-card>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}

.card-title {
  margin: 0 0 6px;
  font-size: 20px;
}

.card-description {
  margin: 0;
  color: #6b7280;
}

.file-list {
  display: grid;
  gap: 10px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  background: #f8fafc;
}

.file-name {
  flex: 1;
  color: #111827;
  word-break: break-all;
}

@media (max-width: 640px) {
  .card-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>

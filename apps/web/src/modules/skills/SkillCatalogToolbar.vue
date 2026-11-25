<!-- Skill 目录工具栏：作为吸顶工具条，背景撑满容器宽，内容与卡片网格左对齐。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import type { TSkillCatalogSort } from './useSkillCatalog'

const props = defineProps<{
  query: string
  sort: TSkillCatalogSort
  total: number
  filteredTotal: number
  refreshing: boolean
  lastSuccessfulRefreshAt: string | null
  showOnboardingEntry?: boolean
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  'update:sort': [value: TSkillCatalogSort]
  refresh: []
  create: []
  startOnboarding: []
}>()

const sortOptions: SelectOption[] = [
  { label: '最近更新', value: 'updated-desc' },
  { label: '最近创建', value: 'created-desc' },
  { label: '名称 A–Z', value: 'title-asc' },
]

const resultLabel = computed(() => {
  if (props.filteredTotal === props.total) {
    return `共 ${props.total} 个 Skill`
  }

  return `找到 ${props.filteredTotal} 个，共 ${props.total} 个`
})
const freshnessLabel = computed(() => {
  if (!props.lastSuccessfulRefreshAt) {
    return '尚未完成同步'
  }

  return `上次同步 ${formatDisplayTime(props.lastSuccessfulRefreshAt)}`
})

/**
 * 将 ISO 时间转换为紧凑的本地同步时间。
 * @param isoTime ISO 时间字符串。
 * @returns 中文本地时间文本。
 * @throws 不抛出异常；无效输入返回原始文本。
 */
function formatDisplayTime(isoTime: string): string {
  const timestamp = new Date(isoTime)

  if (Number.isNaN(timestamp.getTime())) {
    return isoTime
  }

  return timestamp.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * 将 Naive Select 的通用值收窄为 Skill 排序键。
 * @param value Select 输出的目标值。
 * @returns 事件发送后无返回值。
 * @throws 不抛出异常。
 */
function updateSort(value: string | number | null): void {
  if (typeof value === 'string') {
    emit('update:sort', value as TSkillCatalogSort)
  }
}
</script>

<template>
  <div class="catalog-bar-shell">
    <header class="catalog-bar">
      <div class="catalog-main">
        <div class="catalog-intro">
          <h2 class="catalog-title">本地 Skill</h2>
          <p class="catalog-description">
            快速查找、打开和维护结构化 E2E 测试用例。
          </p>
        </div>

        <div class="catalog-actions">
          <n-button
            v-if="props.showOnboardingEntry"
            quaternary
            class="catalog-action"
            @click="emit('startOnboarding')"
          >
            查看入门流程
          </n-button>
          <n-button
            secondary
            type="primary"
            class="catalog-action"
            :loading="props.refreshing"
            @click="emit('refresh')"
          >
            刷新
          </n-button>
          <n-button
            type="primary"
            class="catalog-action"
            @click="emit('create')"
          >
            新建 Skill
          </n-button>
        </div>
      </div>

      <div class="catalog-controls" role="search" aria-label="搜索和排序 Skill">
        <n-input
          clearable
          :value="props.query"
          placeholder="搜索名称、ID 或描述"
          aria-label="搜索 Skill"
          @update:value="emit('update:query', $event)"
        />
        <n-select
          class="sort-select"
          :value="props.sort"
          :options="sortOptions"
          aria-label="Skill 排序方式"
          @update:value="updateSort"
        />
        <span class="catalog-status" aria-live="polite">
          {{ resultLabel }} · {{ freshnessLabel }}
        </span>
      </div>
    </header>
  </div>
</template>

<style scoped>
/* 吸顶外壳：向上侵入页面顶部留白并横向铺满，作为白色吸顶条的承载容器 */
.catalog-bar-shell {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  padding: var(--space-lg) var(--space-page) var(--space-md);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  box-shadow: 0 1px 4px rgb(0 21 41 / 4%);
}

/* 吸顶条内容：不加左右内边距，直接与页面其余内容同宽，实现与卡片网格左对齐 */
.catalog-bar {
  min-width: 0;
}

.catalog-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-section);
}

.catalog-intro {
  min-width: 0;
}

.catalog-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  text-wrap: balance;
}

.catalog-description {
  max-width: 70ch;
  margin: var(--space-xs) 0 0;
  color: var(--color-ink-body);
  font-size: 14px;
  line-height: 1.6;
  text-wrap: pretty;
}

.catalog-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-sm);
}

.catalog-controls {
  display: grid;
  grid-template-columns: minmax(220px, 420px) 160px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-md);
  margin-top: var(--space-md);
}

.sort-select {
  min-width: 0;
}

.catalog-status {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

@media (max-width: 900px) {
  .catalog-controls {
    grid-template-columns: minmax(180px, 1fr) 140px;
  }

  .catalog-status {
    grid-column: 1 / -1;
    text-align: left;
    white-space: normal;
  }
}

@media (max-width: 760px) {
  .catalog-bar-shell {
    margin: calc(-1 * var(--space-md)) calc(-1 * var(--space-md)) 0;
    padding: var(--space-md);
  }

  .catalog-main {
    flex-direction: column;
    align-items: flex-start;
  }

  .catalog-actions {
    justify-content: flex-start;
    width: 100%;
  }

  .catalog-action {
    min-height: 44px;
  }
}

@media (max-width: 520px) {
  .catalog-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .catalog-actions :deep(.n-button:last-child) {
    grid-column: 1 / -1;
  }

  .catalog-controls {
    grid-template-columns: 1fr;
  }
}
</style>

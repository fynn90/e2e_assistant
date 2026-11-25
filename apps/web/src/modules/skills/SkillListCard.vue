<!-- Skill 目录容器：组合检索工具栏、分页列表、加载恢复与新建入口。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NPagination, NResult, NSkeleton } from 'naive-ui'
import type { ISkillSummary } from '@fynn90-e2e_assistant/types'
import SkillCatalogToolbar from './SkillCatalogToolbar.vue'
import SkillCard from './SkillCard.vue'
import SkillCreateModal from './SkillCreateModal.vue'
import SkillDeleteConfirmModal from './SkillDeleteConfirmModal.vue'
import { useSkillCatalog, type TSkillCatalogSort } from './useSkillCatalog'

const props = withDefaults(
  defineProps<{
    skillList: ISkillSummary[]
    initialLoading?: boolean
    initialLoadError?: string
    refreshingSkills: boolean
    lastSuccessfulRefreshAt?: string | null
    showOnboardingEntry?: boolean
  }>(),
  {
    initialLoading: false,
    initialLoadError: '',
    lastSuccessfulRefreshAt: null,
    showOnboardingEntry: false,
  },
)

const emit = defineEmits<{
  refresh: []
  openSkill: [skillId: string]
  created: [skill: ISkillSummary]
  deleted: []
  startOnboarding: []
}>()

const showCreateModal = ref(false)
const pendingDelete = ref<ISkillSummary | null>(null)
const catalog = useSkillCatalog(() => props.skillList)
const paginationVisible = computed(() => catalog.pageCount.value > 1)

/**
 * 打开新建 Skill 弹窗。
 * @returns 打开完成后无返回值。
 * @throws 不抛出异常。
 */
function openCreateModal(): void {
  showCreateModal.value = true
}

/**
 * 处理新建成功事件并通知页面进入对应 Skill。
 * @param skill 新创建的 Skill 摘要。
 * @returns 处理完成后无返回值。
 * @throws 不抛出异常。
 */
function handleCreateSuccess(skill: ISkillSummary): void {
  showCreateModal.value = false
  emit('created', skill)
}

/**
 * 更新目录排序方式。
 * @param value 目标排序键。
 * @returns 更新完成后无返回值。
 * @throws 不抛出异常。
 */
function updateSort(value: TSkillCatalogSort): void {
  catalog.setSort(value)
}

/**
 * 打开删除确认弹框。
 * @param skill 待删除的 Skill 摘要。
 * @returns 打开完成后无返回值。
 * @throws 不抛出异常。
 */
function openDeleteConfirm(skill: ISkillSummary): void {
  pendingDelete.value = skill
}

/**
 * 处理删除完成事件：关闭弹框并通知页面刷新列表。
 * @returns 处理完成后无返回值。
 * @throws 不抛出异常。
 */
function handleDeleted(): void {
  pendingDelete.value = null
  emit('deleted')
}
</script>

<template>
  <section
    class="skill-catalog"
    :aria-busy="props.initialLoading || props.refreshingSkills"
  >
    <skill-catalog-toolbar
      :query="catalog.query.value"
      :sort="catalog.sort.value"
      :total="catalog.total.value"
      :filtered-total="catalog.filteredTotal.value"
      :refreshing="props.refreshingSkills"
      :last-successful-refresh-at="props.lastSuccessfulRefreshAt"
      :show-onboarding-entry="props.showOnboardingEntry"
      @update:query="catalog.setQuery"
      @update:sort="updateSort"
      @refresh="emit('refresh')"
      @create="openCreateModal"
      @start-onboarding="emit('startOnboarding')"
    />

    <div
      v-if="props.initialLoading"
      class="catalog-skeleton"
      aria-label="正在加载 Skill 列表"
    >
      <div v-for="skeletonIndex in 5" :key="skeletonIndex" class="skeleton-row">
        <n-skeleton text width="32%" />
        <n-skeleton text :repeat="2" />
      </div>
    </div>

    <n-result
      v-else-if="props.initialLoadError"
      status="error"
      title="无法加载 Skill"
      :description="props.initialLoadError"
      class="catalog-result"
    >
      <template #footer>
        <n-button
          type="primary"
          :loading="props.refreshingSkills"
          @click="emit('refresh')"
        >
          重试
        </n-button>
      </template>
    </n-result>

    <div v-else-if="catalog.total.value === 0" class="empty-state-shell">
      <div class="empty-state-icon" aria-hidden="true">{ }</div>
      <div class="empty-state-copy">
        <h3>创建第一个 Skill</h3>
        <p>
          Skill 将结构化测试意图、生成后的
          <code>test.spec.ts</code> 和相关文件组织在一起，便于持续审阅和维护。
        </p>
        <p class="empty-state-note">
          当前流程会生成并保存 Playwright 脚本，但不会运行测试。
        </p>
        <n-button
          type="primary"
          class="empty-state-action"
          @click="openCreateModal"
        >
          新建 Skill
        </n-button>
      </div>
    </div>

    <div v-else-if="catalog.filteredTotal.value === 0" class="no-results-state">
      <h3>没有匹配的 Skill</h3>
      <p>请尝试名称、ID 或描述中的其他关键词。</p>
      <n-button secondary type="primary" @click="catalog.clearQuery"
        >清除搜索</n-button
      >
    </div>

    <template v-else>
      <div class="skill-grid" aria-live="polite">
        <skill-card
          v-for="skillItem in catalog.visibleSkills.value"
          :key="skillItem.id"
          :skill="skillItem"
          @open="emit('openSkill', $event)"
          @remove="openDeleteConfirm(skillItem)"
        />
      </div>

      <div v-if="paginationVisible" class="catalog-pagination">
        <n-pagination
          :page="catalog.page.value"
          :page-count="catalog.pageCount.value"
          :page-size="catalog.pageSize"
          @update:page="catalog.setPage"
        />
      </div>
    </template>

    <skill-create-modal
      v-model:show="showCreateModal"
      @success="handleCreateSuccess"
    />

    <skill-delete-confirm-modal
      :show="Boolean(pendingDelete)"
      :skill="pendingDelete"
      @update:show="
        (val) => {
          if (!val) pendingDelete = null
        }
      "
      @deleted="handleDeleted"
    />
  </section>
</template>

<style scoped>
.skill-catalog {
  padding: var(--space-md) 0;
  min-width: 0;
}

.catalog-skeleton,
.skill-grid {
  display: grid;
  gap: var(--space-md);
}

.catalog-skeleton {
  margin-top: var(--space-page);
}

.skill-grid {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  margin-top: var(--space-page);
}

.skill-grid :deep(.skill-card) {
  min-width: 0;
}

.skeleton-row {
  display: grid;
  gap: var(--space-sm);
  min-height: 96px;
  padding: var(--space-lg) var(--space-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
}

.catalog-result {
  padding: 36px 0 20px;
}

.empty-state-shell {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-section);
  min-height: 260px;
  margin-top: var(--space-lg);
  padding: 32px var(--space-section);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-soft);
  background: var(--color-canvas);
}

.empty-state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 56px;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-soft);
  background: rgb(59 130 246 / 10%);
  color: var(--color-review);
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
  font-size: 20px;
  font-weight: 700;
}

.empty-state-copy {
  max-width: 620px;
}

.empty-state-copy h3,
.no-results-state h3 {
  margin: 0 0 var(--space-sm);
  color: var(--color-ink-deep);
  font-size: 18px;
  font-weight: 600;
  text-wrap: balance;
}

.empty-state-copy p,
.no-results-state p {
  max-width: 70ch;
  margin: 0 0 var(--space-md);
  color: var(--color-ink-body);
  line-height: 1.65;
  text-wrap: pretty;
}

.empty-state-copy code {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
}

.empty-state-note {
  color: var(--color-ink-muted) !important;
  font-size: 12px;
}

.no-results-state {
  padding: 56px var(--space-section);
  margin-top: var(--space-lg);
  text-align: center;
}

.no-results-state p {
  margin-right: auto;
  margin-left: auto;
}

.catalog-pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-lg);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--color-border);
}

@media (max-width: 760px) {
  .empty-state-shell {
    align-items: flex-start;
    flex-direction: column;
    min-height: 0;
    padding: var(--space-page) var(--space-lg);
  }

  .empty-state-action {
    min-height: 44px;
  }

  .catalog-pagination {
    justify-content: center;
    overflow-x: auto;
  }
}
</style>

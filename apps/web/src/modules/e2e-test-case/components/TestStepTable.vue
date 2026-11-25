<!-- 测试步骤列表容器，统一新增、渐进展开、错误导航和步骤排序。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NEmpty, NSpace } from 'naive-ui'
import type { IE2ETestStep } from '@fynn90-e2e_assistant/types'
import {
  createStep,
  deleteStep,
  duplicateStep,
  insertStepAfter,
  moveStep,
  normalizeStepOrder,
} from '../utils/test-case-draft'
import type { TFieldErrorMap } from '../validation/test-case-form-validator'
import type { ISkillEnvFileState } from '../../skill-development/types'
import TestStepRow from './TestStepRow.vue'

const props = defineProps<{
  modelValue: IE2ETestStep[]
  errors: TFieldErrorMap
  /** env.json 最新合法状态（v10）：透传给步骤行的敏感数据下拉与失效判定。 */
  envFileState?: ISkillEnvFileState
  /** 所属 Skill 是否只读（v10）：只读时敏感数据入口按 PRD 6.1.4 处理。 */
  readOnlySkill?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: IE2ETestStep[]]
  openEnvFile: []
}>()
const draggedIndex = ref<number | null>(null)
const expandedIds = ref<Set<string>>(new Set())
const liveMessage = ref('')
const errorCursor = ref(-1)
const orderedSteps = computed(() => normalizeStepOrder(props.modelValue))
const errorStepIndexes = computed(() => {
  const indexes = new Set<number>()

  for (const path of Object.keys(props.errors)) {
    const match = /^steps\.(\d+)/.exec(path)
    if (match) indexes.add(Number(match[1]))
  }

  return [...indexes].sort((left, right) => left - right)
})
const allExpanded = computed(
  () =>
    props.modelValue.length > 0 &&
    props.modelValue.every((step) => expandedIds.value.has(step.id)),
)

watch(
  () => props.modelValue.map((step) => step.id),
  (nextIds, previousIds = []) => {
    const nextExpanded = new Set(
      [...expandedIds.value].filter((id) => nextIds.includes(id)),
    )

    if (previousIds.length === 0 && nextIds[0]) {
      nextExpanded.add(nextIds[0])
    }

    for (const id of nextIds) {
      if (!previousIds.includes(id)) nextExpanded.add(id)
    }

    expandedIds.value = nextExpanded
  },
  { immediate: true },
)

watch(errorStepIndexes, (indexes) => {
  if (indexes.length === 0) {
    errorCursor.value = -1
    return
  }

  const nextExpanded = new Set(expandedIds.value)
  for (const index of indexes) {
    const step = props.modelValue[index]
    if (step) nextExpanded.add(step.id)
  }
  expandedIds.value = nextExpanded
})

/**
 * 在列表末尾新增步骤并自动展开。
 * @returns 无返回值。
 * @throws 浏览器不支持 crypto.randomUUID 时由草稿工具抛出异常。
 */
function add(): void {
  const step = createStep(props.modelValue.length + 1)
  expandedIds.value = new Set([...expandedIds.value, step.id])
  emit('update:modelValue', [...props.modelValue, step])
  liveMessage.value = `已新增步骤 ${step.order}。`
}

/**
 * 更新指定步骤。
 * @param index 步骤索引。
 * @param value 最新步骤对象。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function update(index: number, value: IE2ETestStep): void {
  emit(
    'update:modelValue',
    props.modelValue.map((step, itemIndex) =>
      itemIndex === index ? value : step,
    ),
  )
}

/**
 * 切换指定步骤的展开状态。
 * @param stepId 稳定步骤 ID。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function toggle(stepId: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(stepId)) next.delete(stepId)
  else next.add(stepId)
  expandedIds.value = next
}

/**
 * 展开或收起全部步骤。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function toggleAll(): void {
  expandedIds.value = allExpanded.value
    ? new Set()
    : new Set(props.modelValue.map((step) => step.id))
  liveMessage.value = allExpanded.value
    ? '已展开全部步骤。'
    : '已收起全部步骤。'
}

/**
 * 在指定步骤后插入新步骤并自动展开。
 * @param index 当前步骤索引。
 * @returns 无返回值。
 * @throws 浏览器不支持 crypto.randomUUID 时由草稿工具抛出异常。
 */
function insertAfter(index: number): void {
  const next = insertStepAfter(props.modelValue, index)
  const inserted = next[index + 1]
  if (inserted) expandedIds.value = new Set([...expandedIds.value, inserted.id])
  emit('update:modelValue', next)
  liveMessage.value = `已在步骤 ${index + 1} 后插入新步骤。`
}

/**
 * 复制指定步骤并自动展开副本。
 * @param index 源步骤索引。
 * @returns 无返回值。
 * @throws 浏览器不支持 crypto.randomUUID 时由草稿工具抛出异常。
 */
function duplicate(index: number): void {
  const next = duplicateStep(props.modelValue, index)
  const duplicated = next[index + 1]
  if (duplicated)
    expandedIds.value = new Set([...expandedIds.value, duplicated.id])
  emit('update:modelValue', next)
  liveMessage.value = `已复制步骤 ${index + 1}。`
}

/**
 * 删除指定步骤并清理展开状态。
 * @param index 待删除步骤索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function remove(index: number): void {
  const removed = props.modelValue[index]
  if (removed) {
    const nextExpanded = new Set(expandedIds.value)
    nextExpanded.delete(removed.id)
    expandedIds.value = nextExpanded
  }
  emit('update:modelValue', deleteStep(props.modelValue, index))
  liveMessage.value = `已删除步骤 ${index + 1}。`
}

/**
 * 按相对偏移移动步骤，并宣布新的顺序。
 * @param index 当前步骤索引。
 * @param offset 目标相对偏移。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function move(index: number, offset: number): void {
  const targetIndex = index + offset
  const next = moveStep(props.modelValue, index, targetIndex)
  emit('update:modelValue', next)
  if (next !== props.modelValue) {
    liveMessage.value = `步骤 ${index + 1} 已移动到第 ${targetIndex + 1} 项。`
  }
}

/**
 * 将拖拽中的步骤移动到目标位置。
 * @param targetIndex 目标步骤索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function drop(targetIndex: number): void {
  if (draggedIndex.value === null) return
  const sourceIndex = draggedIndex.value
  emit(
    'update:modelValue',
    moveStep(props.modelValue, sourceIndex, targetIndex),
  )
  draggedIndex.value = null
  liveMessage.value = `步骤 ${sourceIndex + 1} 已移动到第 ${targetIndex + 1} 项。`
}

/**
 * 定位下一个包含错误的步骤并聚焦首个错误字段。
 * @returns 聚焦完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function focusNextError(): Promise<void> {
  if (errorStepIndexes.value.length === 0) return
  errorCursor.value = (errorCursor.value + 1) % errorStepIndexes.value.length
  const stepIndex = errorStepIndexes.value[errorCursor.value]
  if (stepIndex === undefined) return
  const step = props.modelValue[stepIndex]
  if (step) expandedIds.value = new Set([...expandedIds.value, step.id])
  await nextTick()
  const target =
    document.querySelector<HTMLElement>(
      `[id^="e2e-step-${stepIndex}-"][aria-invalid="true"]`,
    ) ?? document.getElementById(`e2e-step-${stepIndex}-header`)
  target?.focus()
  target?.scrollIntoView({ block: 'center', behavior: 'auto' })
  liveMessage.value = `已定位到步骤 ${stepIndex + 1} 的校验错误。`
}

/**
 * 展开指定步骤，供页面级校验摘要随后聚焦内部控件。
 * @param index 目标步骤索引。
 * @returns DOM 更新完成后兑现的 Promise。
 * @throws 不抛出异常。
 */
async function revealStep(index: number): Promise<void> {
  const step = props.modelValue[index]
  if (!step) return
  expandedIds.value = new Set([...expandedIds.value, step.id])
  await nextTick()
}

defineExpose({ revealStep })
</script>

<template>
  <section
    id="e2e-steps-section"
    class="steps-section"
    aria-labelledby="steps-title"
  >
    <header class="section-header">
      <div>
        <h3 id="steps-title">测试步骤与预期</h3>
        <p>每个步骤只描述一个主要动作，并填写可观察、可断言的预期结果。</p>
      </div>
      <n-button type="primary" @click="add">新增步骤</n-button>
    </header>
    <div v-if="modelValue.length" class="list-toolbar">
      <n-space :wrap="true" :size="8">
        <n-button size="small" secondary @click="toggleAll">
          {{ allExpanded ? '收起全部' : '展开全部' }}
        </n-button>
        <n-button
          v-if="errorStepIndexes.length"
          size="small"
          type="error"
          secondary
          @click="focusNextError"
        >
          定位错误步骤（{{ errorStepIndexes.length }}）
        </n-button>
      </n-space>
      <span
        >{{ modelValue.length }} 个步骤 ·
        {{ modelValue.filter((step) => step.enabled).length }} 个已启用</span
      >
    </div>
    <n-alert v-if="errors.steps" type="error" :show-icon="true">{{
      errors.steps
    }}</n-alert>
    <n-empty
      v-if="modelValue.length === 0"
      description="暂无测试步骤。添加至少一个启用步骤后即可生成 Playwright 脚本。"
    />
    <div v-else class="step-list">
      <test-step-row
        v-for="(step, index) in orderedSteps"
        :key="step.id"
        :step="step"
        :index="index"
        :total="modelValue.length"
        :errors="errors"
        :expanded="expandedIds.has(step.id)"
        :env-file-state="props.envFileState"
        :read-only-skill="props.readOnlySkill"
        @toggle="toggle(step.id)"
        @update="update(index, $event)"
        @insert-after="insertAfter(index)"
        @duplicate="duplicate(index)"
        @remove="remove(index)"
        @move="move(index, $event)"
        @dragstart="draggedIndex = $event"
        @drop="drop"
        @open-env-file="emit('openEnvFile')"
      />
    </div>
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ liveMessage }}
    </p>
  </section>
</template>

<style scoped>
.steps-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.section-header,
.list-toolbar {
  display: flex;
  justify-content: space-between;
  gap: var(--space-lg);
}

.section-header {
  align-items: flex-start;
}

.section-header h3 {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 17px;
}

.section-header p {
  margin: var(--space-xs) 0 0;
  color: var(--color-ink-muted);
}

.list-toolbar {
  align-items: center;
  padding-block: var(--space-xs);
  color: var(--color-ink-muted);
  font-size: 12px;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

/* .sr-only 播报样式使用 style.css 中的全局工具类（fixed 定位，不影响滚动） */

@media (max-width: 720px) {
  .section-header,
  .list-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
}
@media (pointer: coarse), (max-width: 760px) {
  .section-header :deep(.n-button),
  .list-toolbar :deep(.n-button) {
    min-height: 44px;
  }
}
</style>

<!-- 编辑 E2E 前置条件列表，支持稳定 ID、键盘移动、拖拽排序、长文本描述与动态插入敏感数据引用（v10）。 -->
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSelect, NSpace } from 'naive-ui'
import {
  ENV_REFERENCE_PATTERN,
  type IE2EPrecondition,
} from '@fynn90-e2e_assistant/types'
import { createPrecondition } from '../utils/test-case-draft'
import {
  fieldErrorsForPrefix,
  type TFieldErrorMap,
} from '../validation/test-case-form-validator'
import type { ISkillEnvFileState } from '../../skill-development/types'

const props = defineProps<{
  modelValue: IE2EPrecondition[]
  errors: TFieldErrorMap
  /** env.json 最新合法状态（v10）：插入引用下拉的数据源与失效判定。 */
  envFileState?: ISkillEnvFileState
  /** 所属 Skill 是否只读（v10）：env.json 缺失且只读时插入入口置灰。 */
  readOnlySkill?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: IE2EPrecondition[]]
  openEnvFile: []
}>()
const draggedIndex = ref<number | null>(null)
const liveMessage = ref('')
/** 插入引用下拉的受控值：恒为 null（选中即插入并复位，可连续插入，PRD I1/I4）。 */
const insertSelectValue = ref<string | null>(null)

/**
 * 在列表末尾新增一个空前置条件。
 * @returns 无返回值。
 * @throws 浏览器不支持 crypto.randomUUID 时由草稿工具抛出异常。
 */
function add(): void {
  emit('update:modelValue', [...props.modelValue, createPrecondition()])
}

/**
 * 更新指定前置条件的描述。
 * @param index 前置条件在当前列表中的索引。
 * @param description 最新描述。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function update(index: number, description: string): void {
  emit(
    'update:modelValue',
    props.modelValue.map((item, itemIndex) =>
      itemIndex === index ? { ...item, description } : item,
    ),
  )
}

/**
 * 删除指定前置条件。
 * @param index 待删除项索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function remove(index: number): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, itemIndex) => itemIndex !== index),
  )
  liveMessage.value = `已删除前置条件 ${index + 1}。`
}

/**
 * 按相对偏移移动前置条件。
 * @param index 当前项索引。
 * @param offset 目标相对偏移，-1 为上移，1 为下移。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function move(index: number, offset: number): void {
  moveTo(index, index + offset)
}

/**
 * 将前置条件移动到目标索引，并向辅助技术宣布结果。
 * @param index 当前项索引。
 * @param target 目标索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function moveTo(index: number, target: number): void {
  if (target < 0 || target >= props.modelValue.length || target === index)
    return
  const next = [...props.modelValue]
  const [item] = next.splice(index, 1)
  if (!item) return
  next.splice(target, 0, item)
  emit('update:modelValue', next)
  liveMessage.value = `前置条件 ${index + 1} 已移动到第 ${target + 1} 项。`
}

/**
 * 将拖拽中的前置条件放置到目标位置。
 * @param targetIndex 目标索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function drop(targetIndex: number): void {
  if (draggedIndex.value === null) return
  moveTo(draggedIndex.value, targetIndex)
  draggedIndex.value = null
}

/**
 * 获取除主描述字段外仍需单独呈现的行级错误。
 * @param index 前置条件索引。
 * @returns 去除重复描述错误后的错误数组。
 * @throws 不抛出异常。
 */
function otherRowErrors(index: number): string[] {
  const descriptionError = props.errors[`preconditions.${index}.description`]
  return fieldErrorsForPrefix(props.errors, `preconditions.${index}`).filter(
    (message) => message !== descriptionError,
  )
}

// ---------------------------------------------------------------------------
// 动态插入敏感数据引用（v10，PRD 6.2.2）
// ---------------------------------------------------------------------------

/** 插入引用下拉的可选 key（env.json 最新合法内容，字母序）；n-select 需要对象形态选项。 */
const envKeyOptions = computed(() =>
  (props.envFileState?.keys.value ?? []).map((key) => ({
    label: key,
    value: key,
  })),
)

/** 插入引用入口是否置灰：仅 env.json 缺失且 Skill 只读时（PRD 6.2.4）。 */
const insertDisabled = computed(() =>
  Boolean(
    props.readOnlySkill && props.envFileState?.status.value === 'missing',
  ),
)

/** 插入引用入口置灰时的原因提示。 */
const insertDisabledTitle = computed(() =>
  insertDisabled.value
    ? 'env.json 缺失，且当前 Skill 为只读，无法创建'
    : undefined,
)

/** env.json 为空对象时的行内提示（PRD 6.2.4）。 */
const emptyEnvHintVisible = computed(
  () =>
    props.envFileState?.status.value === 'ok' &&
    envKeyOptions.value.length === 0,
)

/** env.json 格式非法时的行内提示（PRD 6.2.4）。 */
const invalidEnvHintVisible = computed(
  () => props.envFileState?.status.value === 'invalid',
)

/**
 * 收集单条前置条件描述中失效的 env key（PRD 6.2.3）。
 *
 * 手输与插入的占位符同等识别（PRD I6）；同一条内多个失效 key 合并展示。
 * @param description 前置条件描述文本。
 * @returns 失效 key 列表（去重保序）；env.json 未就绪时返回空数组。
 * @throws 不抛出异常。
 */
function invalidKeysFor(description: string): string[] {
  const envState = props.envFileState
  if (!envState || envState.status.value !== 'ok') return []

  const missing = [...description.matchAll(ENV_REFERENCE_PATTERN)]
    .map((match) => match[1])
    .filter(
      (key): key is string =>
        Boolean(key) && !envState.keys.value.includes(key),
    )
  return [...new Set(missing)]
}

/**
 * 在指定前置条件描述中插入 `${ENV:KEY}` 占位符（PRD I1–I3）。
 *
 * 插入位置：描述框当前持有光标时插入光标处；未持有光标时追加到文本末尾。
 * 插入后光标停在占位符之后，可继续输入；下拉自动复位（受控值恒为 null）。
 * @param index 前置条件索引。
 * @param rawKey 选中的 env key；空值忽略。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
async function insertReference(
  index: number,
  rawKey: string | number | null,
): Promise<void> {
  const key = rawKey === null ? null : String(rawKey)
  if (!key) return
  const item = props.modelValue[index]
  if (!item) return

  const snippet = `\${ENV:${key}}`
  const inputId = `e2e-precondition-${index}-description`
  const element = document.getElementById(inputId) as HTMLTextAreaElement | null
  let next: string
  let caret: number

  if (
    element &&
    document.activeElement === element &&
    typeof element.selectionStart === 'number'
  ) {
    // 输入框持有光标：插入到光标所在位置（I2）。
    const start = element.selectionStart
    const end = element.selectionEnd ?? start
    next =
      item.description.slice(0, start) + snippet + item.description.slice(end)
    caret = start + snippet.length
  } else {
    // 未持有光标（如直接点下拉）：追加到文本末尾（I2）。
    next = item.description + snippet
    caret = next.length
  }

  update(index, next)

  // 插入后恢复焦点并把光标置于占位符之后（I3），用户可继续输入后续文字。
  await nextTick()
  const inserted = document.getElementById(
    inputId,
  ) as HTMLTextAreaElement | null
  if (inserted) {
    inserted.focus()
    inserted.setSelectionRange(caret, caret)
  }
}
</script>

<template>
  <section class="preconditions-section" aria-labelledby="preconditions-title">
    <header class="section-header">
      <div>
        <h3 id="preconditions-title">前置条件</h3>
        <p>描述执行用例前必须满足的状态或数据条件。</p>
      </div>
      <n-button type="primary" secondary @click="add">新增前置条件</n-button>
    </header>
    <n-empty
      v-if="modelValue.length === 0"
      description="暂无前置条件，可按需添加执行前必须满足的状态。"
    />
    <n-space v-else vertical :size="12">
      <article
        v-for="(item, index) in modelValue"
        :key="item.id"
        class="condition-item"
        @dragover.prevent
        @drop.prevent="drop(index)"
      >
        <div class="condition-row">
          <span
            class="condition-index"
            draggable="true"
            :aria-label="`拖动前置条件 ${index + 1} 排序`"
            title="拖动排序"
            @dragstart="draggedIndex = index"
            @dragend="draggedIndex = null"
          >
            <span aria-hidden="true">⋮⋮</span> {{ index + 1 }}
          </span>
          <div class="condition-input">
            <n-input
              :value="item.description"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
              placeholder="例如：系统中存在一个可用测试账号，密码使用 ${ENV:E2E_PASSWORD}"
              :input-props="{
                id: `e2e-precondition-${index}-description`,
                'aria-label': `前置条件 ${index + 1} 描述`,
                'aria-invalid': Boolean(
                  errors[`preconditions.${index}.description`],
                ),
                'aria-describedby': errors[`preconditions.${index}.description`]
                  ? `e2e-precondition-${index}-error`
                  : undefined,
              }"
              @update:value="update(index, $event)"
            />
            <span
              v-if="errors[`preconditions.${index}.description`]"
              :id="`e2e-precondition-${index}-error`"
              class="field-error"
            >
              {{ errors[`preconditions.${index}.description`] }}
            </span>
            <!-- 引用失效的条件级警示（PRD 6.2.3）：同条多个失效 key 合并展示，不阻断保存 -->
            <p
              v-if="invalidKeysFor(item.description).length"
              class="reference-warning"
            >
              本条引用的 key
              {{
                invalidKeysFor(item.description)
                  .map((key) => `"${key}"`)
                  .join('、')
              }}
              在 env.json 中不存在
            </p>
            <!-- 动态插入敏感数据引用入口（PRD 6.2.2）：选中即插入并复位（受控值恒为 null），可连续插入 -->
            <div class="reference-insert">
              <n-select
                :value="insertSelectValue"
                :options="envKeyOptions"
                filterable
                clearable
                :disabled="insertDisabled"
                :title="insertDisabledTitle"
                placeholder="插入敏感数据引用"
                :aria-label="`前置条件 ${index + 1} 插入敏感数据引用`"
                @update:value="insertReference(index, $event)"
              />
            </div>
            <p v-if="emptyEnvHintVisible" class="reference-hint">
              env.json 中尚未定义任何 key，请先在 env.json 中添加。
              <a href="#" @click.prevent="emit('openEnvFile')">打开 env.json</a>
            </p>
            <p v-else-if="invalidEnvHintVisible" class="reference-hint">
              env.json 当前存在格式错误，无法读取 key 列表。
              <a href="#" @click.prevent="emit('openEnvFile')">打开 env.json</a>
            </p>
            <n-alert
              v-if="otherRowErrors(index).length"
              type="error"
              class="row-errors"
            >
              {{ otherRowErrors(index).join('；') }}
            </n-alert>
          </div>
          <n-space :wrap="false" class="condition-actions">
            <n-button
              size="small"
              :disabled="index === 0"
              @click="move(index, -1)"
              >上移</n-button
            >
            <n-button
              size="small"
              :disabled="index === modelValue.length - 1"
              @click="move(index, 1)"
              >下移</n-button
            >
            <n-button size="small" type="error" secondary @click="remove(index)"
              >删除</n-button
            >
          </n-space>
        </div>
      </article>
    </n-space>
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ liveMessage }}
    </p>
  </section>
</template>

<style scoped>
.preconditions-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-lg);
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

.condition-item {
  padding: var(--space-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-brand);
  background: var(--color-surface);
}

.condition-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto;
  gap: var(--space-md);
  align-items: start;
}

.condition-index {
  padding-top: 6px;
  color: var(--color-ink-muted);
  font-weight: 600;
  cursor: grab;
}

.condition-input {
  min-width: 0;
}

.field-error {
  display: block;
  margin-top: var(--space-xs);
  color: var(--color-danger);
  font-size: 12px;
}

/* 引用失效的条件级警示（PRD 6.2.3）：警告色，非阻断 */
.reference-warning {
  margin: var(--space-xs) 0 0;
  color: var(--color-warning, #b45309);
  font-size: 12px;
}

/* 插入敏感数据引用入口：位于描述输入框下方（PRD 6.2.2） */
.reference-insert {
  margin-top: var(--space-xs);
  max-width: 360px;
}

.reference-hint {
  margin: var(--space-xs) 0 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}

.reference-hint a {
  color: var(--color-review);
}

.row-errors {
  margin-top: var(--space-sm);
}

.condition-actions :deep(.n-button) {
  min-width: 40px;
  min-height: 24px;
}

/* .sr-only 播报样式使用 style.css 中的全局工具类（fixed 定位，不影响滚动） */

@media (max-width: 720px) {
  .section-header {
    align-items: stretch;
    flex-direction: column;
  }

  .condition-row {
    grid-template-columns: 40px minmax(0, 1fr);
  }

  .condition-actions {
    grid-column: 2;
  }
}

@media (pointer: coarse), (max-width: 760px) {
  .section-header :deep(.n-button),
  .condition-input :deep(.n-input),
  .condition-actions :deep(.n-button) {
    min-height: 44px;
  }
}
</style>

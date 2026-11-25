<!-- 单个测试步骤的渐进式编辑行，负责核心字段、启用状态、次级操作和测试数据。v10 起测试数据为「数据键 · 数据类型（常量/敏感数据）· 数据值」三段式：敏感数据行的值是 env.json key 选择器，并对疑似敏感明文的常量行给出非阻断软提醒。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDropdown,
  NInput,
  NSelect,
  NSwitch,
  type DropdownOption,
  type SelectOption,
} from 'naive-ui'
import {
  buildSensitiveReferenceValue,
  isSensitiveTestDataEntry,
  isUnselectedSensitiveEntry,
  SENSITIVE_ROW_UNSELECTED_VALUE,
  SUGGESTIVE_SENSITIVE_KEY_PATTERN,
  type IE2ETestStep,
} from '@authine-e2e-agent/types'
import {
  fieldErrorsForPrefix,
  type TFieldErrorMap,
} from '../validation/test-case-form-validator'
import type { ISkillEnvFileState } from '../../skill-development/types'
import { useTestDataRowIdentity } from '../composables/useTestDataRowIdentity'

const props = defineProps<{
  step: IE2ETestStep
  index: number
  total: number
  errors: TFieldErrorMap
  expanded: boolean
  /** env.json 最新合法状态（v10）：敏感行下拉数据源与失效判定。 */
  envFileState?: ISkillEnvFileState
  /** 所属 Skill 是否只读（v10）：env.json 缺失且只读时「添加敏感数据」置灰。 */
  readOnlySkill?: boolean
}>()
const emit = defineEmits<{
  update: [value: IE2ETestStep]
  toggle: []
  insertAfter: []
  duplicate: []
  remove: []
  move: [offset: number]
  dragstart: [index: number]
  drop: [index: number]
  openEnvFile: []
}>()
const testDataExpanded = ref(Object.keys(props.step.testData).length > 0)
// 行标识由 composable 派生，不写入 step.testData，避免污染持久化数据
const { rows: testDataEntries, transferRowId } = useTestDataRowIdentity(
  () => props.step.testData,
)
const rowErrors = computed(() =>
  fieldErrorsForPrefix(props.errors, `steps.${props.index}`),
)
const hasTestDataErrors = computed(() =>
  Object.keys(props.errors).some((path) =>
    path.startsWith(`steps.${props.index}.testData`),
  ),
)
const otherRowErrors = computed(() => {
  const inlineMessages = new Set(
    [
      errorFor('description'),
      errorFor('action'),
      errorFor('expectedResult'),
    ].filter((message): message is string => Boolean(message)),
  )

  return rowErrors.value.filter((message) => !inlineMessages.has(message))
})
const summary = computed(
  () => props.step.description.trim() || '尚未填写步骤描述',
)
const menuOptions = computed<DropdownOption[]>(() => [
  { label: '上移', key: 'move-up', disabled: props.index === 0 },
  {
    label: '下移',
    key: 'move-down',
    disabled: props.index === props.total - 1,
  },
  { type: 'divider', key: 'movement-divider' },
  { label: '在后面插入', key: 'insert-after' },
  { label: '复制步骤', key: 'duplicate' },
  { type: 'divider', key: 'edit-divider' },
  { label: '删除步骤', key: 'remove' },
])

watch(
  () =>
    [Object.keys(props.step.testData).length, hasTestDataErrors.value] as const,
  ([entryCount, hasErrors]) => {
    if (entryCount > 0 || hasErrors) {
      testDataExpanded.value = true
    }
  },
  { immediate: true },
)

/**
 * 更新当前步骤字段并发送新的完整步骤对象。
 * @param key 待更新的步骤字段。
 * @param value 对应字段的新值。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function update<K extends keyof IE2ETestStep>(
  key: K,
  value: IE2ETestStep[K],
): void {
  emit('update', { ...props.step, [key]: value })
}

/**
 * 获取当前步骤字段的行内错误。
 * @param field 步骤字段名称。
 * @returns 错误文案；不存在时返回 undefined。
 * @throws 不抛出异常。
 */
function errorFor(field: keyof IE2ETestStep): string | undefined {
  return props.errors[`steps.${props.index}.${String(field)}`]
}

/**
 * 在当前步骤中新增一个不重复的测试数据键（普通行）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function addTestData(): void {
  const keys = new Set(Object.keys(props.step.testData))
  let index = keys.size + 1
  let key = `key_${index}`

  while (keys.has(key)) {
    index += 1
    key = `key_${index}`
  }

  testDataExpanded.value = true
  update('testData', { ...props.step.testData, [key]: '' })
}

// ---------------------------------------------------------------------------
// 测试数据行的三段式交互（v10 第三次修订，PRD 6.1.2 / 6.1.3）
//
// 行的「数据类型」由值纯派生（无独立持久化字段，与 types 同源判定）：
//   - 值恰为完整合法 `${ENV:K}` → 敏感数据（已选择 K，键名与 K 解耦）；
//   - 值恰为未选哨兵 `${ENV:}` → 敏感数据（未选择，保存被 C5 阻断，不会落盘）；
//   - 其余 → 常量（含手输占位符过程中的中间形态，输完即实时切换为敏感行，PRD S4）。
// ---------------------------------------------------------------------------

/** 敏感行下拉的可选 key（env.json 最新合法内容，字母序）；n-select 需要对象形态选项。 */
const envKeyOptions = computed(() =>
  (props.envFileState?.keys.value ?? []).map((key) => ({
    label: key,
    value: key,
  })),
)

/** 数据类型下拉选项（PRD 6.1.2：常量为默认类型）。 */
const dataTypeOptions: SelectOption[] = [
  { label: '常量', value: 'plain' },
  { label: '敏感数据', value: 'sensitive' },
]

/** env.json 为空对象时敏感行选择器的行内提示。 */
const emptyEnvHintVisible = computed(
  () =>
    props.envFileState?.status.value === 'ok' &&
    envKeyOptions.value.length === 0,
)

/** env.json 格式非法时敏感行选择器的行内提示。 */
const invalidEnvHintVisible = computed(
  () => props.envFileState?.status.value === 'invalid',
)

/**
 * 派生指定测试数据条目的行类型（PRD 6.1.2）。
 * @param value 数据值。
 * @returns 'sensitive' 为敏感数据行（含未选择）；'plain' 为常量行。
 * @throws 不抛出异常。
 */
function rowKind(value: string): 'plain' | 'sensitive' {
  return isUnselectedSensitiveEntry(value) || isSensitiveTestDataEntry(value)
    ? 'sensitive'
    : 'plain'
}

/**
 * 生成常量行的疑似敏感数据软提醒文案（PRD 6.1.2 W1/W2）。
 *
 * 仅对常量行调用：键名命中敏感词根且值非空时命中；敏感数据行的值是引用占位符，
 * 不参与本提醒（W6）。提醒不参与 errors 体系、不阻断保存（W4）。
 * @param label 常量行键名。
 * @param value 常量行值。
 * @returns 提醒文案；不命中时返回 undefined。
 * @throws 不抛出异常。
 */
function sensitiveHintFor(label: string, value: string): string | undefined {
  const normalizedKey = label.trim()

  if (!normalizedKey || !value.trim()) return undefined
  if (!SUGGESTIVE_SENSITIVE_KEY_PATTERN.test(normalizedKey)) return undefined

  return `"${normalizedKey}" 疑似敏感数据，明文会写入 e2e_schema.json。建议将此行类型切换为“敏感数据”，引用 env.json。`
}

/**
 * 生成敏感数据行的引用失效提示（PRD 6.3）。
 * @param value 敏感数据行的值（引用占位符）。
 * @returns 失效提示文案；引用有效或尚无 env 状态时返回 undefined。
 * @throws 不抛出异常。
 */
function missingReferenceHintFor(value: string): string | undefined {
  const envState = props.envFileState
  const key = selectedEnvKeyOf(value)

  if (!envState || envState.status.value !== 'ok' || !key) return undefined
  if (envState.keys.value.includes(key)) return undefined

  return `引用的 key "${key}" 在 env.json 中不存在`
}

/**
 * 切换行的数据类型（PRD 6.1.3 S1/S2）。
 *
 * 常量 → 敏感数据：原明文值丢弃，进入「未选择 key」中间态（哨兵值）；
 * 敏感数据 → 常量：引用丢弃，值清空，恢复自由输入。
 * @param entryIndex 测试数据条目索引。
 * @param kind 目标类型（'plain' | 'sensitive'）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function changeRowKind(entryIndex: number, kind: string | number | null): void {
  const entries = [...testDataEntries.value]
  const current = entries[entryIndex]

  if (!current) return

  const nextKind = kind === 'sensitive' ? 'sensitive' : 'plain'
  if (rowKind(current.value) === nextKind) return

  entries[entryIndex] = {
    ...current,
    value: nextKind === 'sensitive' ? SENSITIVE_ROW_UNSELECTED_VALUE : '',
  }
  update(
    'testData',
    Object.fromEntries(entries.map((row) => [row.label, row.value])),
  )
}

/**
 * 敏感数据行选中 env key：把该行落为数据契约形态 `{ 键名: '${ENV:KEY}' }`（键名不变）。
 * @param entryIndex 测试数据条目索引。
 * @param key 选中的 env key；空值（清除选择）回到未选中间态。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function selectSensitiveKey(
  entryIndex: number,
  rawKey: string | number | null,
): void {
  const entries = [...testDataEntries.value]
  const current = entries[entryIndex]

  if (!current) return

  entries[entryIndex] = {
    ...current,
    value:
      rawKey === null || rawKey === ''
        ? SENSITIVE_ROW_UNSELECTED_VALUE
        : buildSensitiveReferenceValue(String(rawKey)),
  }
  update(
    'testData',
    Object.fromEntries(entries.map((row) => [row.label, row.value])),
  )
}

/**
 * 读取敏感数据行当前选中的 env key（供选择器回显）。
 * @param value 敏感数据行的值。
 * @returns 已选择时返回 env key；未选择（哨兵）时返回 null。
 * @throws 不抛出异常。
 */
function selectedEnvKeyOf(value: string): string | null {
  if (isUnselectedSensitiveEntry(value)) return null
  return /^\$\{ENV:([A-Z_][A-Z0-9_]*)\}$/.exec(value.trim())?.[1] ?? null
}

/**
 * 更新测试数据键，遇到重复键时保留原值。
 * 改名成功时把行标识迁移到新键名，避免该行被当作新行重建而丢失输入焦点。
 * @param entryIndex 测试数据条目索引。
 * @param nextKey 新的键名。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateTestDataKey(entryIndex: number, nextKey: string): void {
  const entries = [...testDataEntries.value]
  const current = entries[entryIndex]

  if (
    !current ||
    (nextKey !== current.label && Object.hasOwn(props.step.testData, nextKey))
  ) {
    return
  }

  transferRowId(current.label, nextKey)
  entries[entryIndex] = { ...current, label: nextKey }
  update(
    'testData',
    Object.fromEntries(entries.map((row) => [row.label, row.value])),
  )
}

/**
 * 更新测试数据值。
 * @param entryIndex 测试数据条目索引。
 * @param value 新的测试数据值。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateTestDataValue(entryIndex: number, value: string): void {
  const entries = [...testDataEntries.value]
  const current = entries[entryIndex]
  if (!current) return
  entries[entryIndex] = { ...current, value }
  update(
    'testData',
    Object.fromEntries(entries.map((row) => [row.label, row.value])),
  )
}

/**
 * 删除指定测试数据条目。
 * @param entryIndex 测试数据条目索引。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function removeTestData(entryIndex: number): void {
  update(
    'testData',
    Object.fromEntries(
      testDataEntries.value
        .filter((_, index) => index !== entryIndex)
        .map((row) => [row.label, row.value]),
    ),
  )
}

/**
 * 将更多操作菜单选择转换为显式步骤事件。
 * @param key 菜单操作键。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleMenuSelect(key: string | number): void {
  switch (key) {
    case 'move-up':
      emit('move', -1)
      break
    case 'move-down':
      emit('move', 1)
      break
    case 'insert-after':
      emit('insertAfter')
      break
    case 'duplicate':
      emit('duplicate')
      break
    case 'remove':
      emit('remove')
      break
  }
}
</script>

<template>
  <article
    class="step-row"
    :class="{ 'step-row--expanded': props.expanded }"
    :aria-labelledby="`e2e-step-${index}-title`"
    @dragover.prevent
    @drop.prevent="emit('drop', index)"
  >
    <header :id="`e2e-step-${index}-header`" class="step-header">
      <span
        class="step-index"
        draggable="true"
        :aria-label="`拖动步骤 ${step.order} 排序`"
        title="拖动排序"
        @dragstart="emit('dragstart', index)"
      >
        <span aria-hidden="true">⋮⋮</span>
        <span>{{ step.order }}</span>
      </span>
      <button
        type="button"
        class="step-summary"
        :aria-expanded="props.expanded"
        :aria-controls="`e2e-step-${index}-content`"
        @click="emit('toggle')"
      >
        <strong :id="`e2e-step-${index}-title`">{{ summary }}</strong>
        <span>{{ props.expanded ? '收起步骤' : '展开编辑' }}</span>
      </button>
      <label class="enabled-control">
        <n-switch
          :value="step.enabled"
          :aria-label="`${step.enabled ? '停用' : '启用'}步骤 ${step.order}`"
          @update:value="update('enabled', $event)"
        />
        <span>{{ step.enabled ? '已启用' : '已停用' }}</span>
      </label>
      <n-dropdown
        trigger="click"
        placement="bottom-end"
        :options="menuOptions"
        @select="handleMenuSelect"
      >
        <n-button
          quaternary
          class="more-actions"
          :aria-label="`步骤 ${step.order} 更多操作`"
        >
          更多操作
        </n-button>
      </n-dropdown>
    </header>

    <div
      v-if="props.expanded"
      :id="`e2e-step-${index}-content`"
      class="step-content"
    >
      <label class="step-field">
        <span>步骤描述</span>
        <n-input
          :value="step.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          placeholder="例如：打开登录页面"
          :input-props="{
            id: `e2e-step-${index}-description`,
            'aria-invalid': Boolean(errorFor('description')),
            'aria-describedby': errorFor('description')
              ? `e2e-step-${index}-description-error`
              : undefined,
          }"
          @update:value="update('description', $event)"
        />
        <small
          v-if="errorFor('description')"
          :id="`e2e-step-${index}-description-error`"
        >
          {{ errorFor('description') }}
        </small>
      </label>
      <label class="step-field">
        <span>操作动作</span>
        <n-input
          :value="step.action"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="例如：填写账号密码并提交"
          :input-props="{
            id: `e2e-step-${index}-action`,
            'aria-invalid': Boolean(errorFor('action')),
            'aria-describedby': errorFor('action')
              ? `e2e-step-${index}-action-error`
              : undefined,
          }"
          @update:value="update('action', $event)"
        />
        <small v-if="errorFor('action')" :id="`e2e-step-${index}-action-error`">
          {{ errorFor('action') }}
        </small>
      </label>
      <label class="step-field">
        <span>预期结果</span>
        <n-input
          :value="step.expectedResult"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="例如：进入工作台并显示用户名"
          :input-props="{
            id: `e2e-step-${index}-expectedResult`,
            'aria-invalid': Boolean(errorFor('expectedResult')),
            'aria-describedby': errorFor('expectedResult')
              ? `e2e-step-${index}-expected-result-error`
              : undefined,
          }"
          @update:value="update('expectedResult', $event)"
        />
        <small
          v-if="errorFor('expectedResult')"
          :id="`e2e-step-${index}-expected-result-error`"
        >
          {{ errorFor('expectedResult') }}
        </small>
      </label>

      <section
        class="test-data-editor"
        :class="{ 'test-data-editor--open': testDataExpanded }"
      >
        <header>
          <button
            :id="`e2e-step-${index}-test-data`"
            type="button"
            class="test-data-toggle"
            :aria-expanded="testDataExpanded"
            :aria-controls="`e2e-step-${index}-test-data-content`"
            @click="testDataExpanded = !testDataExpanded"
          >
            <strong>测试数据</strong>
            <span>{{
              testDataExpanded
                ? '收起'
                : testDataEntries.length
                  ? `${testDataEntries.length} 项`
                  : '按需添加'
            }}</span>
          </button>
          <n-button v-if="testDataExpanded" size="small" @click="addTestData"
            >添加数据</n-button
          >
        </header>
        <div
          v-if="testDataExpanded"
          :id="`e2e-step-${index}-test-data-content`"
        >
          <n-alert v-if="hasTestDataErrors" type="error" :show-icon="false">
            请修复下方测试数据键后再保存。
          </n-alert>
          <!-- key 使用行稳定标识 _id：键名可被逐字符编辑，下标会在删除后改变含义，二者都不能作为 key -->
          <template
            v-for="({ _id, label, value }, entryIndex) in testDataEntries"
            :key="_id"
          >
            <!-- 三段式行：数据键 · 数据类型（常量/敏感数据）· 数据值（随类型变化，PRD 6.1.2） -->
            <div class="test-data-row">
              <n-input
                :value="label"
                placeholder="数据键"
                :input-props="{
                  'aria-label': `步骤 ${step.order} 测试数据键 ${entryIndex + 1}`,
                }"
                @update:value="updateTestDataKey(entryIndex, $event)"
              />
              <n-select
                :value="rowKind(value)"
                :options="dataTypeOptions"
                class="type-select"
                :aria-label="`步骤 ${step.order} 测试数据类型 ${entryIndex + 1}`"
                @update:value="changeRowKind(entryIndex, $event)"
              />
              <!-- 敏感数据行：值位置为 env.json key 选择器，全程不接触值（PRD 6.1.3） -->
              <n-select
                v-if="rowKind(value) === 'sensitive'"
                :value="selectedEnvKeyOf(value)"
                :options="envKeyOptions"
                filterable
                clearable
                placeholder="选择 env.json 的 key"
                :aria-label="`步骤 ${step.order} 敏感数据引用 ${entryIndex + 1}`"
                @update:value="selectSensitiveKey(entryIndex, $event)"
              />
              <!-- 常量行：自由文本值（输完完整占位符会实时切换为敏感行，PRD S4） -->
              <n-input
                v-else
                :value="value"
                placeholder="数据值"
                :input-props="{
                  'aria-label': `步骤 ${step.order} 测试数据值 ${entryIndex + 1}`,
                }"
                @update:value="updateTestDataValue(entryIndex, $event)"
              />
              <n-button
                size="small"
                type="error"
                secondary
                @click="removeTestData(entryIndex)"
              >
                删除
              </n-button>
            </div>
            <!-- 常量行：疑似敏感明文的非阻断软提醒（PRD 6.1.2 W1–W4），实时出现与消失 -->
            <p
              v-if="
                rowKind(value) === 'plain' && sensitiveHintFor(label, value)
              "
              class="hint-warning"
            >
              {{ sensitiveHintFor(label, value) }}
            </p>
            <!-- 敏感数据行的行级提示：未选择 key（C5）、引用失效（PRD 6.3）、空数据源引导（PRD 6.1.4） -->
            <div
              v-if="rowKind(value) === 'sensitive'"
              class="test-data-row-hints"
            >
              <p v-if="!selectedEnvKeyOf(value)" class="hint-warning">
                敏感数据未选择 env.json 中的 key
              </p>
              <p
                v-else-if="missingReferenceHintFor(value)"
                class="hint-warning"
              >
                {{ missingReferenceHintFor(value) }}
              </p>
              <p v-if="emptyEnvHintVisible" class="hint-muted">
                env.json 中尚未定义任何 key，请先在 env.json 中添加。
                <a href="#" @click.prevent="emit('openEnvFile')"
                  >打开 env.json</a
                >
              </p>
              <p v-else-if="invalidEnvHintVisible" class="hint-muted">
                env.json 当前存在格式错误，无法读取 key 列表。
                <a href="#" @click.prevent="emit('openEnvFile')"
                  >打开 env.json</a
                >
              </p>
            </div>
          </template>
          <n-button
            v-if="testDataEntries.length === 0"
            secondary
            @click="addTestData"
          >
            添加第一项测试数据
          </n-button>
        </div>
      </section>

      <n-alert v-if="otherRowErrors.length" type="error" class="row-errors">
        {{ otherRowErrors.join('；') }}
      </n-alert>
    </div>
  </article>
</template>

<style scoped>
.step-row {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-brand);
  background: var(--color-surface);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.step-row:focus-within {
  border-color: var(--color-review);
}

.step-row--expanded {
  box-shadow: 0 2px 8px rgb(15 23 42 / 4%);
}

.step-header {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-md);
  min-height: 56px;
  padding: var(--space-sm) var(--space-md);
}

.step-index {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-ink-muted);
  font-weight: 700;
  cursor: grab;
}

.step-summary {
  min-height: 24px;
}

.step-summary,
.test-data-toggle {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-ink-body);
  text-align: start;
  cursor: pointer;
}

.step-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-md);
}

.step-summary strong {
  overflow: hidden;
  color: var(--color-ink-deep);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.step-summary span,
.enabled-control span,
.test-data-toggle span {
  color: var(--color-ink-muted);
  font-size: 12px;
}

.enabled-control {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  min-height: 24px;
  white-space: nowrap;
}

.more-actions {
  min-height: 32px;
}

.step-content {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(240px, 1.2fr) minmax(
      240px,
      1.2fr
    );
  gap: var(--space-md);
  padding: var(--space-md);
  border-top: 1px solid var(--color-border);
  background: var(--color-canvas);
}

.step-field {
  min-width: 0;
  color: var(--color-ink-body);
  font-size: 13px;
  font-weight: 600;
}

.step-field > span {
  display: block;
  margin-bottom: 6px;
}

.step-field small {
  display: block;
  margin-top: var(--space-xs);
  color: var(--color-danger);
  font-weight: 400;
}

.test-data-editor,
.row-errors {
  grid-column: 1 / -1;
}

.test-data-editor {
  padding-top: var(--space-md);
  border-top: 1px solid var(--color-border);
}

.test-data-editor > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
}

.test-data-toggle {
  display: flex;
  align-items: baseline;
  gap: var(--space-sm);
  min-height: 32px;
}

.test-data-row {
  display: grid;
  /* 三段式：数据键 · 数据类型（固定窄列）· 数据值 + 删除按钮（PRD 6.1.2） */
  grid-template-columns: minmax(110px, 0.4fr) 108px minmax(160px, 1fr) auto;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

/* 行级提示区：软提醒 / 失效警示 / 空数据源引导 */
.test-data-row-hints {
  margin-top: 2px;
}

.test-data-row-hints p {
  margin: 2px 0 0;
  font-size: 12px;
}

/* 警告色软提醒：非阻断引导（W2），与错误色区分 */
.hint-warning {
  color: var(--color-warning, #b45309);
}

/* 中性引导文案（空数据源 / 格式错误，PRD 6.1.4） */
.hint-muted {
  color: var(--color-ink-muted);
}

.hint-muted a {
  color: var(--color-review);
}

@media (max-width: 980px) {
  .step-header {
    grid-template-columns: 40px minmax(0, 1fr) auto;
  }

  .more-actions {
    grid-column: 3;
    grid-row: 2;
  }

  .enabled-control {
    grid-column: 2;
    grid-row: 2;
  }

  .step-content {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 620px) {
  .step-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 2px;
  }

  .step-summary strong {
    white-space: normal;
  }

  .test-data-row {
    grid-template-columns: 1fr;
  }
}

@media (pointer: coarse), (max-width: 760px) {
  .step-summary,
  .enabled-control,
  .test-data-toggle,
  .more-actions,
  .test-data-editor :deep(.n-button) {
    min-height: 44px;
  }
}
</style>

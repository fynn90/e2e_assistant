<!-- E2E 用例基础信息表单：按测试意图与执行元数据分组，并根据容器宽度自适应布局。 -->
<script setup lang="ts">
import { computed, shallowRef } from 'vue'
import { NButton, NDynamicTags, NForm, NFormItem, NInput } from 'naive-ui'
import type { IE2ETestCase } from '@fynn90-e2e_assistant/types'
import {
  fieldErrorFor,
  validateDraftForSave,
  type TFieldErrorMap,
} from '../validation/test-case-form-validator'

const props = defineProps<{
  modelValue: IE2ETestCase
  errors: TFieldErrorMap
}>()
const emit = defineEmits<{ 'update:modelValue': [value: IE2ETestCase] }>()
const localBaseUrlError = shallowRef<string>()

/**
 * 更新基础信息字段并向父组件发送新的完整用例值。
 * @param key 待更新的用例字段。
 * @param value 对应字段的新值。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function update<K extends keyof IE2ETestCase>(
  key: K,
  value: IE2ETestCase[K],
): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

/**
 * 更新目标 URL，并清除仅由失焦校验产生的旧错误。
 * @param value 最新目标 URL。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateBaseUrl(value: string): void {
  localBaseUrlError.value = undefined
  update('baseUrl', value)
}

/**
 * 在目标 URL 失焦时执行与保存流程一致的领域校验。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function validateBaseUrlOnBlur(): void {
  localBaseUrlError.value = fieldErrorFor(
    validateDraftForSave(props.modelValue),
    'baseUrl',
  )
}

const tags = computed({
  get: () => props.modelValue.tags,
  set: (value: string[]) => update('tags', value),
})
const baseUrlError = computed(
  () => props.errors.baseUrl ?? localBaseUrlError.value,
)
const tagsError = computed(() => fieldErrorFor(props.errors, 'tags'))
</script>

<template>
  <n-form label-placement="top" class="basic-form">
    <!-- Review Blue 标记用户需要审阅的测试意图，保持标题与描述为同一编辑语境。 -->
    <div
      class="basic-form__section basic-form__section--intent"
      role="group"
      aria-labelledby="e2e-intent-heading"
    >
      <div class="basic-form__section-heading">
        <span
          class="basic-form__signal basic-form__signal--review"
          aria-hidden="true"
        ></span>
        <span id="e2e-intent-heading" class="basic-form__section-label"
          >测试意图</span
        >
      </div>
      <n-form-item
        class="basic-form__field"
        label="用例标题"
        :validation-status="errors.title ? 'error' : undefined"
        :show-feedback="Boolean(errors.title)"
      >
        <n-input
          :value="modelValue.title"
          maxlength="100"
          show-count
          placeholder="例如：用户使用正确账号密码登录成功"
          :input-props="{
            id: 'e2e-title',
            'aria-label': '用例标题',
            'aria-invalid': Boolean(errors.title),
            'aria-describedby': errors.title ? 'e2e-title-error' : undefined,
          }"
          @update:value="update('title', $event)"
        />
        <template #feedback>
          <span v-if="errors.title" id="e2e-title-error">{{
            errors.title
          }}</span>
        </template>
      </n-form-item>

      <n-form-item
        class="basic-form__field"
        label="用例描述"
        :validation-status="errors.description ? 'error' : undefined"
        :show-feedback="Boolean(errors.description)"
      >
        <n-input
          type="textarea"
          :value="modelValue.description"
          maxlength="1000"
          show-count
          :autosize="{ minRows: 3, maxRows: 8 }"
          placeholder="说明测试目标、业务背景和范围"
          :input-props="{
            id: 'e2e-description',
            'aria-label': '用例描述',
            'aria-invalid': Boolean(errors.description),
            'aria-describedby': errors.description
              ? 'e2e-description-error'
              : undefined,
          }"
          @update:value="update('description', $event)"
        />
        <template #feedback>
          <span v-if="errors.description" id="e2e-description-error">{{
            errors.description
          }}</span>
        </template>
      </n-form-item>
    </div>

    <!-- Action Green 标记实际执行上下文，标签继承同一提交语义的品牌色。 -->
    <div
      class="basic-form__section basic-form__section--execution"
      role="group"
      aria-labelledby="e2e-execution-heading"
    >
      <div class="basic-form__section-heading">
        <span
          class="basic-form__signal basic-form__signal--action"
          aria-hidden="true"
        ></span>
        <span id="e2e-execution-heading" class="basic-form__section-label"
          >执行上下文</span
        >
      </div>
      <div class="basic-form__metadata">
        <n-form-item
          class="basic-form__field"
          label="目标 URL"
          :validation-status="baseUrlError ? 'error' : undefined"
          :show-feedback="Boolean(baseUrlError)"
        >
          <n-input
            :value="modelValue.baseUrl"
            placeholder="https://example.test"
            :input-props="{
              id: 'e2e-base-url',
              'aria-label': '目标 URL',
              'aria-invalid': Boolean(baseUrlError),
              'aria-describedby': baseUrlError
                ? 'e2e-base-url-error'
                : undefined,
            }"
            @update:value="updateBaseUrl"
            @blur="validateBaseUrlOnBlur"
          />
          <template #feedback>
            <span v-if="baseUrlError" id="e2e-base-url-error">{{
              baseUrlError
            }}</span>
          </template>
        </n-form-item>

        <n-form-item
          class="basic-form__field"
          label="标签"
          :validation-status="tagsError ? 'error' : undefined"
          :show-feedback="Boolean(tagsError)"
        >
          <n-dynamic-tags
            v-model:value="tags"
            type="primary"
            :input-props="{
              placeholder: '输入标签后按 Enter',
              inputProps: {
                'aria-label': '输入新标签',
                'aria-describedby': tagsError ? 'e2e-tags-error' : undefined,
              },
            }"
          >
            <template #trigger="{ activate, disabled }">
              <n-button
                id="e2e-tags-trigger"
                dashed
                type="primary"
                :disabled="disabled"
                :aria-invalid="Boolean(tagsError)"
                :aria-describedby="tagsError ? 'e2e-tags-error' : undefined"
                @click="activate"
              >
                新增标签
              </n-button>
            </template>
          </n-dynamic-tags>
          <template #feedback>
            <span v-if="tagsError" id="e2e-tags-error">{{ tagsError }}</span>
          </template>
        </n-form-item>
      </div>
    </div>
  </n-form>
</template>

<style scoped>
.basic-form {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.basic-form__section {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--space-md);
}

.basic-form__section--execution {
  padding-top: var(--space-lg);
  border-top: 1px solid var(--color-border);
}

.basic-form__section-heading {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--color-border);
}

.basic-form__section-label {
  color: var(--color-ink-deep);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}

.basic-form__signal {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.basic-form__signal--review {
  background: var(--color-review);
  box-shadow: 0 0 0 3px rgb(59 130 246 / 12%);
}

.basic-form__signal--action {
  background: var(--color-action);
  box-shadow: 0 0 0 3px rgb(12 112 62 / 12%);
}

.basic-form__metadata {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.basic-form__field {
  min-width: 0;
  margin: 0;
}

@container (min-width: 640px) {
  .basic-form {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.8fr);
    gap: var(--space-section);
    align-items: start;
  }

  .basic-form__section--execution {
    padding-top: 0;
    padding-left: var(--space-section);
    border-top: 0;
    border-left: 1px solid var(--color-border);
  }
}

@media (pointer: coarse), (max-width: 760px) {
  .basic-form :deep(.n-input:not(.n-input--textarea)),
  #e2e-tags-trigger {
    min-height: 44px;
  }
}
</style>

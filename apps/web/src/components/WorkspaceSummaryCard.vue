<!-- 系统配置摘要与编辑表单：提供精确校验、状态提示和失败后输入保留。 -->
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCode,
  NForm,
  NFormItem,
  NInput,
  NSpace,
} from 'naive-ui'
import type {
  IConfigSummary,
  IUpdateConfigRequest,
  TConfigIssue,
} from '@fynn90-e2e_assistant/types'
import {
  validateConfigUpdate,
  type TConfigFieldErrors,
  type TConfigFieldName,
} from '../modules/configuration/config-form-validator'
import DirectoryPickerField from '../modules/configuration/components/DirectoryPickerField.vue'

const props = withDefaults(
  defineProps<{
    configPath: string
    configSummary: IConfigSummary
    issues?: TConfigIssue[]
    saving?: boolean
  }>(),
  {
    issues: () => [],
    saving: false,
  },
)

const emit = defineEmits<{
  save: [payload: IUpdateConfigRequest]
}>()

const editing = ref(false)
const fieldErrors = ref<TConfigFieldErrors>({})
const formModel = reactive<IUpdateConfigRequest>({
  projectDirectory: '',
  llmApiKey: '',
  llmApiBaseUrl: '',
  llmModelName: '',
})

const readinessMessages = computed(() =>
  props.issues.map((issue) => CONFIG_ISSUE_COPY[issue]),
)

watch(
  () => props.configSummary,
  (summary) => {
    syncFormFromSummary(summary)
    editing.value = false
    fieldErrors.value = {}
  },
  { immediate: true },
)

/**
 * 进入配置编辑状态。
 * @returns 状态切换后无返回值。
 * @throws 不抛出异常。
 */
function startEditing(): void {
  editing.value = true
  fieldErrors.value = {}
}

/**
 * 取消编辑并恢复最近一次已保存配置。
 * @returns 恢复完成后无返回值。
 * @throws 不抛出异常。
 */
function cancelEditing(): void {
  editing.value = false
  fieldErrors.value = {}
  syncFormFromSummary(props.configSummary)
}

/**
 * 校验当前表单并发送规范化配置。
 * @returns 校验或事件发送完成后无返回值。
 * @throws 不抛出异常；字段错误写入本地反馈状态。
 */
function submit(): void {
  const result = validateConfigUpdate({ ...formModel })
  fieldErrors.value = result.errors

  if (result.valid && result.payload) {
    emit('save', result.payload)
  }
}

/**
 * 更新字段并清除该字段的旧错误。
 * @param fieldName 字段名称。
 * @param value 用户输入的新值。
 * @returns 更新完成后无返回值。
 * @throws 不抛出异常。
 */
function updateField(fieldName: TConfigFieldName, value: string): void {
  formModel[fieldName] = value

  if (fieldErrors.value[fieldName]) {
    const nextErrors = { ...fieldErrors.value }
    delete nextErrors[fieldName]
    fieldErrors.value = nextErrors
  }
}

/**
 * 处理项目目录选择结果并立即校验。
 *
 * 目录字段已改为弹窗选择，不再有失焦时机，因此选择后直接触发校验。
 *
 * @param directoryPath 用户新选择的项目目录绝对路径。
 * @returns 校验完成后无返回值。
 * @throws 不抛出异常。
 */
function selectProjectDirectory(directoryPath: string): void {
  updateField('projectDirectory', directoryPath)
  validateField('projectDirectory')
}

/**
 * 在字段失焦时仅展示该字段对应的确定性错误。
 * @param fieldName 需要校验的字段名称。
 * @returns 校验完成后无返回值。
 * @throws 不抛出异常。
 */
function validateField(fieldName: TConfigFieldName): void {
  const result = validateConfigUpdate({ ...formModel })
  const nextErrors = { ...fieldErrors.value }

  if (result.errors[fieldName]) {
    nextErrors[fieldName] = result.errors[fieldName]
  } else {
    delete nextErrors[fieldName]
  }

  fieldErrors.value = nextErrors
}

/**
 * 使用已保存摘要重置可编辑表单。
 * @param summary 最近一次已保存配置摘要。
 * @returns 同步完成后无返回值。
 * @throws 不抛出异常。
 */
function syncFormFromSummary(summary: IConfigSummary): void {
  formModel.projectDirectory = summary.projectDirectory
  formModel.llmApiKey = ''
  formModel.llmApiBaseUrl = summary.llmApiBaseUrl
  formModel.llmModelName = summary.llmModelName
}

/**
 * 将 ISO 时间格式化为本地展示文本。
 * @param isoTime ISO 时间字符串。
 * @returns 本地时间文本；空值或无效值返回短横线。
 * @throws 不抛出异常。
 */
function formatDisplayTime(isoTime: string): string {
  const timestamp = new Date(isoTime)
  return isoTime && !Number.isNaN(timestamp.getTime())
    ? timestamp.toLocaleString('zh-CN', { hour12: false })
    : '-'
}

const CONFIG_ISSUE_COPY: Record<TConfigIssue, string> = {
  PROJECT_DIRECTORY_MISSING: '项目目录缺失，请重新保存配置。',
  PROJECT_DIRECTORY_UNAVAILABLE: '项目目录当前不可访问或缺少读写权限。',
  LLM_API_KEY_MISSING: '大模型 API Key 缺失，Agent 能力暂不可用。',
  LLM_API_BASE_URL_INVALID: '大模型 API 地址无效，Agent 能力暂不可用。',
  LLM_MODEL_NAME_MISSING: '模型名称缺失，Agent 能力暂不可用。',
}
</script>

<template>
  <section class="config-panel">
    <header class="config-header">
      <div>
        <h2 class="config-title">基础配置</h2>
        <p class="config-description">
          管理 Skill 工作区和生成 Playwright 脚本所使用的模型连接。
        </p>
      </div>
      <n-button v-if="!editing" type="primary" secondary @click="startEditing">
        编辑配置
      </n-button>
    </header>

    <n-alert
      v-if="readinessMessages.length > 0"
      type="warning"
      :show-icon="false"
      class="readiness-alert"
    >
      <ul class="readiness-list">
        <li v-for="message in readinessMessages" :key="message">
          {{ message }}
        </li>
      </ul>
    </n-alert>

    <dl v-if="!editing" class="summary-list">
      <div class="summary-row">
        <dt>项目目录</dt>
        <dd>{{ props.configSummary.projectDirectory }}</dd>
      </div>
      <div class="summary-row">
        <dt>API Key</dt>
        <dd>{{ props.configSummary.llmApiKeyMasked }}</dd>
      </div>
      <div class="summary-row">
        <dt>API 地址</dt>
        <dd>{{ props.configSummary.llmApiBaseUrl }}</dd>
      </div>
      <div class="summary-row">
        <dt>模型名称</dt>
        <dd>{{ props.configSummary.llmModelName }}</dd>
      </div>
      <div class="summary-row">
        <dt>创建时间</dt>
        <dd>{{ formatDisplayTime(props.configSummary.createdAt) }}</dd>
      </div>
      <div class="summary-row">
        <dt>最近更新时间</dt>
        <dd>{{ formatDisplayTime(props.configSummary.updatedAt) }}</dd>
      </div>
    </dl>

    <n-form
      v-else
      label-placement="top"
      class="config-form"
      aria-label="编辑系统配置"
    >
      <n-alert
        v-if="
          formModel.projectDirectory !== props.configSummary.projectDirectory
        "
        type="warning"
        :show-icon="false"
        class="directory-alert"
      >
        保存后 Skill 列表会切换到新的项目目录；原目录中的 Skill 不会被删除。
      </n-alert>

      <n-form-item
        label="项目目录"
        :validation-status="fieldErrors.projectDirectory ? 'error' : undefined"
        :feedback="fieldErrors.projectDirectory"
      >
        <directory-picker-field
          :model-value="formModel.projectDirectory"
          :disabled="props.saving"
          placeholder="尚未选择项目目录"
          @update:model-value="selectProjectDirectory"
        />
      </n-form-item>

      <n-form-item label="大模型 API Key">
        <n-input
          :value="formModel.llmApiKey"
          type="password"
          show-password-on="click"
          placeholder="留空表示保持当前 API Key"
          :disabled="props.saving"
          @update:value="updateField('llmApiKey', $event)"
        />
        <p class="field-help">只有输入新值时才会替换当前密钥。</p>
      </n-form-item>

      <n-form-item
        label="大模型 API 地址"
        :validation-status="fieldErrors.llmApiBaseUrl ? 'error' : undefined"
        :feedback="fieldErrors.llmApiBaseUrl"
      >
        <n-input
          :value="formModel.llmApiBaseUrl"
          placeholder="例如：https://api.example.com/v1"
          :disabled="props.saving"
          @update:value="updateField('llmApiBaseUrl', $event)"
          @blur="validateField('llmApiBaseUrl')"
        />
        <p class="field-help">
          填写 API 根地址，不要包含 query、fragment 或 chat/completions。
        </p>
      </n-form-item>

      <n-form-item
        label="模型名称"
        :validation-status="fieldErrors.llmModelName ? 'error' : undefined"
        :feedback="fieldErrors.llmModelName"
      >
        <n-input
          :value="formModel.llmModelName"
          placeholder="例如：your-model-name"
          :disabled="props.saving"
          @update:value="updateField('llmModelName', $event)"
          @blur="validateField('llmModelName')"
        />
      </n-form-item>

      <n-space justify="end" class="form-actions">
        <n-button :disabled="props.saving" @click="cancelEditing"
          >取消</n-button
        >
        <n-button type="primary" :loading="props.saving" @click="submit"
          >保存配置</n-button
        >
      </n-space>
    </n-form>

    <div class="config-path-section">
      <span class="config-path-label">配置文件路径</span>
      <n-code class="config-path">{{ props.configPath }}</n-code>
    </div>
  </section>
</template>

<style scoped>
.config-panel {
  padding: var(--space-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
}

.config-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-section);
  padding-bottom: var(--space-lg);
  border-bottom: 1px solid var(--color-border);
}

.config-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  text-wrap: balance;
}

.config-description {
  max-width: 70ch;
  margin: var(--space-xs) 0 0;
  color: var(--color-ink-body);
  line-height: 1.6;
  text-wrap: pretty;
}

.readiness-alert,
.directory-alert {
  margin-top: var(--space-lg);
}

.readiness-list {
  margin: 0;
  padding-left: var(--space-section);
}

.summary-list {
  margin: 0;
}

.summary-row {
  display: grid;
  grid-template-columns: minmax(130px, 0.25fr) minmax(0, 1fr);
  gap: var(--space-lg);
  padding: var(--space-lg) 0;
  border-bottom: 1px solid var(--color-border);
}

.summary-row dt {
  color: var(--color-ink-muted);
  font-size: 13px;
  font-weight: 600;
}

.summary-row dd {
  min-width: 0;
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.config-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--space-section);
  margin-top: var(--space-lg);
}

.config-form :deep(.n-alert),
.form-actions {
  grid-column: 1 / -1;
}

.field-help {
  margin: var(--space-xs) 0 0;
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.form-actions {
  margin-top: var(--space-sm);
}

.config-path-section {
  display: grid;
  gap: var(--space-sm);
  margin-top: var(--space-section);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--color-border);
}

.config-path-label {
  color: var(--color-ink-muted);
  font-size: 12px;
  font-weight: 600;
}

.config-path {
  overflow-x: auto;
}

@media (max-width: 760px) {
  .config-header {
    flex-direction: column;
  }

  .config-header :deep(.n-button),
  .form-actions :deep(.n-button) {
    min-height: 44px;
  }

  .summary-row,
  .config-form {
    grid-template-columns: 1fr;
  }

  .summary-row {
    gap: var(--space-xs);
  }

  .form-actions {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 420px) {
  .config-panel {
    padding: var(--space-md);
  }
}
</style>

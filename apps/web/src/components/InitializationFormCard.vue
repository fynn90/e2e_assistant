<!-- 展示首次平台配置或损坏配置修复表单，并说明后续激活路径。 -->
<script setup lang="ts">
import {
  NAlert,
  NButton,
  NCard,
  NCode,
  NForm,
  NFormItem,
  NInput,
  NSpace,
} from 'naive-ui'
import DirectoryPickerField from '../modules/configuration/components/DirectoryPickerField.vue'

interface IInitializationFormCardProps {
  configPath: string
  submitting: boolean
  mode?: 'initialize' | 'repair'
}

interface IInitializationFormModel {
  projectDirectory: string
  llmApiKey: string
  llmApiBaseUrl: string
  llmModelName: string
}

const props = defineProps<
  {
    formModel: IInitializationFormModel
  } & IInitializationFormCardProps
>()

const emit = defineEmits<{
  submit: []
  update: []
}>()

/**
 * 在输入变更时通知父组件清理旧错误。
 * @returns 通知完成后无返回值。
 */
function handleInputChange(): void {
  emit('update')
}

/**
 * 同步用户选择的项目目录并通知父组件清理旧错误。
 * @param directoryPath 用户选择的项目目录绝对路径。
 * @returns 同步完成后无返回值。
 * @throws 不抛出异常。
 */
function handleProjectDirectoryChange(directoryPath: string): void {
  props.formModel.projectDirectory = directoryPath
  handleInputChange()
}

/**
 * 将提交动作转发给父组件处理。
 * @returns 触发完成后无返回值。
 */
function handleSubmit(): void {
  emit('submit')
}
</script>

<template>
  <n-card :bordered="false" size="large">
    <n-space vertical size="large">
      <div>
        <h1 class="hero-title">
          {{ props.mode === 'repair' ? '修复平台配置' : '项目初始化' }}
        </h1>
        <p class="hero-description" v-if="props.mode === 'repair'">
          当前配置损坏或项目目录不可用。请重新填写并保存；已有项目目录无需为空，API
          Key 留空时仅在旧配置可读取的情况下保持原值。
        </p>
        <p class="hero-description" v-else>
          配置一个可写的项目空目录和模型服务。完成后，你将创建或打开
          Skill、填写结构化测试意图，并在审阅代码差异后保存 Playwright
          脚本，通常需要 3–5 分钟。
        </p>
      </div>

      <n-alert type="info" :show-icon="false">
        {{
          props.mode === 'repair'
            ? '项目目录可以包含已有 Skill；保存前请确认目录可读写。'
            : '推荐输入一个空目录路径。若目录不存在，系统会自动创建；若目录中已有文件，则无法通过初始化校验。当前流程只生成、审阅并保存脚本，不会运行测试。'
        }}
      </n-alert>

      <n-form label-placement="top">
        <n-space vertical size="large">
          <n-form-item
            :label="props.mode === 'repair' ? '项目目录' : '项目空目录'"
          >
            <directory-picker-field
              :model-value="props.formModel.projectDirectory"
              :require-empty="props.mode === 'initialize'"
              :disabled="props.submitting"
              placeholder="尚未选择项目目录"
              @update:model-value="handleProjectDirectoryChange"
            />
          </n-form-item>

          <n-form-item label="大模型 API Key">
            <n-input
              v-model:value="props.formModel.llmApiKey"
              type="password"
              show-password-on="click"
              placeholder="请输入大模型 API Key"
              clearable
              @update:value="handleInputChange"
            />
          </n-form-item>

          <n-form-item label="大模型 API 地址">
            <n-input
              v-model:value="props.formModel.llmApiBaseUrl"
              placeholder="https://api.openai.com/v1"
              clearable
              @update:value="handleInputChange"
            />
          </n-form-item>

          <n-form-item label="大模型模型名称">
            <n-input
              v-model:value="props.formModel.llmModelName"
              placeholder="gpt-4.1-mini"
              clearable
              @update:value="handleInputChange"
            />
          </n-form-item>

          <n-form-item label="配置文件写入位置">
            <n-code>{{ props.configPath }}</n-code>
          </n-form-item>

          <n-button
            type="primary"
            :loading="props.submitting"
            @click="handleSubmit"
          >
            {{ props.mode === 'repair' ? '保存配置' : '提交配置' }}
          </n-button>
        </n-space>
      </n-form>
    </n-space>
  </n-card>
</template>

<style scoped>
.hero-title {
  margin: 0 0 8px;
  font-size: 28px;
  font-weight: 700;
}

.hero-description {
  margin: 0;
  color: #4b5563;
  line-height: 1.7;
}
</style>

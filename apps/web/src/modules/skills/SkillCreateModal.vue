<!-- 创建真实 Skill，并生成默认结构化 E2E 用例文件。 -->
<script setup lang="ts">
import { ref } from 'vue'
import {
  NModal,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NSpace,
} from 'naive-ui'
import type { FormInst, FormRules, FormItemRule } from 'naive-ui'
import type { ISkillSummary } from '@authine-e2e-agent/types'
import { createSkill } from '../../services/skill-api'
import { useGlobalMessage } from '../../composables/useGlobalMessage'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  success: [skill: ISkillSummary]
}>()

const message = useGlobalMessage()
const formRef = ref<FormInst | null>(null)
const submitting = ref(false)

const formModel = ref({
  title: '',
  description: '',
})

const rules: FormRules = {
  title: [
    { required: true, message: '请输入 Skill 名称', trigger: 'blur' },
    {
      min: 1,
      max: 50,
      message: '长度在 1 到 50 个字符',
      trigger: ['input', 'blur'],
    },
    {
      validator(rule: FormItemRule, value: string) {
        if (!/^[\u4e00-\u9fa5a-zA-Z0-9_\-]+$/.test(value)) {
          return new Error('仅允许中英文、数字、下划线及中划线')
        }
        return true
      },
      trigger: ['input', 'blur'],
    },
  ],
  description: [
    { max: 200, message: '最大长度 200 个字符', trigger: ['input', 'blur'] },
  ],
}

/**
 * 关闭弹窗
 */
function resetForm(): void {
  formModel.value.title = ''
  formModel.value.description = ''
}

function handleClose(): void {
  if (submitting.value) return
  emit('update:show', false)
  resetForm()
}

/**
 * 提交表单
 */
function handleSubmit(): void {
  formRef.value?.validate(async (errors) => {
    if (!errors) {
      submitting.value = true
      try {
        const response = await createSkill({
          title: formModel.value.title,
          description: formModel.value.description,
        })
        submitting.value = false
        emit('update:show', false)
        resetForm()
        message.success('创建成功')
        emit('success', response.data)
      } catch (error: unknown) {
        message.error(error instanceof Error ? error.message : '创建失败')
      } finally {
        submitting.value = false
      }
    }
  })
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="!submitting"
    @update:show="(val) => emit('update:show', val)"
    @after-leave="handleClose"
  >
    <n-card
      style="width: min(500px, calc(100vw - 32px))"
      title="新建 Skill"
      :bordered="false"
      size="huge"
      role="dialog"
      aria-modal="true"
    >
      <p class="modal-description">
        创建后会生成默认的 <code>e2e_schema.json</code> 并打开
        Skill。此步骤不会生成或运行 Playwright 脚本。
      </p>
      <n-form
        ref="formRef"
        :model="formModel"
        :rules="rules"
        label-placement="left"
        label-width="auto"
        require-mark-placement="right-hanging"
      >
        <n-form-item label="Skill 名称" path="title">
          <n-input
            v-model:value="formModel.title"
            placeholder="请输入名称 (仅中英文、数字、下划线、中划线)"
            :disabled="submitting"
          />
        </n-form-item>
        <n-form-item label="描述" path="description">
          <n-input
            v-model:value="formModel.description"
            type="textarea"
            placeholder="请输入描述 (最大 200 字符)"
            :disabled="submitting"
            :autosize="{ minRows: 3, maxRows: 5 }"
          />
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button :disabled="submitting" @click="handleClose">取消</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit">
            确认
          </n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.modal-description {
  margin: 0 0 18px;
  color: #334155;
  line-height: 1.6;
}

.modal-description code {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
}
</style>

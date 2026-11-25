<!-- 项目目录选择字段：只读展示已选路径，并通过弹窗选择目录。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import DirectoryPickerModal from './DirectoryPickerModal.vue'

const props = withDefaults(
  defineProps<{
    /** 当前已选目录路径。 */
    modelValue: string
    /** 是否要求所选目录为空目录（首次初始化场景）。 */
    requireEmpty?: boolean
    /** 是否禁用选择操作。 */
    disabled?: boolean
    /** 未选择目录时的占位提示。 */
    placeholder?: string
  }>(),
  {
    requireEmpty: false,
    disabled: false,
    placeholder: '尚未选择项目目录',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const pickerVisible = ref(false)

/**
 * 打开目录选择弹窗。
 * @returns 打开完成后无返回值。
 * @throws 不抛出异常。
 */
function openPicker(): void {
  if (props.disabled) {
    return
  }

  pickerVisible.value = true
}

/**
 * 接收弹窗确认的目录路径并向上同步。
 * @param directoryPath 用户确认的目录绝对路径。
 * @returns 同步完成后无返回值。
 * @throws 不抛出异常。
 */
function applySelectedDirectory(directoryPath: string): void {
  emit('update:modelValue', directoryPath)
}
</script>

<template>
  <div class="directory-field">
    <!-- 只读输入框承载长路径，允许横向滚动而不撑破外层栅格 -->
    <n-input
      class="directory-value"
      :value="props.modelValue"
      readonly
      :placeholder="props.placeholder"
      :title="props.modelValue"
    />
    <n-button :disabled="props.disabled" @click="openPicker">选择目录</n-button>

    <directory-picker-modal
      v-model:show="pickerVisible"
      :selected-path="props.modelValue"
      :require-empty="props.requireEmpty"
      @confirm="applySelectedDirectory"
    />
  </div>
</template>

<style scoped>
.directory-field {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  width: 100%;
}

.directory-value {
  flex: 1;
  min-width: 0;
}

@media (max-width: 640px) {
  .directory-field {
    flex-wrap: wrap;
  }

  .directory-field :deep(.n-button) {
    min-height: 44px;
  }
}
</style>

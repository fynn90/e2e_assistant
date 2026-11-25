<!-- 删除 Skill 确认弹框：向用户明确说明不可恢复的后果后才允许执行删除。 -->
<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NCard, NModal, NSpace } from 'naive-ui'
import type { ISkillSummary } from '@authine-e2e-agent/types'
import { deleteSkill } from '../../services/skill-api'
import { useGlobalMessage } from '../../composables/useGlobalMessage'

const props = defineProps<{
  show: boolean
  skill: ISkillSummary | null
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  deleted: [skillId: string]
}>()

const message = useGlobalMessage()
const submitting = ref(false)

/**
 * 关闭弹框。
 * @returns 关闭完成，并复位提交状态。
 * @throws 不抛出异常。
 */
function closeModal(): void {
  if (submitting.value) return
  emit('update:show', false)
}

/**
 * 确认删除 Skill：调用删除接口并通知列表刷新。
 * @returns 删除完成后无返回值。
 * @throws 不向调用方抛出异常；失败原因写入全局提示。
 */
async function confirmDelete(): Promise<void> {
  if (!props.skill) return
  submitting.value = true

  try {
    const response = await deleteSkill(props.skill.id)
    submitting.value = false
    emit('update:show', false)
    message.success(`已删除 Skill「${response.data.skillId}」`)
    emit('deleted', props.skill.id)
  } catch (error: unknown) {
    submitting.value = false
    message.error(
      error instanceof Error ? error.message : '删除失败，请稍后重试。',
    )
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="!submitting"
    role="dialog"
    aria-modal="true"
    @update:show="(val) => emit('update:show', val)"
  >
    <n-card
      style="width: min(520px, calc(100vw - 32px))"
      title="删除 Skill"
      :bordered="false"
      size="huge"
      role="dialog"
      aria-modal="true"
    >
      <template v-if="props.skill">
        <p class="delete-target">
          即将删除 Skill <strong>{{ props.skill.title }}</strong>
          <span class="skill-id">{{ props.skill.id }}</span>
        </p>

        <p class="warning-title">此操作不可撤销，删除后将产生以下影响：</p>
        <ul class="consequence-list">
          <li>
            永久删除该 Skill
            目录及其中的全部文件：manifest.json、e2e_schema.json、test.spec.ts、SKILL.md
            等。
          </li>
          <li>从 Skill 索引（skill.list.json）中移除该 Skill。</li>
          <li>
            清除数据库（.e2e-agent）中与该 Skill 关联的历史会话与工作块数据。
          </li>
        </ul>
        <p class="danger-note">删除后无法恢复，请确认是否继续。</p>
      </template>

      <template #footer>
        <n-space justify="end">
          <n-button :disabled="submitting" @click="closeModal">取消</n-button>
          <n-button type="error" :loading="submitting" @click="confirmDelete">
            确认删除
          </n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.delete-target {
  margin: 0 0 18px;
  color: #334155;
  line-height: 1.6;
}

.delete-target strong {
  color: var(--color-review, #c2410c);
}

.skill-id {
  margin-left: 8px;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace;
  font-size: 12px;
  color: #64748b;
}

.warning-title {
  margin: 0 0 8px;
  font-weight: 600;
  color: #334155;
}

.consequence-list {
  margin: 0 0 8px;
  padding-left: 20px;
  color: #475569;
  line-height: 1.75;
}

.danger-note {
  margin: 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: rgb(247 60 60 / 8%);
  color: #b91c1c;
  font-weight: 600;
}
</style>

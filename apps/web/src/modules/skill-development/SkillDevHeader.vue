<!-- Skill 开发页头：展示当前 Skill 身份、当前文件副标题与状态标签，提供保存与返回入口；工作区面板可通过 status/actions 插槽注入状态标签与操作按钮。 -->
<script setup lang="ts">
import { NButton, NTag } from 'naive-ui'
import { useGlobalMessage } from '../../composables/useGlobalMessage'

const props = withDefaults(
  defineProps<{
    skillTitle: string
    skillId: string
    dirty: boolean
    /** 当前打开的文件路径，作为副标题展示在 Skill 名称后 */
    subtitle?: string
    /** 代码面板是否有打开的文件（决定展示文件状态标签与保存按钮） */
    fileOpen?: boolean
    /** 当前文件是否只读 */
    fileReadOnly?: boolean
    /** 当前文件保存状态 */
    saveState?: 'idle' | 'saved' | 'failed' | 'conflict'
    /** 保存请求是否进行中 */
    saving?: boolean
  }>(),
  {
    subtitle: '',
    fileOpen: false,
    fileReadOnly: false,
    saveState: 'idle',
    saving: false,
  },
)
const emit = defineEmits<{ back: []; save: [] }>()
const message = useGlobalMessage()

/**
 * 将 Skill ID 复制到剪贴板并提示结果。
 * @returns 复制完成后兑现的 Promise。
 * @throws 剪贴板 API 不可用时捕获异常并提示用户手动复制。
 */
async function copySkillId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.skillId)
    message.success('Skill ID 已复制到剪贴板')
  } catch {
    message.error('复制失败，请手动选择文本复制')
  }
}
</script>

<template>
  <header class="skill-dev-header">
    <div class="header-left">
      <n-button quaternary @click="emit('back')">← 返回</n-button>
      <div class="skill-identity">
        <div class="skill-title-row">
          <h1>{{ props.skillTitle }}</h1>
          <button
            type="button"
            class="skill-id-chip"
            :title="`点击复制 Skill ID：${props.skillId}`"
            @click="copySkillId"
          >
            #{{ props.skillId }}
          </button>
          <template v-if="props.subtitle">
            <span class="subtitle-sep" aria-hidden="true">/</span>
            <span class="skill-subtitle">{{ props.subtitle }}</span>
          </template>
        </div>
      </div>
      <slot name="status" />
      <template v-if="props.fileOpen">
        <n-tag v-if="props.fileReadOnly" size="small">只读</n-tag>
        <n-tag v-else-if="props.dirty" type="warning" size="small"
          >未保存</n-tag
        >
        <n-tag
          v-else-if="props.saveState === 'saved'"
          type="success"
          size="small"
          >已保存</n-tag
        >
        <n-tag v-if="props.saveState === 'failed'" type="error" size="small"
          >保存失败</n-tag
        >
        <n-tag v-if="props.saveState === 'conflict'" type="error" size="small"
          >外部修改冲突</n-tag
        >
      </template>
      <n-tag v-else-if="props.dirty" type="warning" size="small">
        <span class="dirty-label dirty-label--desktop">存在未保存修改</span>
        <span class="dirty-label dirty-label--mobile">未保存</span>
      </n-tag>
    </div>
    <div class="header-actions">
      <slot name="actions" />
      <n-button
        v-if="props.fileOpen"
        type="primary"
        size="small"
        :disabled="props.fileReadOnly || !props.dirty"
        :loading="props.saving"
        @click="emit('save')"
      >
        保存
      </n-button>
    </div>
  </header>
</template>

<style scoped>
.skill-dev-header {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-lg);
  padding: 0 var(--space-lg);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.skill-identity {
  min-width: 0;
}

.skill-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.skill-identity h1 {
  margin: 0;
  overflow: hidden;
  color: var(--color-ink-deep);
  font-size: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subtitle-sep {
  flex: none;
  color: var(--color-border);
}

.skill-subtitle {
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 13px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.skill-id-chip {
  flex: none;
  padding: 2px 7px;
  border: 0;
  border-radius: 6px;
  background: var(--color-well);
  color: var(--color-ink-muted);
  font-size: 11px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  line-height: 1.5;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.skill-id-chip:hover {
  background: #e2e8f0;
  color: var(--color-ink-body);
}

.skill-id-chip:active {
  background: #cbd5e1;
}

.dirty-label--mobile {
  display: none;
}

@media (pointer: coarse), (max-width: 760px) {
  .skill-dev-header {
    min-height: 64px;
    gap: var(--space-sm);
    padding: var(--space-sm) var(--space-md);
  }

  .skill-dev-header :deep(.n-button) {
    min-height: 44px;
  }

  .header-left {
    flex: 1;
    gap: var(--space-sm);
  }

  .skill-id-chip {
    display: none;
  }

  .dirty-label--desktop {
    display: none;
  }

  .dirty-label--mobile {
    display: inline;
  }
}
</style>

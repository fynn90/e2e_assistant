<!-- 展示保存/生成动作的阻塞原因、Agent 写入说明和字段导航。 -->
<script setup lang="ts">
import { useTemplateRef } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import type { IE2EActionReason } from '../composables/useE2ETestCaseReadiness'

const props = defineProps<{
  actionLabel: string
  reasons: IE2EActionReason[]
  requiresSave?: boolean
}>()
const emit = defineEmits<{
  navigate: [reason: IE2EActionReason]
}>()
const panelRef = useTemplateRef<HTMLElement>('panel')

/**
 * 将键盘焦点移动到就绪说明，便于用户理解被阻塞的下一步。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function focus(): void {
  panelRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <section
    ref="panel"
    class="readiness-panel"
    tabindex="-1"
    aria-labelledby="e2e-readiness-title"
    aria-live="polite"
    aria-atomic="true"
  >
    <n-alert v-if="props.reasons.length" type="warning" :show-icon="false">
      <strong id="e2e-readiness-title"
        >{{ props.actionLabel }}前还需要完成：</strong
      >
      <ul class="reason-list">
        <li v-for="reason in props.reasons" :key="reason.key">
          <n-button
            v-if="reason.targetId"
            text
            class="reason-link"
            @click="emit('navigate', reason)"
          >
            <span v-if="reason.label">{{ reason.label }}：</span
            >{{ reason.message }}
          </n-button>
          <span v-else
            ><span v-if="reason.label">{{ reason.label }}：</span
            >{{ reason.message }}</span
          >
        </li>
      </ul>
    </n-alert>
    <n-alert v-else-if="props.requiresSave" type="info" :show-icon="false">
      <strong id="e2e-readiness-title"
        >将先保存结构化用例，再生成 SKILL.md。</strong
      >
      <span>
        保存成功后自动开始：Agent 会加载测试用例 Skill 并写入当前 Skill 的
        SKILL.md，生成完成即落盘（无需再确认）。此过程不会生成或运行 Playwright
        测试。</span
      >
    </n-alert>
  </section>
</template>

<style scoped>
.readiness-panel {
  margin: var(--space-md) var(--space-card) 0;
  border-radius: var(--radius-control);
}

.readiness-panel:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.reason-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  margin: var(--space-sm) 0 0;
  padding-inline-start: var(--space-section);
}

.reason-link {
  height: auto;
  min-height: 24px;
  padding: 0;
  color: var(--color-ink-body);
  text-align: start;
  white-space: normal;
}

.reason-link:hover {
  color: var(--color-action-ink);
}

@media (pointer: coarse), (max-width: 760px) {
  .reason-link {
    min-height: 44px;
  }
}
</style>

<!-- Skill 开发代码子路由：根据 URL 文件路径渲染文件；markdown 文件提供「预览 / 源码」切换（源码可编辑并实时保存），env.json 提供说明栏与校验反馈区（阻断落盘），其余文件复用 Monaco 编辑器；文件名、状态与保存入口统一由页头展示。注意：模板必须保持单一稳定根节点，否则 transition + keep-alive 切换面板时会因子树锚点失效而崩溃。 -->
<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { NAlert, NButton, NRadioButton, NRadioGroup, NSpin } from 'naive-ui'
import { useRoute } from 'vue-router'
import { AUTO_SAVE_STATE_LABELS } from '../../../common/autosave/types'
import CodeEditor from '../../../common/code/CodeEditor.vue'
import MarkdownPreview from '../../../common/markdown/MarkdownPreview.vue'
import {
  SKILL_ENV_FILE_NAME,
  type IEnvFileIssue,
} from '@charlie_deng/e2e-assistant-types'
import EnvFileBanner from '../components/EnvFileBanner.vue'
import EnvFileIssues from '../components/EnvFileIssues.vue'
import { parseSkillDevelopmentWorkspaceTarget } from '../../../router/skill-development-navigation'
import type { ISkillDevelopmentWorkspaceContext } from '../types'

defineOptions({ name: 'SkillDevelopmentCodeRoute' })

const props = defineProps<{
  context: ISkillDevelopmentWorkspaceContext
}>()
const route = useRoute()
const requestedPath = ref('')
watch(
  () => parseSkillDevelopmentWorkspaceTarget(route),
  (target) => {
    if (target?.panel === 'code') {
      requestedPath.value = target.relativePath
    }
  },
  { immediate: true },
)
const readyFile = computed(() => {
  const file = props.context.currentFile.value
  return file?.relativePath === requestedPath.value ? file : null
})
// 当前文件是否为 markdown：v9 起提供「预览 / 源码」分段切换，源码模式可编辑并实时保存。
const isMarkdownFile = computed(() => readyFile.value?.language === 'markdown')
// 当前文件是否为 env.json：v10 起提供说明栏与校验反馈区（PRD 5.2 / 5.3）。
const isEnvFile = computed(
  () => readyFile.value?.relativePath === SKILL_ENV_FILE_NAME,
)
// markdown 文件的展示模式；其它文件恒为源码模式。
const viewMode = ref<'preview' | 'source'>('preview')
// 切换文件时回到预览：源码模式是逐文件的临时选择，不应跨文件沿用。
watch(requestedPath, () => {
  viewMode.value = 'preview'
})
const codeEditorRef =
  useTemplateRef<InstanceType<typeof CodeEditor>>('codeEditor')
// 当前文件是否只读（技能只读、文件只读或孤儿文件均不可保存）
const isReadOnly = computed(() =>
  Boolean(
    props.context.skill.value?.readOnly ||
    readyFile.value?.readOnly ||
    readyFile.value?.orphaned,
  ),
)
// 是否展示源码编辑器：非 markdown 恒展示；markdown 仅在源码模式展示。
const showSourceEditor = computed(
  () =>
    Boolean(readyFile.value) &&
    (!isMarkdownFile.value || viewMode.value === 'source'),
)
// 保存状态徽标文案（PRD 7.4）。只读文件不展示。
const saveStateLabel = computed(() =>
  isReadOnly.value
    ? ''
    : AUTO_SAVE_STATE_LABELS[props.context.autoSaveState.value],
)
// 是否需要展示错误条：失败与冲突都需要用户处理，且本地内容未回滚（PRD 7.5）。
// blocked（v10 校验阻断）不在此列：校验反馈区是其专属呈现，避免重复报错。
const showErrorBar = computed(
  () =>
    !isReadOnly.value &&
    (props.context.autoSaveState.value === 'failed' ||
      props.context.autoSaveState.value === 'conflict'),
)
const isConflict = computed(
  () => props.context.autoSaveState.value === 'conflict',
)
// 校验诊断（edit 模式不阻断写入，仅提示）。
const diagnostics = computed(() => props.context.autoSaveDiagnostics.value)
// env.json 的校验阻断问题明细（blocked 态专属，PRD 5.3）。
const envIssues = computed(() =>
  isEnvFile.value ? props.context.autoSaveBlockedIssues.value : [],
)

/**
 * 将 Monaco 内容更新写回当前文件草稿。
 * @param value Monaco 最新文本内容。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function updateDraft(value: string): void {
  props.context.draftContent.value = value
}

/**
 * 响应反馈区条目点击：把编辑器滚动并聚焦到错误位置（PRD 5.3）。
 * @param issue 被点击的问题（含行号）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function locateEnvIssue(issue: IEnvFileIssue): void {
  if (issue.line !== undefined) {
    codeEditorRef.value?.revealPosition(issue.line, issue.column ?? 1)
  }
}
</script>

<template>
  <div class="code-route">
    <div v-if="readyFile" class="code-route-status">
      <span class="save-state" :class="props.context.autoSaveState.value">
        {{ saveStateLabel }}
      </span>
      <n-radio-group
        v-if="isMarkdownFile"
        v-model:value="viewMode"
        size="small"
      >
        <n-radio-button value="preview">预览</n-radio-button>
        <n-radio-button value="source">源码</n-radio-button>
      </n-radio-group>
    </div>
    <!-- 保存错误条：本地内容永不回滚，由用户选择重试 / 重新加载 / 覆盖保存（PRD 7.5） -->
    <n-alert
      v-if="showErrorBar"
      class="code-route-error"
      :type="isConflict ? 'warning' : 'error'"
      :title="isConflict ? '文件已被外部修改' : '保存失败'"
    >
      <p>{{ props.context.autoSaveErrorMessage.value }}</p>
      <div class="error-actions">
        <template v-if="isConflict">
          <n-button size="tiny" @click="props.context.reloadAutoSave"
            >重新加载</n-button
          >
          <n-button
            size="tiny"
            type="primary"
            @click="props.context.reloadAutoSave"
            >放弃本地改动并加载磁盘</n-button
          >
        </template>
        <n-button
          v-else
          size="tiny"
          type="primary"
          @click="props.context.retryAutoSave"
          >重试保存</n-button
        >
      </div>
    </n-alert>
    <!-- 校验诊断：edit 模式下不阻断写入，仅提示用户修正（PRD 8.1） -->
    <n-alert
      v-if="diagnostics.length > 0"
      class="code-route-error"
      type="warning"
      title="校验提示"
    >
      <ul>
        <li v-for="(item, index) in diagnostics" :key="`${item.code}-${index}`">
          {{ item.message }}
        </li>
      </ul>
    </n-alert>
    <div
      v-if="readyFile && isMarkdownFile && viewMode === 'preview'"
      class="markdown-file-view"
    >
      <div class="markdown-scroll">
        <div class="markdown-doc">
          <markdown-preview
            :key="readyFile.relativePath"
            :content="props.context.draftContent.value"
          />
        </div>
      </div>
    </div>
    <template v-else-if="showSourceEditor && readyFile">
      <!-- env.json 说明栏：用途、不被大模型读取、执行注入与 key 命名规则（PRD 5.2） -->
      <env-file-banner v-if="isEnvFile" />
      <code-editor
        ref="codeEditor"
        :key="readyFile.relativePath"
        :model-value="props.context.draftContent.value"
        :file-path="readyFile.relativePath"
        :language="readyFile.language"
        :read-only="isReadOnly"
        :saving="props.context.saving.value"
        :dirty="props.context.dirty.value"
        :save-state="props.context.saveState.value"
        hide-toolbar
        @update:model-value="updateDraft"
        @save="props.context.saveCurrentFile"
      />
      <!-- env.json 校验反馈区：blocked 态的专属呈现，点击定位错误位置（PRD 5.3）；出现 / 消失带过渡动画 -->
      <transition name="env-issues">
        <env-file-issues
          v-if="isEnvFile && envIssues.length > 0"
          :issues="envIssues"
          @locate="locateEnvIssue"
        />
      </transition>
    </template>
    <div v-else class="workspace-loading">
      <n-spin size="large" />
      <p>正在打开 {{ requestedPath || '文件' }}…</p>
    </div>
  </div>
</template>

<style scoped>
.code-route {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* 状态行：保存状态徽标（圆点 + 文字，PRD 7.4）与 markdown 的预览/源码切换 */
.code-route-status {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  min-height: 36px;
  padding: 0 var(--space-card);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-ink-muted);
  font-size: 12px;
}
.save-state::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentcolor;
  content: '';
}
.save-state.pending {
  color: var(--color-warning);
}
.save-state.failed {
  color: var(--color-danger);
}
.save-state.conflict {
  color: var(--color-danger);
}
/* v10：校验阻断态（env.json 非法内容被拒绝落盘，PRD 5.3） */
.save-state.blocked {
  color: var(--color-danger);
}
.code-route-error {
  flex: none;
  margin: var(--space-sm) var(--space-card) 0;
}
.error-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}
.code-route-error ul {
  margin: 4px 0 0;
  padding-left: 18px;
}
.markdown-file-view {
  flex: 1;
  min-height: 0;
  background: #f1f5f9;
}
.markdown-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 28px 32px 56px;
}
.markdown-doc {
  max-width: 860px;
  margin: 0 auto;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  box-shadow: 0 6px 24px rgb(15 23 42 / 6%);
}
.markdown-doc :deep(.markdown-preview) {
  padding: 28px 36px 36px;
}
@media (max-width: 760px) {
  .markdown-scroll {
    padding: 16px 12px 32px;
  }
  .markdown-doc {
    border-radius: 10px;
  }
  .markdown-doc :deep(.markdown-preview) {
    padding: 20px 18px 24px;
  }
}
.workspace-loading {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  color: #64748b;
  background: #f8fafc;
}
/* Monaco 编辑器需要可收缩的弹性容器，否则在 flex 列布局中会撑破状态行 */
.code-route :deep(.code-editor-shell) {
  flex: 1;
  min-height: 0;
}
/* env.json 校验反馈区的出现 / 消失过渡：淡入 + 轻微上移 + 高度展开，离开时反向收起 */
.env-issues-enter-active,
.env-issues-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease,
    max-height 0.26s ease,
    margin 0.26s ease;
  max-height: 320px;
  overflow: hidden;
}
.env-issues-enter-from,
.env-issues-leave-to {
  max-height: 0;
  margin-top: 0;
  margin-bottom: 0;
  opacity: 0;
  transform: translateY(6px);
}
</style>

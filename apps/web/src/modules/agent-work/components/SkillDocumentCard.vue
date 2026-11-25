<!--
  SKILL.md 产物卡片（PRD 6.3）：渲染 SKILL.md 的**完成状态**。

  单一职责：展示产物内容与元信息，**不感知业务流程**
  （不知道 SKILL 阶段之后是脚本阶段）。交互按钮由 SkillDocumentCardActions 负责。

  正文内容：
    - 完成说明（始终）
    - 保存错误条（保存失败 / 冲突时，PRD 7.5）
    - 校验诊断（edit 模式不阻断写入，仅提示）
    - 生成警告 / 生成假设（有则展示）
    - 版本元信息（始终，12px 次要信息）
    - 环境变量（有则展示）
    - 文档内容：**预览 / 源码**分段切换，源码模式可编辑
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NRadioButton, NRadioGroup, NTag } from 'naive-ui'
import CodeEditor from '../../../common/code/CodeEditor.vue'
import MarkdownPreview from '../../../common/markdown/MarkdownPreview.vue'
import type { IProductCard } from '../../../modules/generation-flow/types'
import SaveStateBadge from './SaveStateBadge.vue'
import CardShell from './CardShell.vue'

const props = defineProps<{
  /** 产物卡片数据。 */
  card: IProductCard
  /** 保存失败 / 冲突时的错误文案。 */
  saveErrorMessage?: string
  /** 用户点击「重试保存」。 */
  onRetrySave?: () => void
  /** 用户点击「重新加载」（放弃本地改动）。 */
  onReload?: () => void
}>()

const emit = defineEmits<{
  /** 源码内容变更（实时保存的数据源）。 */
  contentChange: [content: string]
}>()

/** 视图模式：预览 / 源码（PRD 6.2 分段控件）。 */
const viewMode = ref<'preview' | 'source'>(props.card.viewMode)
watch(
  () => props.card.viewMode,
  (next) => {
    viewMode.value = next
  },
)

/** 保存问题：失败或冲突时展示错误条，本地内容永不回滚（PRD 7.5）。 */
const isConflict = computed(() => props.card.saveState === 'conflict')
const showErrorBar = computed(
  () =>
    props.card.saveState === 'failed' || props.card.saveState === 'conflict',
)
/** 校验诊断：v15 起两种模式都不阻断写入，仅提示用户修正（PRD 8.1）。 */
const diagnostics = computed(() => props.card.diagnostics)

/** 待处理项总数：校验诊断 + 生成警告（两者对用户都是「需要留意」）。 */
const issueCount = computed(
  () => diagnostics.value.length + props.card.warnings.length,
)

/**
 * 把 Monaco 内容变更向上传递。
 * @param value Monaco 最新文本内容。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleContentChange(value: string): void {
  emit('contentChange', value)
}
</script>

<template>
  <CardShell :file-name="card.fileName">
    <!-- 操作区插槽透传：交互按钮由 SkillDocumentCardActions 提供（PRD 14.3 分层约束） -->
    <template #actions>
      <slot name="actions" />
    </template>
    <template #badges>
      <n-tag size="small" type="success" round>已完成</n-tag>
      <SaveStateBadge :state="card.saveState" />
      <!--
        v15：校验不再阻断落盘，问题只在下方的提示区呈现。而卡片在完成后
        会随侧边栏折叠、状态徽标仍是绿色的「已完成」，用户极易错过提示——
        因此在徽标上直接给出待处理项的数量，把「已保存但有话要说」显式化。
      -->
      <n-tag v-if="issueCount > 0" size="small" type="warning" round>
        {{ issueCount }} 项提示
      </n-tag>
    </template>

    <p class="card-completion-hint">{{ card.completionHint }}</p>

    <!-- 保存错误条：提供「重试保存」或「重新加载 / 放弃本地改动」（PRD 7.5） -->
    <n-alert
      v-if="showErrorBar"
      class="card-alert"
      :type="isConflict ? 'warning' : 'error'"
      :title="isConflict ? '文件已被外部修改' : '保存失败'"
    >
      <p>{{ saveErrorMessage }}</p>
      <div class="card-error-actions">
        <template v-if="isConflict">
          <n-button size="small" @click="onReload?.()">重新加载</n-button>
          <n-button size="small" type="primary" @click="onReload?.()"
            >放弃本地改动并加载磁盘</n-button
          >
        </template>
        <n-button v-else size="small" type="primary" @click="onRetrySave?.()"
          >重试保存</n-button
        >
      </div>
    </n-alert>

    <n-alert
      v-if="diagnostics.length > 0"
      class="card-alert"
      type="warning"
      title="校验提示"
    >
      <ul class="card-list">
        <li v-for="(item, index) in diagnostics" :key="`${item.code}-${index}`">
          {{ item.message }}
        </li>
      </ul>
    </n-alert>

    <n-alert
      v-if="card.warnings.length > 0"
      class="card-alert"
      type="warning"
      title="生成警告"
    >
      <ul class="card-list">
        <li
          v-for="warning in card.warnings"
          :key="`${warning.code}-${warning.stepId ?? ''}`"
        >
          {{ warning.message }}
        </li>
      </ul>
    </n-alert>

    <n-alert
      v-if="card.assumptions.length > 0"
      class="card-alert"
      type="info"
      title="生成假设"
    >
      <ul class="card-list">
        <li v-for="assumption in card.assumptions" :key="assumption">
          {{ assumption }}
        </li>
      </ul>
    </n-alert>

    <div class="card-meta">
      <span v-if="card.meta.testCaseVersion"
        >来源用例版本：{{ card.meta.testCaseVersion }}</span
      >
      <span>文档版本：{{ card.meta.version }}</span>
    </div>

    <div v-if="card.environmentVariables.length > 0" class="card-tag-group">
      <span class="card-section-title">使用的环境变量</span>
      <n-tag
        v-for="name in card.environmentVariables"
        :key="name"
        size="small"
        >{{ name }}</n-tag
      >
    </div>

    <!-- 预览 / 源码切换：不并排展示两份内容（PRD 6.2 简洁性约束） -->
    <div class="card-view-switch">
      <n-radio-group v-model:value="viewMode" size="small">
        <n-radio-button value="preview">预览</n-radio-button>
        <n-radio-button value="source">源码</n-radio-button>
      </n-radio-group>
    </div>

    <markdown-preview
      v-if="viewMode === 'preview'"
      class="card-preview"
      :content="card.content"
    />
    <CodeEditor
      v-else
      :model-value="card.content"
      file-path="SKILL.md"
      language="markdown"
      :read-only="false"
      :saving="card.saveState === 'saving'"
      :dirty="card.saveState !== 'saved'"
      hide-toolbar
      @update:model-value="handleContentChange"
    />
  </CardShell>
</template>

<style scoped>
.card-completion-hint {
  margin: 0 0 12px;
}

.card-alert {
  margin: 12px 0;
}

.card-error-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.card-view-switch {
  display: flex;
  justify-content: flex-end;
  margin: 4px 0 8px;
}

.card-preview {
  min-height: 200px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
}
</style>

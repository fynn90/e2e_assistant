<!--
  Playwright 脚本产物卡片（PRD 6.4）：渲染脚本的**完成状态**。

  单一职责：展示产物内容与元信息，**不感知业务流程**。
  交互按钮由 PlaywrightScriptCardActions 负责。

  正文内容：
    - 完成说明（始终，含「当前未运行任何测试」的既有边界说明）
    - 保存错误条（保存失败 / 冲突时，PRD 7.5）
    - 校验诊断（edit 模式不阻断写入，仅提示）
    - 脚本元信息（修改时间、上次生成时间）
    - 生成警告 / 生成假设 / 环境变量 / 步骤覆盖（有则展示）
    - 代码内容：与磁盘既有版本的差异对比，**可编辑**
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NTag } from 'naive-ui'
import type { IProductCard } from '../../../modules/generation-flow/types'
import { formatTimestamp } from '../../e2e-test-case/utils/format-timestamp'
import CodeDiffEditor from '../../../common/code/CodeDiffEditor.vue'
import SaveStateBadge from './SaveStateBadge.vue'
import CardShell from './CardShell.vue'

const props = defineProps<{
  /** 产物卡片数据。 */
  card: IProductCard
  /** 磁盘上已有的脚本内容，用于差异对比的「原始」侧。 */
  existingCode: string
  /** 保存失败 / 冲突时的错误文案。 */
  saveErrorMessage?: string
  /** 用户点击「重试保存」。 */
  onRetrySave?: () => void
  /** 用户点击「重新加载」（放弃本地改动）。 */
  onReload?: () => void
}>()

const emit = defineEmits<{
  /** 代码内容变更（实时保存的数据源）。 */
  codeChange: [code: string]
}>()

const isConflict = computed(() => props.card.saveState === 'conflict')
const showErrorBar = computed(
  () =>
    props.card.saveState === 'failed' || props.card.saveState === 'conflict',
)
const diagnostics = computed(() => props.card.diagnostics)

/** 待处理项总数：校验诊断 + 生成警告（两者对用户都是「需要留意」）。 */
const issueCount = computed(
  () => diagnostics.value.length + props.card.warnings.length,
)
/** 脚本修改时间（有值时展示）。 */
const updatedAt = computed(() =>
  props.card.meta.updatedAt ? formatTimestamp(props.card.meta.updatedAt) : null,
)
/** 上次生成时间（有值时展示）。 */
const generatedAt = computed(() =>
  props.card.meta.generatedAt
    ? formatTimestamp(props.card.meta.generatedAt)
    : null,
)

/**
 * 把编辑器内容变更向上传递。
 * @param value 最新脚本源码。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleCodeChange(value: string): void {
  emit('codeChange', value)
}
</script>

<template>
  <CardShell :file-name="card.fileName">
    <!-- 操作区插槽透传：交互按钮由 PlaywrightScriptCardActions 提供（PRD 14.3 分层约束） -->
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

    <div v-if="updatedAt || generatedAt" class="card-meta">
      <span v-if="updatedAt">脚本修改时间：{{ updatedAt.title }}</span>
      <span v-if="generatedAt">上次生成时间：{{ generatedAt.title }}</span>
    </div>

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

    <div v-if="card.environmentVariables.length > 0" class="card-tag-group">
      <span class="card-section-title">需要配置的环境变量</span>
      <n-tag
        v-for="name in card.environmentVariables"
        :key="name"
        size="small"
        >{{ name }}</n-tag
      >
    </div>

    <!-- 步骤覆盖：每个步骤的操作数与断言数（紧凑列表，不嵌套区块） -->
    <div v-if="card.stepCoverage.length > 0" class="card-coverage">
      <span class="card-section-title">步骤覆盖</span>
      <ul class="card-list">
        <li v-for="coverage in card.stepCoverage" :key="coverage.stepId">
          {{ coverage.stepId }}：{{ coverage.operations }} 个操作，{{
            coverage.assertions
          }}
          个断言
        </li>
      </ul>
    </div>

    <!--
      差异对比 + 可编辑：磁盘既有版本为「原始侧」，用户可改的当前内容为「修改侧」。
      卡片正文宽度上限约 828px，始终不足以并排，故使用内联模式（组件默认值）。
    -->
    <code-diff-editor
      :original="existingCode"
      :modified="card.content"
      :editable="true"
      language="typescript"
      @update:modified="handleCodeChange"
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

.card-coverage {
  margin: 12px 0;
}

/*
  脚本差异编辑器：固定高度，超出的正文由卡片正文区滚动。

  必须命中 CodeDiffEditor 的**根元素** `.diff-editor`（即 `:deep()` 直达的节点）。

  注意两点，否则规则静默失效：
  1. 原写法用的 `.code-diff-editor` 项目内从未添加到任何元素，是失效选择器；
     旧代码能显示 320px 是巧合——Monaco 的内层 `.monaco-diff-editor` 带内联
     `height`，会覆盖样式表里的 height 声明，样式实际从未生效。
  2. 不要改为命中内层 `.monaco-diff-editor`：Monaco 在布局时把测量到的高度
     以**内联样式**写回该节点（`diffEditorWidget.js` 中 `elements.root.style.height`），
     样式表里的高度会被它覆盖。
*/
:deep(.diff-editor) {
  height: 320px;
  margin-top: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  overflow: hidden;
}
</style>

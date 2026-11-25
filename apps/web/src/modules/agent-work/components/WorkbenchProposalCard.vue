<!--
  提案卡片（v17，PRD E / V / L 组）：等用户确认后才生效的写操作入口。

  三条与需求直接对应的实现约束：

    1. **人话对照，不丢 JSON**（E2）：`changes` 由服务端读盘后算好，前端只负责
       渲染成表（对象 / 原值 → 新值），`op` 决定符号与配色；
    2. **二次弹框是独立的一道闸**（D2 / L1a / L2a）：`requiresModalConfirm` 为 true
       时点击主按钮**先向上抛 requestConfirm**，由面板层弹模态；弹框内取消
       **不发任何请求**（提案仍是 pending，用户还能再点）——只有卡片上的「取消」
       按钮才调 cancel 接口；
    3. **env 值只在这里出现一次**（D7 / V3）：输入框为密码型，值随 apply 请求
       直达平台，不进入事件、工作块或对话文本。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput, NTag } from 'naive-ui'
import type { IProposalChange } from '@fynn90-e2e_assistant/types'
import type { IWorkbenchProposalTimelineItem } from '../timeline'
import { formatBytes } from './workbench-format'

const props = defineProps<{
  /** 提案卡片项。 */
  item: IWorkbenchProposalTimelineItem
  /** 提交中（禁用按钮，避免重复点击）。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  /** 用户请求应用提案（env-fill 时携带用户填的值）。 */
  apply: [
    item: IWorkbenchProposalTimelineItem,
    envValues?: Record<string, string>,
  ]
  /** 用户取消提案（卡片上的「取消」按钮；弹框内取消不走这里）。 */
  cancel: [item: IWorkbenchProposalTimelineItem]
  /** 需要二次弹框确认时向上抛出，由面板层弹模态（D2）。 */
  requestConfirm: [item: IWorkbenchProposalTimelineItem]
}>()

/** 用户填写的 env 值（key → 值；**只在本组件内存里，不回传对话**）。 */
const envValues = ref<Record<string, string>>({})

/** 提案是否仍在待确认（终态时卡片定格、隐藏按钮）。 */
const actionable = computed(() => props.item.state === 'pending')

/** 目标用例是否已被删除（L2d：标注并禁用按钮）。 */
const skillMissing = computed(() => props.item.skillMissing === true)

/** 主按钮文案（PRD L1：报告清理的按钮文案含数量）。 */
const primaryLabel = computed(() => {
  switch (props.item.proposalKind) {
    case 'case-change':
      return '应用变更'
    case 'env-fill':
      return '保存'
    default:
      // report-cleanup / case-delete：服务端给出的 label 已含数量
      //（如「删除 6 份报告」），不在此处自行拼数字。
      return props.item.label || '确认'
  }
})

/** 终态定格文案（applied / cancelled / conflict / failed / expired）。 */
const frozenText = computed(() => {
  switch (props.item.state) {
    case 'applied':
      return '已应用'
    case 'cancelled':
      return '已取消'
    case 'conflict':
      return props.item.resultMessage ?? '冲突，请重新生成提案'
    case 'failed':
      return props.item.resultMessage ?? '应用失败'
    case 'expired':
      return '已失效'
    default:
      return ''
  }
})

/** 终态徽标配色。 */
const frozenTagType = computed(() => {
  switch (props.item.state) {
    case 'applied':
      return 'success' as const
    case 'cancelled':
    case 'expired':
      return 'default' as const
    case 'conflict':
      return 'warning' as const
    case 'failed':
      return 'error' as const
    default:
      return 'default' as const
  }
})

/** 是否渲染 env 输入区（env-fill 且待确认）。 */
const showEnvForm = computed(
  () =>
    props.item.proposalKind === 'env-fill' && props.item.envKeys !== undefined,
)

/**
 * `op` → 展示符号（E2：不得把 JSON 丢给用户）。
 * @param change - 一行人话对照。
 * @returns 变更符号。
 * @throws 不抛出异常。
 */
function opSymbol(change: IProposalChange): string {
  switch (change.op) {
    case 'add':
      return '＋'
    case 'remove':
      return '－'
    case 'update':
      return '→'
    case 'toggle':
      return '⇄'
    case 'reorder':
      return '⇅'
    default:
      return '·'
  }
}

/**
 * `op` → 样式类（add 绿 / remove 红 / 其余中性）。
 * @param change - 一行人话对照。
 * @returns 样式类名。
 * @throws 不抛出异常。
 */
function opClass(change: IProposalChange): string {
  if (change.op === 'add') return 'add'
  if (change.op === 'remove') return 'remove'
  return 'update'
}

/**
 * 点击主按钮：需要弹框时先向上抛 requestConfirm，否则直接请求应用。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handlePrimary(): void {
  if (!actionable.value || skillMissing.value) return
  if (props.item.requiresModalConfirm) {
    emit('requestConfirm', props.item)
    return
  }
  emitApply()
}

/**
 * 提交应用请求。
 *
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function emitApply(): void {
  if (props.item.proposalKind === 'env-fill') {
    emit('apply', props.item, collectEnvValues())
    return
  }
  emit('apply', props.item)
}

/**
 * 收集用户填写的 env 值（空串也算「已填写」，交由服务端判定）。
 * @returns key → 值的映射。
 * @throws 不抛出异常。
 */
function collectEnvValues(): Record<string, string> {
  const values: Record<string, string> = {}
  for (const item of props.item.envKeys ?? []) {
    const value = envValues.value[item.key]
    if (value !== undefined) values[item.key] = value
  }
  return values
}

/**
 * 取消提案（卡片上的按钮；弹框内取消不调此路径）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleCancel(): void {
  if (!actionable.value) return
  emit('cancel', props.item)
}
</script>

<template>
  <section class="workbench-proposal" aria-label="待确认提案">
    <header class="proposal-head">
      <div class="head-text">
        <span class="proposal-title">{{ item.label }}</span>
        <span v-if="item.skillTitle" class="proposal-skill">
          目标用例：{{ item.skillTitle }}
        </span>
      </div>
      <n-tag
        v-if="item.state !== 'pending'"
        size="small"
        round
        :type="frozenTagType"
      >
        {{ frozenText }}
      </n-tag>
    </header>

    <p v-if="item.description" class="proposal-desc">{{ item.description }}</p>

    <p v-if="skillMissing" class="proposal-warn">
      用例已删除，这份提案无法再应用。
    </p>

    <!-- 人话对照（E2） -->
    <ul v-if="item.changes && item.changes.length > 0" class="change-list">
      <li
        v-for="(change, index) in item.changes"
        :key="index"
        class="change-row"
      >
        <span class="op" :class="opClass(change)">{{ opSymbol(change) }}</span>
        <span class="target">{{ change.target }}</span>
        <span class="values">
          <span v-if="change.before !== undefined" class="before">{{
            change.before
          }}</span>
          <span
            v-if="change.before !== undefined && change.after !== undefined"
            class="arrow"
          >
            →
          </span>
          <span v-if="change.after !== undefined" class="after">{{
            change.after
          }}</span>
        </span>
      </li>
    </ul>

    <!-- G5 举证区：Agent 核对页面的结果（无证据不得提案，故有则必展示） -->
    <div v-if="item.evidence" class="evidence">
      <span class="section-title">页面核对</span>
      <p class="evidence-line">页面实际：{{ item.evidence.actual }}</p>
      <p class="evidence-line">用例所写：{{ item.evidence.expected }}</p>
      <p class="evidence-line muted">
        核对方式：{{ item.evidence.verifiedBy }}
      </p>
    </div>

    <!-- 报告清理的释放空间（L1：卡片要列出总数与总占用） -->
    <p v-if="item.releaseBytes !== undefined" class="proposal-desc">
      预计释放
      {{ formatBytes(item.releaseBytes) || item.releaseBytes + ' 字节' }}。
    </p>

    <!-- env key 输入区（V3/D7）：密码型输入，值不进对话与日志 -->
    <div v-if="showEnvForm" class="env-form">
      <p class="env-hint">这些值由你直接保存给平台，不会出现在对话与日志中。</p>
      <div
        v-for="envKey in item.envKeys ?? []"
        :key="envKey.key"
        class="env-row"
      >
        <span class="env-key">{{ envKey.key }}</span>
        <span v-if="envKey.usage" class="env-usage">{{ envKey.usage }}</span>
        <n-input
          v-model:value="envValues[envKey.key]"
          type="password"
          size="small"
          show-password-on="click"
          placeholder="填写值"
          :disabled="!actionable || skillMissing"
        />
      </div>
      <div v-if="item.envKeyOps && item.envKeyOps.length > 0" class="env-ops">
        <span
          v-for="op in item.envKeyOps"
          :key="op.key + op.op"
          class="env-op"
          :class="op.op === 'add' ? 'add' : 'remove'"
        >
          {{ op.op === 'add' ? '新增键名' : '删除键名' }}：{{ op.key }}
        </span>
      </div>
    </div>

    <footer v-if="actionable && !skillMissing" class="proposal-actions">
      <n-button size="small" :disabled="Boolean(busy)" @click="handleCancel">
        取消
      </n-button>
      <n-button
        type="primary"
        size="small"
        :loading="Boolean(busy)"
        @click="handlePrimary"
      >
        {{ primaryLabel }}
      </n-button>
    </footer>
  </section>
</template>

<style scoped>
.workbench-proposal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  min-width: 0;
}

.proposal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.proposal-title {
  color: var(--color-ink-deep);
  font-size: 13.5px;
  font-weight: 600;
}

.proposal-skill {
  color: var(--color-ink-body);
  font-size: 12px;
}

.proposal-desc {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
  line-height: 1.5;
}

.proposal-warn {
  margin: 0;
  color: #b45309;
  font-size: 12px;
}

.change-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.change-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12.5px;
  min-width: 0;
}

.op {
  flex: 0 0 auto;
  font-weight: 600;
}

.op.add {
  color: #15803d;
}

.op.remove {
  color: #b91c1c;
}

.op.update {
  color: var(--color-ink-body);
}

.target {
  color: var(--color-ink-deep);
  flex: 0 0 auto;
}

.values {
  color: var(--color-ink-muted);
  word-break: break-word;
  min-width: 0;
}

.before {
  color: var(--color-ink-muted);
  text-decoration: line-through;
}

.arrow {
  margin: 0 4px;
}

.after {
  color: var(--color-ink-body);
}

.evidence {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-well);
}

.section-title {
  color: var(--color-ink-deep);
  font-size: 12px;
  font-weight: 600;
}

.evidence-line {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 12px;
  line-height: 1.5;
}

.evidence-line.muted {
  color: var(--color-ink-muted);
}

.env-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.env-hint {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.env-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.env-key {
  flex: 0 0 auto;
  min-width: 120px;
  color: var(--color-ink-deep);
  font-size: 12.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.env-usage {
  flex: 1;
  min-width: 0;
  color: var(--color-ink-muted);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.env-ops {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.env-op {
  font-size: 11.5px;
}

.env-op.add {
  color: #15803d;
}

.env-op.remove {
  color: #b91c1c;
}

.proposal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-sm);
  padding-top: 4px;
}
</style>

<!--
  提案的二次确认弹框（v17，PRD D2 / L1a / L2a）。

  为什么必须是**模态**而不是「卡片按钮点两次」：N3 明确「卡片上的一次点击不足以
  构成确认」。模态是独立于卡片的交互层——它不会被「用户在卡片上连点」跨过；
  弹框复述的数量与对象**来自服务端给出的 `changes`**，不是前端拼的。

  取消语义（技术方案 §7.2）：弹框内取消**不调任何接口**——提案仍是 pending，
  用户还可以再点。只有卡片上的「取消」按钮才把提案置为 cancelled。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NModal } from 'naive-ui'
import type { IWorkbenchProposalTimelineItem } from '../timeline'
import { formatBytes } from './workbench-format'

const props = defineProps<{
  /** 是否展示弹窗。 */
  show: boolean
  /** 待确认的提案（为空时不渲染内容，仅保持弹窗契约）。 */
  proposal: IWorkbenchProposalTimelineItem | null
}>()

const emit = defineEmits<{
  /** 弹窗显隐（取消 / 遮罩关闭都会走这里）。 */
  'update:show': [value: boolean]
  /** 用户在弹框内确认：由面板层发出 apply 请求。 */
  confirm: [proposal: IWorkbenchProposalTimelineItem]
}>()

/** 标题按提案种类区分（删除类恒为「确认删除？」）。 */
const title = computed(() => {
  if (props.proposal?.proposalKind === 'report-cleanup') return '确认删除报告？'
  if (props.proposal?.proposalKind === 'case-delete') return '确认删除用例？'
  return '确认执行这个操作？'
})

/** 将删除的报告份数（弹框复述用；服务端给出）。 */
const reportCount = computed(() => props.proposal?.reportCount)

/**
 * 关闭弹窗（**不发任何请求**：提案保持 pending）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function close(): void {
  emit('update:show', false)
}

/**
 * 确认：向上抛出提案，由面板层发 apply 请求。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function confirm(): void {
  if (!props.proposal) return
  emit('confirm', props.proposal)
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="true"
    @update:show="(value) => emit('update:show', value)"
  >
    <div v-if="proposal" class="confirm-dialog" role="dialog" aria-modal="true">
      <h3 class="dialog-title">{{ title }}</h3>

      <p class="dialog-lead">{{ proposal.label }}</p>
      <p v-if="proposal.description" class="dialog-desc">
        {{ proposal.description }}
      </p>

      <!-- 复述将删除的数量与对象（L1a / L2a：弹框再次列出数量与总占用） -->
      <ul
        v-if="proposal.changes && proposal.changes.length > 0"
        class="dialog-changes"
      >
        <li v-for="(change, index) in proposal.changes" :key="index">
          {{ change.target
          }}<template v-if="change.after">：{{ change.after }}</template>
        </li>
      </ul>

      <p v-if="reportCount !== undefined" class="dialog-count">
        将一并删除 {{ reportCount }} 份报告。
      </p>
      <p v-if="proposal.releaseBytes !== undefined" class="dialog-count">
        预计释放 {{ formatBytes(proposal.releaseBytes) }}。
      </p>

      <p class="dialog-warning">该操作不可撤销，请确认后再继续。</p>

      <footer class="dialog-actions">
        <!-- 取消：只关弹窗，不调任何接口（提案仍是 pending） -->
        <n-button size="small" @click="close">取消</n-button>
        <n-button type="error" size="small" @click="confirm">确认</n-button>
      </footer>
    </div>
  </n-modal>
</template>

<style scoped>
.confirm-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(520px, calc(100vw - 48px));
  padding: 18px 20px;
  border-radius: var(--radius-panel);
  background: var(--color-surface);
}

.dialog-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 15px;
  font-weight: 600;
}

.dialog-lead {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 13px;
  line-height: 1.6;
}

.dialog-desc {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.dialog-changes {
  margin: 0;
  padding-left: 18px;
  color: var(--color-ink-body);
  font-size: 12.5px;
  line-height: 1.6;
  max-height: 200px;
  overflow-y: auto;
}

.dialog-count {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 12.5px;
  font-weight: 600;
}

.dialog-warning {
  margin: 0;
  color: #b91c1c;
  font-size: 12.5px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: 8px;
}
</style>

<!-- 工作时间线容器：按事件类型分发渲染组件，内容增长时自动滚动到底。 -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { TAgentInteractionAnswer } from '@fynn90-e2e_assistant/types'
import IconFont from '../../../common/icon/IconFont.vue'
import { EMPTY_TIMELINE_ICON } from '../icons'
import type {
  IWorkbenchActionTimelineItem,
  IWorkbenchProposalTimelineItem,
  IWorkbenchTaskTimelineItem,
  IWorkbenchViewTimelineItem,
  TWorkTimelineItem,
} from '../timeline'
import ThinkingBlock from './ThinkingBlock.vue'
import ContentBlock from './ContentBlock.vue'
import ToolBlock from './ToolBlock.vue'
import TodoBlock from './TodoBlock.vue'
import CommandBlock from './CommandBlock.vue'
import AskUserQuestion from './AskUserQuestion.vue'
import NoticeItem from './NoticeItem.vue'
import TurnDivider from './TurnDivider.vue'
import WorkbenchActionCard from './WorkbenchActionCard.vue'
import WorkbenchTaskCard from './WorkbenchTaskCard.vue'
import WorkbenchReportCard from './WorkbenchReportCard.vue'
import WorkbenchViewCard from './WorkbenchViewCard.vue'
import WorkbenchProposalCard from './WorkbenchProposalCard.vue'
import TimelineSuggestions from './TimelineSuggestions.vue'

const props = defineProps<{
  /** 时间线项（按 seq 升序）。只读：消费方不应改写归约结果。 */
  items: readonly TWorkTimelineItem[]
  /** 正在处理的动作 ID（禁用该卡片的按钮，避免重复点击）。 */
  pendingActionId?: string
  /**
   * 是否展示空态建议问题（v17 H1）。
   *
   * 只有工作台整页传 true：生成弹窗内嵌的子会话时间线是旁观视角，
   * 在那里发问无处可去（建议问题点击后要作为**当前会话**的用户消息发送）。
   */
  suggestionsEnabled?: boolean
}>()

const emit = defineEmits<{
  /** 用户回答了交互卡片（v14：单问题 string / 多问题回答表）。 */
  answer: [interactionId: string, value: TAgentInteractionAnswer]
  /** 用户点击了动作卡片（v16）。 */
  action: [item: IWorkbenchActionTimelineItem]
  /** 用户请求打开报告弹窗（v16；由页面级组件承载弹窗）。 */
  openReport: [input: { skillId: string; skillTitle: string; runId: string }]
  /** 用户请求应用提案（v17；env-fill 携带填写的值）。 */
  proposalApply: [
    item: IWorkbenchProposalTimelineItem,
    envValues?: Record<string, string>,
  ]
  /** 用户请求取消提案（卡片上的取消按钮）。 */
  proposalCancel: [item: IWorkbenchProposalTimelineItem]
  /** 提案需要二次弹框确认（v17 D2；由面板层弹模态）。 */
  proposalConfirmRequest: [item: IWorkbenchProposalTimelineItem]
  /** 批次：确认开始（v17 R4a）。 */
  batchConfirm: [item: IWorkbenchTaskTimelineItem]
  /** 批次：取消（待确认态）。 */
  batchCancel: [item: IWorkbenchTaskTimelineItem]
  /** 批次：停止（终止整批）。 */
  batchStop: [item: IWorkbenchTaskTimelineItem]
  /** 用户点击清单卡的行内快捷操作（v17 Q6）。 */
  inlineAction: [item: IWorkbenchViewTimelineItem, actionId: string]
  /** 用户点击了空态建议问题（v17 H1；内容作为用户消息发送）。 */
  suggestion: [text: string]
}>()

const timelineRef = ref<HTMLElement | null>(null)
/** 用户上翻阅读历史时暂停自动滚动。 */
const stickToBottom = ref(true)

// 时间线内容变化（新块插入 / 流式增长）时自动滚到底。
watch(() => props.items.length, scrollToBottomIfStuck)
watch(
  () =>
    props.items.map((item) => item.status + itemSeqSignature(item)).join('|'),
  scrollToBottomIfStuck,
)

/** 提取流式块的内容签名，让文本增长也能触发滚动监听。 */
function itemSeqSignature(item: TWorkTimelineItem): string {
  if (
    item.kind === 'thinking' ||
    item.kind === 'content' ||
    item.kind === 'tool'
  ) {
    return String(item.text.length)
  }
  if (item.kind === 'command') {
    return String(item.stdout.length + item.stderr.length)
  }
  return ''
}

async function scrollToBottomIfStuck(): Promise<void> {
  if (!stickToBottom.value) return
  await nextTick()
  const el = timelineRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 监听容器滚动：用户上翻即暂停自动滚动，回到底部恢复。 */
function onScroll(): void {
  const el = timelineRef.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}
</script>

<template>
  <div ref="timelineRef" class="work-timeline" @scroll="onScroll">
    <div class="timeline-inner">
      <div v-if="items.length === 0" class="timeline-empty">
        <IconFont class="empty-icon" :name="EMPTY_TIMELINE_ICON" :size="42" />
        <p class="empty-title">欢迎使用 Agent 工作台</p>
        <p class="empty-hint">
          在下方输入你的需求，Agent 的工作过程将实时展示在这里。
        </p>
        <!-- v17 H1：可点击的建议问题；加载失败时组件不渲染任何东西 -->
        <TimelineSuggestions
          v-if="props.suggestionsEnabled"
          @pick="(text) => emit('suggestion', text)"
        />
      </div>
      <div v-for="item in items" :key="item.blockId" class="timeline-item">
        <TurnDivider v-if="item.kind === 'turn'" :item="item" />
        <ThinkingBlock v-else-if="item.kind === 'thinking'" :item="item" />
        <ToolBlock v-else-if="item.kind === 'tool'" :item="item" />
        <TodoBlock v-else-if="item.kind === 'todo'" :item="item" />
        <CommandBlock v-else-if="item.kind === 'command'" :item="item" />
        <AskUserQuestion
          v-else-if="item.kind === 'interaction'"
          :item="item"
          @answer="(id, value) => emit('answer', id, value)"
        />
        <!-- v16：动作卡片（可点击入口）与任务卡片（执行 / 生成） -->
        <WorkbenchActionCard
          v-else-if="item.kind === 'workbench_action'"
          :item="item"
          :busy="pendingActionId === item.actionId"
          @trigger="(actionItem) => emit('action', actionItem)"
        />
        <WorkbenchTaskCard
          v-else-if="item.kind === 'workbench_task'"
          :item="item"
          @batch-confirm="(value) => emit('batchConfirm', value)"
          @batch-cancel="(value) => emit('batchCancel', value)"
          @batch-stop="(value) => emit('batchStop', value)"
          @open-report="(input) => emit('openReport', input)"
        />
        <!-- v16：报告卡片是与执行卡片平级的独立一张（记结果，不记过程） -->
        <WorkbenchReportCard
          v-else-if="item.kind === 'workbench_report'"
          :item="item"
          @open-report="(input) => emit('openReport', input)"
        />
        <!-- v17：只读视图卡（清单 / 详情 / 历史 / 体检 / 能力） -->
        <WorkbenchViewCard
          v-else-if="item.kind === 'workbench_view'"
          :item="item"
          :pending-action-id="pendingActionId"
          @inline-action="
            (viewItem, actionId) => emit('inlineAction', viewItem, actionId)
          "
          @open-report="(input) => emit('openReport', input)"
        />
        <!-- v17：提案卡（等用户确认后才生效的写操作入口） -->
        <WorkbenchProposalCard
          v-else-if="item.kind === 'workbench_proposal'"
          :item="item"
          :busy="pendingActionId === item.proposalId"
          @apply="(value, envValues) => emit('proposalApply', value, envValues)"
          @cancel="(value) => emit('proposalCancel', value)"
          @request-confirm="(value) => emit('proposalConfirmRequest', value)"
        />
        <NoticeItem v-else-if="item.kind === 'notice'" :item="item" />
        <!-- 兜底：新增块种类若漏加分派，会静默落到 ContentBlock（v17 的两个
             新分支必须排在这一行之前）。 -->
        <ContentBlock v-else :item="item" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.work-timeline {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px var(--space-page);
}
/* 内容居中列：大屏下限制宽度，避免事件卡片横向拉满、观感松散 */
.timeline-inner {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.timeline-empty {
  flex: 1;
  min-height: 340px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  color: var(--color-ink-muted);
}
/* 颜色继承 .timeline-empty 的中性墨色；字号走 size prop（原为 emoji 的 42px） */
.empty-icon {
  line-height: 1;
  margin-bottom: 8px;
}
.empty-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 16px;
  font-weight: 600;
}
.empty-hint {
  margin: 0;
  font-size: 13.5px;
  max-width: 360px;
}
.timeline-item {
  flex-shrink: 0;
}
@media (max-width: 760px) {
  .work-timeline {
    padding: 16px var(--space-md);
  }
}
</style>

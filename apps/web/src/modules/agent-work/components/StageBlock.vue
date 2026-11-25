<!--
  阶段区块（PRD 5.3）：承载「过程」（思考、工具调用、命令），**可折叠**。

  运行中始终展开、内容实时增长；到达终态后自动折叠，点击标题行可展开回看。

  产物卡片**不可以**收起来——过程可略读，结果必须始终可见（PRD 5.3）。

  **标题行在两种折叠状态下渲染完全相同的内容**（`StageBlockHead`）：阶段名、
  实时统计与状态徽标常驻。统计的秒数由 `useNowTicker` 每秒推进——事件流是离散的，
  模型推理静默期不会有事件到达，只靠事件驱动会让秒数卡住不动。

  阶段进度由**标题行状态徽标**与**页脚阶段文案**两处表达，不再内嵌
  Agent 工作台的连接状态条（`StatusBar`）：它是按会话观察视图设计的，
  放在阶段区块内既与状态徽标重复，又会在终态下自相矛盾——
  阶段已完成而事件流已断开时，它会同时显示「已完成」与「实时/空闲」。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import type { TAgentInteractionAnswer } from '@authine-e2e-agent/types'
import type { IStageRecord } from '../../../modules/generation-flow/types'
import { isTerminalStatus } from '../../../modules/generation-flow/types'
import { summarizeStage } from '../../../modules/generation-flow/card-model'
import { useNowTicker } from '../../../common/time/useNowTicker'
import StageBlockHead from './StageBlockHead.vue'
import WorkTimeline from './WorkTimeline.vue'

const props = defineProps<{
  /** 该阶段在侧边栏中的呈现记录。 */
  stage: IStageRecord
}>()

const emit = defineEmits<{
  /** 用户点击「停止 Agent」。 */
  cancel: []
  /** 用户回答了阶段时间线中的交互卡片（v14：单问题 string / 多问题回答表）。 */
  answer: [interactionId: string, value: TAgentInteractionAnswer]
}>()

/**
 * 折叠状态。
 *
 * 终态自动折叠；用户手动展开后**不再**自动折叠回去——用户显式展开
 * 说明正在回看历史，此时再收起会打断阅读（PRD 5.3）。
 */
const collapsed = ref(false)
/** 是否已被用户手动展开过（决定终态是否仍自动折叠）。 */
let manuallyExpanded = false

// `immediate`：侧边栏收起期间阶段可能已到达终态，重新展开时挂载的区块
// 一开始就是终态，同样应折叠回摘要行，否则用户会看到一大片已结束的时间线。
watch(
  () => props.stage.status,
  (status) => {
    if (isTerminalStatus(status) && !manuallyExpanded && !collapsed.value) {
      collapsed.value = true
    }
  },
  { immediate: true },
)

/** 阶段是否已到终态（决定是否还需要实时计时）。 */
const terminal = computed(() => isTerminalStatus(props.stage.status))

// 仅在运行中计时：终态下统计完全由已定型的 `durationMs` 得出，再每秒推进
// 就是白烧 CPU——侧边栏不会因阶段结束而卸载本组件。
const { now } = useNowTicker({ enabled: computed(() => !terminal.value) })

/** 标题行的实时统计文案（已思考 N 秒 · N 次工具调用 · N 次命令执行）。 */
const summary = computed(() =>
  summarizeStage(props.stage.timeline.items.value, {
    now: now.value,
    running: !terminal.value,
  }),
)

/** 阶段状态徽标：进行中 / 已完成 / 失败 / 已停止。 */
const statusTag = computed(() => {
  const status = props.stage.status
  if (status === 'completed')
    return { type: 'success' as const, text: '已完成' }
  if (status === 'failed' || status === 'conflict')
    return { type: 'error' as const, text: '失败' }
  if (status === 'cancelled')
    return { type: 'default' as const, text: '已停止' }
  return { type: 'info' as const, text: '进行中' }
})

/**
 * 切换折叠状态；用户手动展开即视为接管，后续终态不再自动折叠。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  if (!collapsed.value) manuallyExpanded = true
}
</script>

<template>
  <section class="stage-block" :class="{ collapsed }" :aria-label="stage.title">
    <!-- 标题行整行即折叠开关；两态内容一致（见 StageBlockHead） -->
    <StageBlockHead
      class="stage-block__head"
      :title="stage.title"
      :collapsed="collapsed"
      :summary="summary"
      :status="statusTag"
      @toggle="toggleCollapsed"
    />

    <!-- 折叠后只保留标题行；展开时展示流式工作区 -->
    <template v-if="!collapsed">
      <WorkTimeline
        class="stage-block__timeline"
        :items="stage.timeline.items.value"
        @answer="(id, value) => emit('answer', id, value)"
      />
      <div class="stage-block__footer">
        <!-- 阶段文案作为确定性提示：让用户不看时间线也知道当前处于哪一步 -->
        <span class="stage-block__stage-text">{{ stage.stageText }}</span>
        <n-button
          v-if="stage.cancelable"
          size="tiny"
          secondary
          type="error"
          @click="emit('cancel')"
        >
          停止 Agent
        </n-button>
        <span
          v-else-if="stage.status !== 'completed'"
          class="stage-block__locked-hint"
        >
          此阶段正在校验或写入文件，请等待完成。
        </span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.stage-block {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-panel);
  background: var(--color-surface);
  overflow: hidden;
  transition: border-color var(--motion-standard) var(--ease-out);
}

.stage-block__timeline {
  max-height: 320px;
  border-top: 1px solid var(--color-border);
}

.stage-block__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-well);
}

.stage-block__stage-text {
  min-width: 0;
  overflow: hidden;
  color: var(--color-ink-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stage-block__locked-hint {
  flex-shrink: 0;
  color: var(--color-ink-muted);
  font-size: 12px;
}
</style>

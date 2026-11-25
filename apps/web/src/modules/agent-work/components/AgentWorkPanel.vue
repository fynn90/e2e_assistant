<!-- Agent 工作面板：状态条 + 工作时间线 + 可选输入区的可复用组合，供 Agent 工作台整页与全局侧边栏 Chat 复用。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useRouter } from 'vue-router'
import type {
  ISkillSummary,
  TAgentInteractionAnswer,
} from '@authine-e2e-agent/types'
import ChatComposer from '../../../common/chat/ChatComposer.vue'
import { useAgentWorkStore } from '../../../stores/agent-work'
import {
  answerAgentInteraction,
  applyAgentProposal,
  cancelAgentBatch,
  cancelAgentProposal,
  confirmAgentBatch,
  runAgentWorkbenchAction,
  stopAgentBatch,
} from '../../../services/agent-work-api'
import SkillCreateModal from '../../skills/SkillCreateModal.vue'
import { createSkillDevelopmentDefaultLocation } from '../../../router/skill-development-navigation'
import type {
  IWorkbenchActionTimelineItem,
  IWorkbenchProposalTimelineItem,
  IWorkbenchTaskTimelineItem,
  IWorkbenchViewTimelineItem,
} from '../timeline'
import StatusBar from './StatusBar.vue'
import WorkTimeline from './WorkTimeline.vue'
import ReportDialog from './ReportDialog.vue'
import WorkbenchProposalConfirmModal from './WorkbenchProposalConfirmModal.vue'

const props = withDefaults(
  defineProps<{
    /**
     * 是否展示输入区（交互模式）。
     * 工作台整页为 true；全局侧边栏 Chat 为观察入口时为 false（v7 侧边栏只观察生成任务，对话执行留待 v8）。
     */
    interactive?: boolean
  }>(),
  { interactive: true },
)

const store = useAgentWorkStore()
const message = useMessage()
const router = useRouter()
const draft = ref('')
/** 正在处理的动作 ID（禁用该卡片按钮，避免重复点击）。 */
const pendingActionId = ref<string>('')

/** 创建用例弹窗（v16 LOG-3：唯一允许离开对话流的动作）。 */
const createModalVisible = ref(false)

/** 报告弹窗的目标（为空时不展示弹窗）。 */
const reportTarget = ref<{
  skillId: string
  skillTitle: string
  runId: string
} | null>(null)
const reportVisible = ref(false)

/**
 * 生成进行中（v16 GEN-7）：存在 running 的生成任务时禁用输入区并提示。
 *
 * 为什么只拦生成不拦执行：生成会操作浏览器与文件，期间接受新指令会让
 * 会话与子任务互相干扰；执行是旁观型任务，用户可以在等待时继续对话。
 */
const generating = computed(() =>
  store.items.some(
    (item) =>
      item.kind === 'workbench_task' &&
      item.taskKind === 'generation' &&
      item.taskStatus === 'running',
  ),
)

/** 输入区禁用条件：正在生成，或消息发送中。 */
const composerDisabled = computed(() => store.sending || generating.value)
/** 输入区占位提示。 */
const composerPlaceholder = computed(() =>
  generating.value ? '正在生成…' : undefined,
)

/**
 * 发送消息：无当前会话时创建新会话，否则续接新一轮。
 * @param content 用户输入的文本。
 * @returns 发送完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleSend(content: string): Promise<void> {
  draft.value = ''
  try {
    await store.sendMessage(content)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '发送消息失败。')
  }
}

/**
 * 中止当前会话的轮次。
 * @returns 中止请求完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleAbort(): Promise<void> {
  try {
    await store.abort()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '中止失败。')
  }
}

/**
 * 提交交互卡片的回答。
 * @param interactionId 交互卡片 ID。
 * @param answer 用户选择或填写的回答（v14：单问题 string / 多问题回答表）。
 * @returns 提交完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleAnswer(
  interactionId: string,
  answer: TAgentInteractionAnswer,
): Promise<void> {
  if (!store.sessionId) return
  try {
    await answerAgentInteraction(store.sessionId, interactionId, answer)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '提交回答失败。')
  }
}

/**
 * 点击动作卡片：调用动作接口并反馈结果（v16）。
 *
 * 失败时保留卡片可点（服务端未受理，用户修复后可再点一次）；
 * 服务端的终态（动作卡片置 consumed、任务卡片出现）经事件流自动回来。
 *
 * @param item 被点击的动作卡片项。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleAction(item: IWorkbenchActionTimelineItem): Promise<void> {
  // 创建动作不走服务端执行：点击后在当前页打开创建弹窗（LOG-3 第①步）。
  // 服务端仍会收到一次「消费」调用以定格卡片，保证刷新后不再可点。
  if (item.action === 'create-skill') {
    void consumeCreateAction(item)
    createModalVisible.value = true
    return
  }

  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return

  pendingActionId.value = item.actionId
  try {
    const result = await runAgentWorkbenchAction(sessionId, item.actionId, {
      // 覆盖确认（GEN-10）由服务端在卡片上以 requiresConfirm 标注；
      // 既然该卡片的按钮文案就是「确认覆盖」，点击本身即用户确认。
      ...(item.requiresConfirm ? { confirmOverwrite: true } : {}),
    })
    if (!result.ok) {
      message.warning(result.message)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 定格「创建用例」卡片为已消费（LOG-3 第②步的准备）。
 *
 * 失败不阻断弹窗：卡片状态是体验优化，创建本身才是用户目的。
 *
 * @param item 被点击的创建动作卡片。
 * @returns 请求完成后兑现的 Promise。
 * @throws 不抛出异常（错误仅提示）。
 */
async function consumeCreateAction(
  item: IWorkbenchActionTimelineItem,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId) return
  try {
    await runAgentWorkbenchAction(sessionId, item.actionId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败。')
  }
}

/**
 * 创建成功后跳转到该用例的开发页（LOG-3 第②步）。
 *
 * 原对话流已持久化在服务端（每轮事件都已物化落盘），用户返回 `/agent`
 * 时可在会话列表中找到并继续——因此这里直接跳转，不需要额外的保存动作。
 *
 * @param skill 新建的用例摘要。
 * @returns 无返回值。
 * @throws 不抛出异常（路由失败由 Vue Router 处理）。
 */
function handleCreated(skill: ISkillSummary): void {
  createModalVisible.value = false
  void router.push(createSkillDevelopmentDefaultLocation(skill.id))
}

/**
 * 打开报告弹窗（v16 RPT-3）。
 * @param input 报告所属的 Skill 与运行时间戳。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleOpenReport(input: {
  skillId: string
  skillTitle: string
  runId: string
}): void {
  reportTarget.value = input
  reportVisible.value = true
}

/** 提案二次确认弹框的目标（为空时不展示）。 */
const confirmTarget = ref<IWorkbenchProposalTimelineItem | null>(null)
const confirmVisible = ref(false)

/**
 * 应用提案（v17 D2）：**唯一触发写操作的路径**。
 *
 * `ok: false` 时服务端已把提案置为 conflict / failed 并通过事件流重发卡片，
 * 因此这里只提示原因，不做本地状态改写（避免与事件流抢同一份真相）。
 *
 * @param item 待应用的提案卡片。
 * @param envValues env-fill 的用户填值（值直达平台，不入对话与日志）。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleProposalApply(
  item: IWorkbenchProposalTimelineItem,
  envValues?: Record<string, string>,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = item.proposalId
  try {
    const result = await applyAgentProposal(sessionId, item.proposalId, {
      ...(envValues ? { envValues } : {}),
    })
    if (!result.ok) {
      // 冲突 / 失败的原因由服务端给出；卡片会随事件流转到对应的终态。
      message.warning(result.message)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '应用提案失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 取消提案（v17）：卡片上的「取消」按钮走这里，提案置为 cancelled。
 *
 * 弹框内取消**不走这里**（技术方案 §7.2：提案仍是 pending，用户还能再点）。
 *
 * @param item 待取消的提案卡片。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleProposalCancel(
  item: IWorkbenchProposalTimelineItem,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = item.proposalId
  try {
    await cancelAgentProposal(sessionId, item.proposalId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '取消提案失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 提案需要二次弹框确认（v17 D2 / L1a / L2a）：在面板层弹模态。
 *
 * 弹框挂在面板层而不是卡片内：模态是**独立于卡片**的一道闸，卡片只表达意图
 * （N3：「卡片上的一次点击不足以构成确认」）。
 *
 * @param item 待确认的提案卡片。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleProposalConfirmRequest(
  item: IWorkbenchProposalTimelineItem,
): void {
  confirmTarget.value = item
  confirmVisible.value = true
}

/**
 * 弹框内确认：关闭弹框并发出 apply 请求（唯一触发写操作的路径）。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常。
 */
async function handleProposalConfirmed(
  item: IWorkbenchProposalTimelineItem,
): Promise<void> {
  confirmVisible.value = false
  confirmTarget.value = null
  await handleProposalApply(item)
}

/**
 * 确认开始连续执行（v17 R4a）。
 * @param item 批次任务卡片。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleBatchConfirm(
  item: IWorkbenchTaskTimelineItem,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = item.taskId
  try {
    const result = await confirmAgentBatch(sessionId, item.taskId)
    if (!result.ok) {
      message.warning(result.message ?? '无法开始这个批次。')
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '开始连续执行失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 取消待确认的连续执行（v17 R4a）：不产生任何执行记录。
 * @param item 批次任务卡片。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleBatchCancel(
  item: IWorkbenchTaskTimelineItem,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = item.taskId
  try {
    await cancelAgentBatch(sessionId, item.taskId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '取消连续执行失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 停止连续执行（v17 R4e）：终止整个批次，剩余条目标记为未执行。
 * @param item 批次任务卡片。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleBatchStop(
  item: IWorkbenchTaskTimelineItem,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = item.taskId
  try {
    await stopAgentBatch(sessionId, item.taskId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '停止连续执行失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 点击清单卡的行内快捷操作（v17 Q6）。
 *
 * 与服务端「登记与呈现解耦」的约定配套：动作记录由宿主在渲染清单时预先登记，
 * 因此这里直接走既有的动作接口，**不产生新的对话轮次**。
 *
 * @param item 清单卡（视图卡）项。
 * @param actionId 该行的动作登记 ID。
 * @returns 处理完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleInlineAction(
  _item: IWorkbenchViewTimelineItem,
  actionId: string,
): Promise<void> {
  const sessionId = store.sessionId
  if (!sessionId || pendingActionId.value) return
  pendingActionId.value = actionId
  try {
    const result = await runAgentWorkbenchAction(sessionId, actionId)
    if (!result.ok) {
      message.warning(result.message)
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败。')
  } finally {
    pendingActionId.value = ''
  }
}

/**
 * 点击空态建议问题（v17 H1）：填入输入区并直接发送。
 *
 * 走既有发送路径（store.sendMessage），因此与手打一句话完全同构——
 * 不留一条「建议问题专用」的旁路。
 *
 * @param text 建议问题文本。
 * @returns 发送完成后兑现的 Promise。
 * @throws 不主动抛出异常，请求错误统一以全局消息提示。
 */
async function handleSuggestion(text: string): Promise<void> {
  if (store.sending) return
  draft.value = text
  await handleSend(text)
}
</script>

<template>
  <section class="agent-work-panel" aria-label="Agent 工作面板">
    <StatusBar
      :activity="store.activity"
      :label="store.activityLabel"
      :connection="store.connection"
      @abort="handleAbort"
    />
    <WorkTimeline
      :items="store.items"
      :pending-action-id="pendingActionId"
      :suggestions-enabled="props.interactive"
      @answer="handleAnswer"
      @action="handleAction"
      @open-report="handleOpenReport"
      @proposal-apply="handleProposalApply"
      @proposal-cancel="handleProposalCancel"
      @proposal-confirm-request="handleProposalConfirmRequest"
      @batch-confirm="handleBatchConfirm"
      @batch-cancel="handleBatchCancel"
      @batch-stop="handleBatchStop"
      @inline-action="handleInlineAction"
      @suggestion="handleSuggestion"
    />
    <div v-if="props.interactive" class="work-composer">
      <p v-if="generating" class="composer-hint">
        正在生成…完成前不接受新指令（可在生成卡片上中止）。
      </p>
      <div class="composer-inner">
        <ChatComposer
          v-model="draft"
          :disabled="composerDisabled"
          :streaming="store.isRunning"
          :placeholder="composerPlaceholder"
          @send="handleSend"
          @stop="handleAbort"
        />
      </div>
    </div>

    <!-- 报告弹窗（v16 RPT-3）：挂在面板层，与时间线解耦 -->
    <ReportDialog
      v-if="reportTarget"
      v-model:show="reportVisible"
      :skill-id="reportTarget.skillId"
      :skill-title="reportTarget.skillTitle"
      :run-id="reportTarget.runId"
    />

    <!-- 提案二次确认弹框（v17 D2）：与卡片解耦的第二道闸；
         弹框内取消只关窗、不调任何接口 -->
    <WorkbenchProposalConfirmModal
      v-model:show="confirmVisible"
      :proposal="confirmTarget"
      @confirm="handleProposalConfirmed"
    />

    <!-- 创建用例弹窗（v16 LOG-3：唯一允许离开对话流的动作） -->
    <SkillCreateModal
      v-model:show="createModalVisible"
      @success="handleCreated"
    />
  </section>
</template>

<style scoped>
.agent-work-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--color-surface);
}
.work-composer {
  flex-shrink: 0;
  padding: 12px 0 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}
.composer-hint {
  width: 100%;
  max-width: 860px;
  margin: 0 auto 8px;
  padding: 0 var(--space-page);
  color: var(--color-ink-muted);
  font-size: 12.5px;
}
.composer-inner {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  padding: 0 var(--space-page);
}
@media (max-width: 760px) {
  .composer-inner,
  .composer-hint {
    padding: 0 var(--space-md);
  }
}
</style>

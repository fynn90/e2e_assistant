<!--
  工作台完成提示的宿主（v13 PRD N 组、技术方案 §3.9.3/3.9.4）。

  **为什么需要独立组件**：`App.vue` **渲染**了 `n-notification-provider`，
  因此它自身不在该 provider 的子树里，`useNotification()` 在它的 `setup` 中
  取不到注入。必须在 provider **之内**放一个子组件来消费通知。

  **为什么不能放在抽屉组件里**（这是本需求的要害）：抽屉用 `v-if` 控制显隐，
  收起时组件不渲染，挂在它上面的 watch 会随之消失——而需求要的恰恰是
  「工作台**收起**时才提示」。因此监听必须落在一个始终挂载的宿主上。

  职责边界：本组件只做「终态 → 提示」的投递与「任务运行中离开页面」的提醒，
  不含任何业务判定；「工作台是否展开」与「去重」统一收敛在发布器里，
  两个来源共用；「是否有任务在跑」收敛在 `workbench-running`。

  **页签卸载守卫也挂在这里**（v13 需求 1）：它同样必须常驻——
  挂在抽屉里的话，抽屉收起时守卫就没了，而那正是需要它的场景
  （收起后用户以为没在跑，随手刷新）。
-->
<script setup lang="ts">
import { h, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton } from 'naive-ui'
import { createWorkbenchNoticePublisher } from '../composables/useWorkbenchNotice'
import { useWorkbenchUnloadGuard } from '../composables/useWorkbenchUnloadGuard'
import { isAnyAgentTaskRunning } from '../modules/agent-work/workbench-running'
import { useGlobalChatStore } from '../stores/global-chat'
import { useExecutionStore } from '../stores/execution'
import { useGenerationFlowStore } from '../stores/generation-flow'
import { createSkillDevelopmentReportLocation } from '../router/skill-development-navigation'

const globalChat = useGlobalChatStore()
const executionStore = useExecutionStore()
const generationFlow = useGenerationFlowStore()
const router = useRouter()

/**
 * 任务运行中离开页面的守卫（v13 需求 1）。
 *
 * 用户刷新或关闭页签时，若仍有 Agent 任务在跑，浏览器会弹出原生确认。
 * 文案由浏览器决定，应用无法自定义——这是 `beforeunload` 的固有限制。
 */
useWorkbenchUnloadGuard({ isWorking: isAnyAgentTaskRunning })

/**
 * 完成提示发布器。
 *
 * 在 `setup` 中**同步**创建：`useNotification()` 依赖注入只在同步的 setup
 * 调用链上可用，放进 watch 回调会取不到。
 */
const publisher = createWorkbenchNoticePublisher(() => globalChat.visible)

/**
 * 工作台内容被清空时，去重表随之重置（对应 PRD N-8 的边界）。
 *
 * 不清的话，清空工作台后再跑到相同终态的键会被误判为「已提示过」——
 * 而清空后是**新的工作项**，同一个终态应当能再次通知。
 */
watch(
  () => globalChat.subject,
  (next, previous) => {
    if (previous !== null && next === null) publisher.forgetAll()
  },
)

/**
 * 渲染通知里的「查看报告」入口（PRD N-7）。
 *
 * 跳转目标为**通知记录的来源 Skill**，与用户当前所在页面无关——这是
 * v9 从路由取 skillId 的写法在全局化后必须改掉的地方。
 *
 * @param skillId - 来源 Skill。
 * @param reportRelativePath - 报告在该 Skill 内的相对路径。
 * @returns 按钮的 VNode；路径非法时返回 null。
 * @throws 不抛出异常。
 */
function renderReportAction(skillId: string, reportRelativePath: string) {
  const runId = reportRelativePath.split('/')[1]
  if (!runId) return null

  return h(
    NButton,
    {
      text: true,
      size: 'small',
      type: 'primary',
      onClick: () =>
        void router.push(createSkillDevelopmentReportLocation(skillId, runId)),
    },
    { default: () => '查看报告' },
  )
}

onMounted(() => {
  // 生成侧：阶段终态由 store 派发过来（store 不直接依赖 UI 组件族）。
  generationFlow.setTerminalNoticeSink((input) => publisher.publish(input))
})

onBeforeUnmount(() => {
  generationFlow.setTerminalNoticeSink(null)
})

/**
 * 执行侧：消费执行 store 的终态通知。
 *
 * 与生成侧的差别：执行的通知由 `execution` store 自行产生（它已有三态判定），
 * 这里只负责转投给发布器。
 *
 * `dismissNotification()` **无论是否实际提示都要调用**——否则「工作台展开时不提示」
 * 会让通知滞留在 store 里，等用户收起工作台后被翻出来补提示一次。
 */
watch(
  () => executionStore.lastNotification,
  (notification) => {
    if (!notification) return

    publisher.publish({
      subject: {
        kind: 'execution',
        skillId: notification.skillId,
        ...(notification.skillTitle
          ? { skillTitle: notification.skillTitle }
          : {}),
        executionId: notification.executionId,
      },
      kind: notification.kind,
      notice: {
        title: notification.skillTitle
          ? `「${notification.skillTitle}」${notification.message}`
          : notification.message,
        ...(notification.reportRelativePath
          ? {
              action: () =>
                renderReportAction(
                  notification.skillId,
                  notification.reportRelativePath as string,
                ),
            }
          : {}),
      },
      // 以执行 ID 去重：同一 Skill 先后跑两次是两次独立的工作项。
      dedupeKey: `execution:${notification.executionId}`,
    })

    executionStore.dismissNotification()
  },
)
</script>

<template>
  <!-- 纯逻辑组件：不渲染任何自己的 DOM -->
</template>

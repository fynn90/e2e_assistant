/**
 * `/agent` 会话终态的全局提示通道（v17 PRD C7）。
 *
 * 与 v13 工作台提示的关系（PRD C7 末句 + v13 N-9）：两套提示各自负责自己的任务
 * 来源，互不重复——工作台发起的任务不进 `/agent`、不产生本通道的提示；`/agent`
 * 发起的任务不进工作台、不产生工作台提示。因此本模块**不是**对
 * `useWorkbenchNotice` 的扩展，而是并列的第二条通道（**不改动它**）。
 *
 * 发布前的判定（三条，全部收敛在这里，避免调用点各自实现）：
 *   1. 用户正停留在 `/agent`（页面已挂载）时**不提示**——避免噪音（C7）；
 *   2. 只有「运行 → 终态」的迁移才提示：历史恢复的旧终态不算；
 *      页面已离开时由 store 写入 `pendingNotice`，本通道只负责把它发出去；
 *   3. 取走即清空（`takePendingNotice`），同一条终态不会弹两次。
 */
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { h } from 'vue'
import { NButton } from 'naive-ui'
import { useGlobalNotice } from './useGlobalNotice'
import {
  useAgentWorkStore,
  type IPendingTerminalNotice,
} from '../stores/agent-work'
import { WORKBENCH_ROUTE_NAMES } from '../router/workbench-navigation'
import { createSkillDevelopmentReportLocation } from '../router/skill-development-navigation'

/** 任务种类的展示名（提示标题里说明「是哪个任务」，C7）。 */
const TASK_KIND_LABELS: Record<IPendingTerminalNotice['taskKind'], string> = {
  execution: '执行',
  generation: '生成',
  batch: '连续执行',
}

/** 任务终态的结果文案。 */
const TASK_STATUS_LABELS: Record<IPendingTerminalNotice['taskStatus'], string> =
  {
    completed: '已完成',
    failed: '失败',
    interrupted: '已中断',
  }

/**
 * 把终态映射到提示样式（失败红、中断黄、完成绿）。
 *
 * @param notice - 待发布的任务终态。
 * @returns 提示样式。
 * @throws 不抛出异常。
 */
function noticeKind(
  notice: IPendingTerminalNotice,
): 'success' | 'warning' | 'error' {
  if (notice.taskStatus === 'failed') return 'error'
  if (notice.taskStatus === 'interrupted') return 'warning'
  return 'success'
}

/**
 * 安装 `/agent` 会话终态的全局提示。
 *
 * 必须在**应用级常驻组件**的 setup 中调用（`useNotification` 依赖注入只在
 * 同步的 setup 调用链上可用）；组件卸载时 watch 自动停止。
 *
 * @returns 无返回值。
 * @throws 在未挂载 `n-notification-provider` 的上下文中调用时，
 *         naive-ui 的 `useNotification` 自身会抛出。
 */
export function useAgentSessionWatch(): void {
  const store = useAgentWorkStore()
  const notice = useGlobalNotice()
  const router = useRouter()

  watch(
    () => store.pendingNotice,
    (pending) => {
      // 取走即清空：无论是否真的发出提示，都不能让它滞留在 store 里
      //（否则用户回到 /agent 再离开时会被翻出来补提示一次）。
      const current = store.takePendingNotice()
      if (!current) return
      // 用户正在 /agent 页面：不出提示（C7；页面已挂载即为「正在看」）。
      if (store.viewAttached) return

      const title = `「${current.skillTitle || '未命名用例'}」${TASK_KIND_LABELS[current.taskKind]}${TASK_STATUS_LABELS[current.taskStatus]}`
      const payload = {
        title,
        action: () =>
          h(
            NButton,
            {
              text: true,
              size: 'small',
              type: 'primary',
              onClick: () => goToNoticeTarget(router, current),
            },
            { default: () => (current.runId ? '查看报告' : '回到该会话') },
          ),
      }

      const kind = noticeKind(current)
      if (kind === 'success') notice.success(payload)
      else if (kind === 'warning') notice.warning(payload)
      else notice.error(payload)
    },
    // immediate 不需要：pendingNotice 初始为 null，watch 只在变化时触发。
  )
}

/**
 * 跳转到提示的目标：有报告去报告页，否则回到 `/agent` 会话列表。
 *
 * `router` 由调用方注入而不是在这里 `useRouter()`：本函数在**点击回调**里执行，
 * 那时已不在组件 setup 的同步调用链上，`inject` 取不到路由实例。
 *
 * @param router - 应用路由实例（setup 期取得的）。
 * @param notice - 待发布的任务终态。
 * @returns 无返回值。
 * @throws 不抛出异常（路由失败由 Vue Router 处理）。
 */
function goToNoticeTarget(
  router: ReturnType<typeof useRouter>,
  notice: IPendingTerminalNotice,
): void {
  // 报告页需要 skillId + runId；两者齐全时才直跳，否则回 `/agent`。
  if (notice.runId && notice.skillId) {
    void router.push(
      createSkillDevelopmentReportLocation(notice.skillId, notice.runId),
    )
    return
  }
  // 回 `/agent` 即回到该会话：store 是应用级单例，`detachView` 在有任务时
  // **保留了 sessionId 与整条时间线**（只是卸载了视图），因此页面重新挂载后
  // 看到的就是这个会话的内容，不需要额外的「自动选中」通道。
  void router.push({ name: WORKBENCH_ROUTE_NAMES.agent })
}

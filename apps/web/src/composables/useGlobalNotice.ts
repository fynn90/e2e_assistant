/**
 * 全局完成通知（notice）的适配层（v13 PRD N 组）。
 *
 * 与 `useGlobalMessage` 的分工：两者是**不同的组件族与语义**——message 是
 * 「操作反馈」（短、居中、淡入），notice 是「任务完成告知」（停留更久、
 * 顶部右侧滑入、可含操作入口）。合并成一个会让调用点无法从名字判断
 * 自己得到的是哪种呈现。
 *
 * **为什么必须是 notification 而不是 message**（技术方案 §3.9.1）：
 *   1. message 的入场动效是「淡入 + 高度展开」，**不满足** PRD N-3 的
 *      「滑行进入」；notification 在 `top-right` 下的入场动效正是
 *      从 `translateX(100%)` 滑到 `0`，原生满足。
 *   2. message 的 `placement` 是 **provider 级**属性，改它会连带改变全站
 *      所有 message 的位置；而全站尚未使用 notification，改它零影响。
 */
import { useNotification } from 'naive-ui'
import type { NotificationApiInjection } from 'naive-ui/es/notification/src/NotificationProvider'
import type { VNodeChild } from 'vue'

/**
 * 完成通知的最短停留时长（PRD N-4：不少于 6 秒）。
 *
 * **必须显式传入**：naive-ui 的 notification 在 `duration` 缺省时
 * 取值 `undefined`，即**永不自动关闭**——漏传会导致提示一直挂在屏幕上。
 */
const NOTICE_DURATION_MS = 6000

/** 一条完成通知的内容。 */
export interface IGlobalNoticeInput {
  /** 标题（一句话说明「是什么任务、结果如何」，PRD N-6）。 */
  title: string
  /** 补充说明（可选），如失败原因摘要、统计数字。 */
  description?: string | (() => VNodeChild)
  /** 操作区（可选），如「查看报告」按钮（PRD N-7）。 */
  action?: () => VNodeChild
  /**
   * 用户手动关闭时回调。
   *
   * 用于通知消失后释放调用方持有的资源（如按钮上用到的路由句柄）。
   */
  onClose?: () => void
}

/** 完成通知方法集合。 */
export interface IGlobalNotice {
  /** 成功提示（PRD N-5）。 */
  success: (input: IGlobalNoticeInput) => void
  /** 警告提示（用户主动停止、执行中断等）。 */
  warning: (input: IGlobalNoticeInput) => void
  /** 错误提示（失败、冲突）。 */
  error: (input: IGlobalNoticeInput) => void
  /** 原生实例（备用）。 */
  raw: NotificationApiInjection
}

/**
 * 创建全局完成通知方法集合。
 *
 * @returns 三态通知方法。
 * @throws 在未挂载 `n-notification-provider` 的上下文中调用时，
 *         naive-ui 的 `useNotification` 自身会抛出。
 */
export function useGlobalNotice(): IGlobalNotice {
  const notice = useNotification()

  /**
   * 组装 notification 的通用选项。
   *
   * @param input - 通知内容。
   * @returns 可供三态方法复用的选项对象。
   * @throws 不抛出异常。
   */
  function toOptions(
    input: IGlobalNoticeInput,
  ): Parameters<NotificationApiInjection['success']>[0] {
    return {
      title: input.title,
      duration: NOTICE_DURATION_MS,
      // 鼠标悬停时不自动消失：用户可能正在阅读或准备点击「查看报告」（PRD N-4）。
      keepAliveOnHover: true,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.onClose ? { onClose: input.onClose } : {}),
    }
  }

  return {
    success(input) {
      notice.success(toOptions(input))
    },
    warning(input) {
      notice.warning(toOptions(input))
    },
    error(input) {
      notice.error(toOptions(input))
    },
    raw: notice,
  }
}

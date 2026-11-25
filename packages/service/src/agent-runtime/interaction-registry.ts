/**
 * 交互注册表：管理等待用户回答的前端交互。
 *
 * Agent 侧（ask_user_question 工具 / toolGuard 确认拦截）通过 waitForAnswer
 * 挂起等待；回答 API 通过 answer 唤醒对应 Promise。超时按约定值自动回答，
 * 会话中止时全部以中止语义结束。
 *
 * v14（D5/F23）：回答值放宽为 TAgentInteractionAnswer——单问题形态仍是 string
 * （v8 语义不变），多问题形态为以 questionId 为键的回答表；取消哨兵是 string，
 * 两种形态通用。
 *
 * 注册表是内存结构：pending 交互的可展示状态由 WorkBlockStore 持久化，
 * 进程重启后由路由层恢复 pending 卡片并允许用户重新回答。
 */

import type { TAgentInteractionAnswer } from '@fynn90-e2e_assistant/types'

/** 等待中的交互句柄。 */
interface IPendingInteraction {
  /** 唤醒回答的 resolve。 */
  resolve: (value: TAgentInteractionAnswer) => void
  /** 中止/异常时的 reject。 */
  reject: (error: Error) => void
  /** 超时定时器。 */
  timer?: ReturnType<typeof setTimeout>
}

/** 交互注册表接口。 */
export interface IInteractionRegistry {
  /**
   * 登记并挂起等待一个交互的回答。
   *
   * @param sessionId - 会话 ID。
   * @param interactionId - 交互 ID。
   * @param options.timeoutMs - 超时毫秒数；缺省不超时。
   * @param options.timeoutValue - 超时自动回答值；缺省超时视为拒绝（'no'）。
   * @returns 用户（或超时自动）的回答值。
   */
  waitForAnswer (
    sessionId: string,
    interactionId: string,
    options?: { timeoutMs?: number; timeoutValue?: string },
  ): Promise<TAgentInteractionAnswer>
  /**
   * 提交一个交互的回答。
   *
   * @param sessionId - 会话 ID。
   * @param interactionId - 交互 ID。
   * @param answer - 回答值（单问题 string / 多问题回答表 / 取消哨兵）。
   * @returns 是否命中等待中的交互（未命中说明不存在或已回答）。
   */
  answer (
    sessionId: string,
    interactionId: string,
    answer: TAgentInteractionAnswer,
  ): boolean
  /** 会话中止时结束全部等待中的交互。 */
  abortAll (sessionId: string): void
}

/** 注册表键：sessionId + interactionId 复合。 */
function keyOf (sessionId: string, interactionId: string): string {
  return `${sessionId}${interactionId}`
}

/**
 * 创建交互注册表。
 *
 * @returns 注册表实例。
 */
export function createInteractionRegistry (): IInteractionRegistry {
  const pending = new Map<string, IPendingInteraction>()

  return {
    waitForAnswer (sessionId, interactionId, options = {}) {
      const key = keyOf(sessionId, interactionId)
      return new Promise<TAgentInteractionAnswer>((resolve, reject) => {
        const entry: IPendingInteraction = { resolve, reject }
        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(key)
            resolve(options.timeoutValue ?? 'no')
          }, options.timeoutMs)
        }
        pending.set(key, entry)
      })
    },

    answer (sessionId, interactionId, answer) {
      const key = keyOf(sessionId, interactionId)
      const entry = pending.get(key)
      if (!entry) return false
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(key)
      entry.resolve(answer)
      return true
    },

    abortAll (sessionId) {
      for (const [key, entry] of pending) {
        if (!key.startsWith(`${sessionId}`)) continue
        if (entry.timer) clearTimeout(entry.timer)
        pending.delete(key)
        entry.reject(new Error('会话已中止'))
      }
    },
  }
}

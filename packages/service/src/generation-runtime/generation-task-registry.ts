/**
 * 生成任务注册表：保证同一工作区同一时间只有一个 Playwright 生成任务。
 *
 * 产品规则（PRD 4.3 末条）：
 *   同一工作区同一时间只允许一个生成任务运行，避免多个浏览器和试运行任务
 *   争用用户本机资源。第二个并发的生成请求会被明确拒绝，而不是排队或静默并行。
 *
 * 与 ChatConcurrencyGate 的区别：后者服务于 Chat 对话的吞吐限流（可并发多条），
 * 本注册表是生成任务的排他锁——同一 Skill 上重复提交必须失败。
 */

import { ApiError } from '../shared/errors/api-error'

/** 一次生成任务的占用租约。 */
export interface IGenerationTaskLease {
  /** 本次任务的会话 ID（供事件关联与释放时校验）。 */
  readonly sessionId: string
  /**
   * 释放占用。
   *
   * @returns 无返回值；重复调用安全。
   * @throws 不抛出异常。
   */
  release(): void
}

/** 生成任务注册表接口。 */
export interface IGenerationTaskRegistry {
  /**
   * 为指定 Skill 占用一个生成任务名额。
   *
   * @param skillId - 目标 Skill ID。
   * @param sessionId - 本次生成任务的会话 ID。
   * @returns 占用租约；调用方必须在任务终态释放。
   * @throws ApiError 当该 Skill 已有生成任务运行时抛出 CHAT_CONCURRENCY_LIMITED。
   */
  acquire(skillId: string, sessionId: string): IGenerationTaskLease
  /**
   * 查询指定 Skill 是否有正在运行的生成任务。
   *
   * @param skillId - 目标 Skill ID。
   * @returns 正在运行的任务会话 ID；空闲时返回 undefined。
   * @throws 不抛出异常。
   */
  currentSessionId(skillId: string): string | undefined
}

/**
 * 创建生成任务注册表。
 *
 * @returns 进程内生成任务注册表实例。
 * @throws 不抛出异常。
 */
export function createGenerationTaskRegistry(): IGenerationTaskRegistry {
  /** Skill ID → 正在运行的生成会话 ID。 */
  const runningTasks = new Map<string, string>()

  return {
    acquire(skillId: string, sessionId: string): IGenerationTaskLease {
      const existing = runningTasks.get(skillId)

      if (existing) {
        throw new ApiError({
          code: 'CHAT_CONCURRENCY_LIMITED',
          status: 429,
          // v11：执行任务与生成任务共用本注册表（技术方案 D7），文案双向覆盖。
          message: '当前 Skill 已有生成/执行任务正在运行，请等待其结束。',
        })
      }

      runningTasks.set(skillId, sessionId)
      let released = false

      return {
        sessionId,
        release: (): void => {
          if (released) {
            return
          }

          released = true

          // 只释放自己占用的名额：若期间被其他任务接管，不覆盖对方的登记。
          if (runningTasks.get(skillId) === sessionId) {
            runningTasks.delete(skillId)
          }
        },
      }
    },

    currentSessionId(skillId: string): string | undefined {
      return runningTasks.get(skillId)
    },
  }
}

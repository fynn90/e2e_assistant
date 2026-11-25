/**
 * 兼容旧内部引用的 chat 任务启动适配器。
 *
 * AgentService 已统一只暴露 chat；本文件保留薄适配器，避免旧源码导入在迁移期间
 * 直接失效，实际任务始终使用 chat 操作类型。
 */

import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentTaskRunner } from '../task/task-runner'
import type { IAgentTaskHandle, IAgentTaskStartOptions } from '../task/types'

/** 旧 update 调用方可复用的任务启动选项。 */
export interface IUpdateSkillOptions extends IAgentTaskStartOptions {}

/** 旧 update 调用方可复用的任务句柄类型。 */
export type IUpdateSkillHandle = IAgentTaskHandle

/**
 * 通过 chat 操作类型启动一轮任务。
 *
 * @param runner - 多轮任务运行器。
 * @param prompt - 首轮用户输入。
 * @param options - 会话 ID、插件和系统提示词覆盖选项。
 * @returns 已自动启动首轮的 chat 任务句柄。
 * @throws {Error} 当会话 ID 冲突或任务运行器拒绝创建任务时抛出。
 */
export function createE2EUpdateSkill(
  runner: AgentTaskRunner,
  prompt: string | import('@earendil-works/pi-agent-core').AgentMessage[],
  options?: IUpdateSkillOptions,
): IUpdateSkillHandle {
  const sessionId = options?.sessionId ?? uuidv7()
  const handle = runner.getOrCreate(sessionId, 'chat', options)
  // 自动启动首轮；句柄同步记录 result，调用方可 await 或通过 send 多轮续接。
  void handle.send(prompt)
  return handle
}

/**
 * chat 类型任务的业务门面。
 *
 * 本模块只做 chat 的业务编排：把用户输入接入任务运行器，按「chat」操作类型
 * 获取/创建任务并自动启动首轮，返回支持多轮对话的任务句柄。
 * 多轮引擎（会话持久化、轮次串行化、断点续跑）由 src/task 提供，本模块保持薄封装。
 */

import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentTaskRunner } from '../task/task-runner'
import type { IAgentTaskHandle, IAgentTaskStartOptions } from '../task/types'

/**
 * chat 类型任务的可选配置。
 *
 * sessionId 是同一会话多轮对话的主键：同一 sessionId 的多次调用复用同一会话；缺省自动生成
 * 并暴露在返回句柄上。plugins / systemPrompt 仅在会话首次创建时生效，
 * 其中 systemPrompt 常用于注入 skill 上下文（如 file tree、当前文件）。
 */
export interface IChatOptions extends IAgentTaskStartOptions {}

/**
 * chat 类型任务句柄。
 *
 * 在 IAgentTaskHandle 基础上保留 result（首轮 Promise）与 loop 字段。
 */
export type IChatHandle = IAgentTaskHandle

/**
 * 发起一轮普通对话任务。
 *
 * 按 sessionId 获取/创建 chat 类型任务并自动启动首轮；后续轮通过句柄 send/continue 续接，
 * 同一会话的历史自动保留。
 *
 * @param runner  - 多轮任务运行器（由 AgentService 组合配置、运行时与会话存储）。
 * @param prompt  - 用户输入文本或一条/多条 AgentMessage 消息，作为首轮的启动内容。
 * @param options - 可选配置：sessionId、Harness 插件集合与系统提示词覆盖。
 * @returns 已自动启动首轮的任务句柄；调用方可订阅事件、等待首轮结果或继续多轮对话。
 * @throws {Error} 当 workspace 为空时由 AgentFactory 抛出；sessionId 冲突时由运行器抛出。
 */
export function createE2EChat(
  runner: AgentTaskRunner,
  prompt: string | import('@earendil-works/pi-agent-core').AgentMessage[],
  options?: IChatOptions,
): IChatHandle {
  const sessionId = options?.sessionId ?? uuidv7()
  // 操作类型由调用方声明（缺省 chat：SKILL 内部的会话）。
  // 工作台会话传 'workbench'，并随 workbench 字段带来它自己的能力装配。
  const handle = runner.getOrCreate(
    sessionId,
    options?.operateType ?? 'chat',
    options,
  )
  // 自动启动首轮；句柄同步记录 result，调用方可 await 或通过 send 继续多轮。
  void handle.send(prompt)
  return handle
}

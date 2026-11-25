/**
 * 多轮任务引擎的类型定义。
 *
 * 定义「任务 = 一个会话（sessionId）+ 一个 AgentLoop + 一份持久化历史」的
 * 句柄契约与运行器配置，供 AgentService 的 chat 业务门面复用。
 * 任务不再引入独立的任务 ID：会话 ID（sessionId）即任务与对话的唯一标识。
 */

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AgentLoop,
  AgentLoopListener,
  IAgentLoopResult,
} from '../loop/agent-loop'
import type { AgentOperateType } from '../agents/types'
import type { IAgentBaseConfig } from '../agents/types'
import type { IAgentModelRuntime } from '../model'
import type { ISessionStore } from '../harness/interfaces'

/**
 * 任务生命周期状态。
 *
 * idle     —— 任务已创建，尚未开始轮次或最近一轮已结束；
 * running  —— 正在执行一轮（模型/工具循环中）；
 * completed—— 调用方已 dispose，任务不再接收新轮次；
 * aborted  —— 最近一轮被中止；
 * error    —— 最近一轮以错误结束。
 */
export type ITaskStatus = 'idle' | 'running' | 'completed' | 'aborted' | 'error'

/**
 * 任务内部状态对象：runner 与句柄共享引用，runner 在轮次前后更新状态。
 */
export interface IAgentTaskState {
  status: ITaskStatus
}

/**
 * 多轮任务句柄：同一任务内多轮对话的一等入口。
 *
 * 一个任务对应一个会话与一个 AgentLoop；`send` 在任务内追加新的一轮（自动带上历史），
 * `continue` 从当前上下文续跑（重试/继续工具循环）。任务在 `dispose` 前保持打开。
 */
export interface IAgentTaskHandle<TAppEvent = AgentEvent> {
  /** 会话 ID：任务与对话的唯一标识，也是会话持久化主键。 */
  readonly sessionId: string
  /** 任务的操作类型，目前由 AgentService.chat 统一设置为 chat。 */
  readonly operateType: AgentOperateType
  /** 底层 Agent 主循环，供需要深入控制的上层直接使用。 */
  readonly loop: AgentLoop<TAppEvent>
  /** 任务当前生命周期状态。 */
  readonly status: ITaskStatus
  /** 最近一次启动的轮次结果；尚未启动任何轮次时为 undefined。 */
  result: Promise<IAgentLoopResult> | undefined

  /** 在任务内启动/续接一轮：第一轮由 chat 门面自动启动，后续轮用本方法。 */
  send(input: string | AgentMessage[]): Promise<IAgentLoopResult>
  /** 从当前上下文续跑（重试/继续工具循环），不追加新的用户消息。 */
  continue(): Promise<IAgentLoopResult>
  /** 订阅任务运行期间的事件（翻译后的应用事件或原始 AgentEvent）。 */
  subscribe(listener: AgentLoopListener<TAppEvent>): () => void
  /** 中止当前运行的轮次。 */
  abort(): void
  /** 等待当前轮次与所有订阅者全部结束。 */
  waitForIdle(): Promise<void>
  /** 当前会话完整消息快照（数组副本）。 */
  snapshot(): AgentMessage[]
  /** 释放任务：标记完成、中止运行并从运行器注册表移除。 */
  dispose(): Promise<void>
}

/**
 * Agent 基础配置工厂：按操作类型与工作区构建系统提示词与工具集。
 *
 * @param operateType - 任务的操作类型（chat：SKILL 内；workbench：工作台）。
 * @param workspace   - 任务绑定的工作区目录。
 * @param sessionId   - 会话 ID，可用于按会话注入上下文。
 * @param extraTools  - 额外追加到工具集的工具（v11：Skill Chat 注入 execute_test 等）。
 * @param shellPath   - bash 可执行文件绝对路径（CLI 启动时探测注入）；缺省由
 *   NodeExecutionEnv 按平台默认规则探测。
 * @param workbench   - 工作台会话的能力装配（v16）；operateType 为 'workbench' 时必填。
 * @returns Agent 基础配置（系统提示词与工具列表）。
 */
export type IAgentConfigFactory = (
  operateType: AgentOperateType,
  workspace: string,
  sessionId?: string,
  extraTools?: import('@earendil-works/pi-agent-core').AgentTool<any>[],
  shellPath?: string,
  workbench?: import('../agents/types').IWorkbenchAgentAssembly,
) => IAgentBaseConfig

/**
 * 任务启动的共享可选项。
 *
 * chat 门面使用这些选项创建或复用会话；systemPrompt 允许按会话覆盖系统提示词。
 */
export interface IAgentTaskStartOptions {
  /** 会话 ID；同一会话的多轮对话复用同一 sessionId，缺省自动生成。 */
  sessionId?: string
  /** Harness 插件集合；仅在任务首次创建时生效。 */
  plugins?: import('../harness/interfaces').IHarnessPlugins
  /** 覆盖 Agent 系统提示词；仅在任务首次创建时生效。 */
  systemPrompt?: string
  /**
   * 会话的操作类型（v16）；缺省 'chat'（单个 e2e SKILL 内部的会话）。
   *
   * 决定由哪个 Agent 配置承载本会话（见 agents/factory.ts）。只在会话首建生效：
   * 已存在的会话沿用创建时的类型，传入不同类型会被 `getOrCreate` 拒绝。
   */
  operateType?: import('../agents/types').AgentOperateType
  /**
   * 工作台会话的能力装配（v16）；`operateType` 为 'workbench' 时必填。
   *
   * 为什么随创建参数传入而不是走全局注册表：工具与提示词都绑定本会话的宿主
   * （执行宿主、动作宿主按会话寻址），且只在会话首建时装配一次——
   * 显式传参让「谁在什么时候装配了什么」在调用点一目了然。
   */
  workbench?: import('../agents/types').IWorkbenchAgentAssembly
}

/**
 * 任务运行器构造选项。
 */
export interface IAgentTaskRunnerOptions {
  /** 构建 Agent 基础配置的工厂（系统提示词 + 工具）。 */
  configFactory: IAgentConfigFactory
  /** 任务统一绑定的工作区目录。 */
  workspace: string
  /** 共享模型运行时（模型 + 流式调用 + 思考等级）。 */
  modelRuntime: IAgentModelRuntime
  /** 共享会话存储：任务断点续跑与历史持久化的兜底实现。 */
  sessionStore: ISessionStore
  /** 透传给配置工厂的额外工具（v11：Skill Chat 注入 execute_test 等）；缺省不追加。 */
  extraTools?: import('@earendil-works/pi-agent-core').AgentTool<any>[]
  /** 透传给配置工厂的 bash 可执行文件绝对路径；缺省由 NodeExecutionEnv 按平台默认规则探测。 */
  shellPath?: string
}

/**
 * 多轮任务句柄实现。
 *
 * AgentTaskHandle 是任务的对外门面：持有底层 AgentLoop 与共享任务状态引用，
 * 将 send/continue 委托给运行器做轮次串行化，并把事件订阅、中止、等待与消息快照
 * 透传到底层 loop。句柄本身不包含业务逻辑，保持薄封装。
 */

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AgentLoop,
  AgentLoopListener,
  IAgentLoopResult,
} from '../loop/agent-loop'
import type { AgentOperateType } from '../agents/types'
import type { IAgentTaskHandle, IAgentTaskState } from './types'

/**
 * 任务句柄构造选项。
 *
 * sendTurn / continueTurn / onDispose 由运行器注入，负责轮次串行化、状态流转与
 * 注册表清理；状态通过共享的 IAgentTaskState 引用读写。
 */
export interface IAgentTaskHandleOptions<TAppEvent = AgentEvent> {
  /** 会话 ID：任务与对话的唯一标识，同时作为会话持久化主键。 */
  sessionId: string
  /** 任务的业务操作类型。 */
  operateType: AgentOperateType
  /** 底层 Agent 主循环。 */
  loop: AgentLoop<TAppEvent>
  /** 与运行器共享的任务状态对象。 */
  state: IAgentTaskState
  /** 启动/续接一轮的实际执行函数（含串行化与状态流转）。 */
  sendTurn: (input: string | AgentMessage[]) => Promise<IAgentLoopResult>
  /** 从当前上下文续跑的实际执行函数（含串行化与状态流转）。 */
  continueTurn: () => Promise<IAgentLoopResult>
  /** 释放回调：标记完成、中止运行并从运行器注册表移除。 */
  onDispose: () => Promise<void>
}

/**
 * 多轮任务句柄。
 *
 * @typeParam TAppEvent - 应用层事件类型；未配置事件适配器时为 AgentEvent。
 */
export class AgentTaskHandle<
  TAppEvent = AgentEvent,
> implements IAgentTaskHandle<TAppEvent> {
  readonly sessionId: string
  readonly operateType: AgentOperateType
  readonly loop: AgentLoop<TAppEvent>

  /** 最近一次启动的轮次结果；尚未启动任何轮次时为 undefined。 */
  result: Promise<IAgentLoopResult> | undefined = undefined

  /** 与运行器共享的任务状态。 */
  private readonly state: IAgentTaskState

  /** 轮次执行委托（含串行化与状态流转）。 */
  private readonly sendTurn: (
    input: string | AgentMessage[],
  ) => Promise<IAgentLoopResult>
  private readonly continueTurn: () => Promise<IAgentLoopResult>
  /** 释放回调。 */
  private readonly onDispose: () => Promise<void>

  /**
   * @param options - 会话 ID、操作类型、底层 loop、共享状态与运行器注入的委托。
   */
  constructor(options: IAgentTaskHandleOptions<TAppEvent>) {
    this.sessionId = options.sessionId
    this.operateType = options.operateType
    this.loop = options.loop
    this.state = options.state
    this.sendTurn = options.sendTurn
    this.continueTurn = options.continueTurn
    this.onDispose = options.onDispose
  }

  /** 任务当前生命周期状态（与运行器共享引用）。 */
  get status(): import('./types').ITaskStatus {
    return this.state.status
  }

  /**
   * 在任务内启动/续接一轮，并记录为本任务最近一轮结果。
   *
   * @param input - 用户文本或一条/多条 AgentMessage 消息。
   * @returns 本轮运行结束后的会话消息与错误信息。
   * @throws {Error} 当任务已结束（dispose）或底层模型/工具执行失败时抛错。
   */
  send(input: string | AgentMessage[]): Promise<IAgentLoopResult> {
    return this.track(this.sendTurn(input))
  }

  /**
   * 从当前上下文续跑，并记录为本任务最近一轮结果。
   *
   * @returns 本轮运行结束后的会话消息与错误信息。
   * @throws {Error} 当最后一条消息不符合继续运行前提，或模型/工具执行失败时抛错。
   */
  continue(): Promise<IAgentLoopResult> {
    return this.track(this.continueTurn())
  }

  /**
   * 订阅任务运行期间的事件（翻译后的应用事件）。
   *
   * @param listener - 事件监听器。
   * @returns 取消订阅函数。
   */
  subscribe(listener: AgentLoopListener<TAppEvent>): () => void {
    return this.loop.subscribe(listener)
  }

  /** 中止当前运行的轮次。 */
  abort(): void {
    this.loop.abort()
  }

  /** 等待当前轮次与所有已订阅事件监听器全部结束。 */
  waitForIdle(): Promise<void> {
    return this.loop.waitForIdle()
  }

  /** 当前会话完整消息快照（数组副本）。 */
  snapshot(): AgentMessage[] {
    return [...this.loop.agent.state.messages]
  }

  /**
   * 释放任务：标记完成、中止运行并从运行器注册表移除。
   */
  async dispose(): Promise<void> {
    await this.onDispose()
  }

  /**
   * 记录轮次结果并防止未 await 的拒绝触发未处理告警。
   *
   * 附加的空 catch 只标记 Promise 已处理；调用方 await 时仍会正常收到 rejection。
   *
   * @param turn - 一轮运行的 Promise。
   * @returns 原样返回的轮次 Promise。
   */
  private track(turn: Promise<IAgentLoopResult>): Promise<IAgentLoopResult> {
    this.result = turn
    turn.catch(() => undefined)
    return turn
  }
}

/**
 * 多轮任务运行器。
 *
 * 以「会话」为单位管理多轮对话：每个会话（sessionId）对应一个复用的 AgentLoop
 * 与一份持久化历史。运行器负责：
 *   - 会话注册表：按 sessionId 复用句柄，保证同一会话的多轮共享同一历史；
 *   - 轮次串行化：同一会话并发 send/continue 排队执行，避免全量快照互相覆盖；
 *   - 状态流转：轮次前后更新任务生命周期状态。
 *
 * AgentService 通过 configFactory / workspace / modelRuntime / sessionStore 组合本运行器，
 * 业务门面（chat）只负责按操作类型获取/创建会话并启动首轮。
 */

import { createAgentLoop } from '../loop/agent-loop'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { IAgentModelRuntime } from '../model'
import type { ISessionStore } from '../harness/interfaces'
import type { AgentOperateType } from '../agents/types'
import { AgentTaskHandle } from './task-handle'
import type {
  IAgentConfigFactory,
  IAgentTaskRunnerOptions,
  IAgentTaskState,
} from './types'

/**
 * 任务运行器。
 *
 * @remarks 同一会话禁止并发轮次：send/continue 通过 per-session 队列串行执行。
 * 不同会话之间互不影响，可并行运行。
 */
export class AgentTaskRunner {
  /** 会话注册表：sessionId -> 任务句柄。 */
  private readonly tasks = new Map<string, AgentTaskHandle>()

  private readonly configFactory: IAgentConfigFactory
  private readonly workspace: string
  private readonly modelRuntime: IAgentModelRuntime
  private readonly sessionStore: ISessionStore
  /** 透传给配置工厂的额外工具（v11：Skill Chat 注入 execute_test 等）。 */
  private readonly extraTools?: import('@earendil-works/pi-agent-core').AgentTool<any>[]
  /** 透传给配置工厂的 bash 可执行文件绝对路径（CLI 启动时探测注入）。 */
  private readonly shellPath?: string

  /**
   * @param options - 配置工厂、工作区、共享模型运行时与会话存储。
   */
  constructor(options: IAgentTaskRunnerOptions) {
    this.configFactory = options.configFactory
    this.workspace = options.workspace
    this.modelRuntime = options.modelRuntime
    this.sessionStore = options.sessionStore
    this.extraTools = options.extraTools
    this.shellPath = options.shellPath
  }

  /**
   * 获取或创建任务句柄。
   *
   * 已存在的会话直接复用（操作类型须一致）；否则按操作类型构建 Agent 配置并创建新会话。
   *
   * @param sessionId - 会话 ID，任务与对话的唯一标识，同时作为会话持久化主键。
   * @param operateType - 任务的业务操作类型。
   * @param taskOptions - 可选启动配置：插件集合与系统提示词覆盖，仅在会话首次创建时生效。
   * @returns 任务句柄（同一 sessionId 返回同一实例）。
   * @throws {Error} 当 sessionId 已存在但操作类型不一致时抛出。
   */
  getOrCreate(
    sessionId: string,
    operateType: AgentOperateType,
    taskOptions: Pick<
      import('./types').IAgentTaskStartOptions,
      'plugins' | 'systemPrompt' | 'workbench'
    > = {},
  ): AgentTaskHandle {
    const existing = this.tasks.get(sessionId)
    if (existing) {
      if (existing.operateType !== operateType) {
        throw new Error(
          `会话 ${sessionId} 已存在且操作类型为 ${existing.operateType}，不能复用为 ${operateType}`,
        )
      }
      return existing
    }
    return this.createTask(sessionId, operateType, taskOptions)
  }

  /**
   * 查询指定任务句柄。
   *
   * @param sessionId - 会话 ID。
   * @returns 任务句柄；不存在返回 undefined。
   */
  getTask(sessionId: string): AgentTaskHandle | undefined {
    return this.tasks.get(sessionId)
  }

  /**
   * 列出当前所有任务句柄。
   *
   * @returns 任务句柄数组。
   */
  listTasks(): AgentTaskHandle[] {
    return [...this.tasks.values()]
  }

  /**
   * 移除并释放指定会话。
   *
   * @param sessionId - 会话 ID。
   */
  async removeTask(sessionId: string): Promise<void> {
    const handle = this.tasks.get(sessionId)
    if (handle) {
      await handle.dispose()
    }
  }

  /**
   * 创建新会话任务：构建 Agent 配置与主循环，装配句柄与轮次队列。
   *
   * @param sessionId - 会话 ID。
   * @param operateType - 任务的业务操作类型。
   * @param taskOptions - 可选启动配置：插件集合与系统提示词覆盖（首建生效）。
   * @returns 新建的任务句柄。
   */
  private createTask(
    sessionId: string,
    operateType: AgentOperateType,
    taskOptions: Pick<
      import('./types').IAgentTaskStartOptions,
      'plugins' | 'systemPrompt' | 'workbench'
    > = {},
  ): AgentTaskHandle {
    const baseConfig = this.configFactory(
      operateType,
      this.workspace,
      sessionId,
      this.extraTools,
      this.shellPath,
      taskOptions.workbench,
    )
    const agentConfig =
      taskOptions.systemPrompt !== undefined
        ? { ...baseConfig, systemPrompt: taskOptions.systemPrompt }
        : baseConfig
    const loop = createAgentLoop(agentConfig, this.modelRuntime, {
      sessionId,
      // 未显式提供 sessionStore 时兜底使用运行器共享的持久化存储，
      // 避免部分插件覆盖导致任务历史退回 Noop 丢失。
      plugins: { sessionStore: this.sessionStore, ...taskOptions.plugins },
    })

    // 任务状态：句柄与运行器共享引用，由运行器在轮次前后更新。
    const state: IAgentTaskState = { status: 'idle' }

    // per-session 轮次队列：串行执行；单轮失败不卡死后续轮次。
    let queueTail: Promise<unknown> = Promise.resolve()
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      const run = queueTail.then(() => operation())
      queueTail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    // 显式标注 handle 类型，打破「句柄在其自身构造参数中被引用」导致的隐式 any 推断。
    const handle: AgentTaskHandle = new AgentTaskHandle({
      sessionId,
      operateType,
      loop,
      state,
      sendTurn: (
        input: string | AgentMessage[],
      ): Promise<import('../loop/agent-loop').IAgentLoopResult> =>
        this.executeTurn(handle, state, enqueue, () =>
          loop.run(sessionId, input),
        ),
      continueTurn: (): Promise<
        import('../loop/agent-loop').IAgentLoopResult
      > =>
        this.executeTurn(handle, state, enqueue, () =>
          loop.continue(sessionId),
        ),
      onDispose: async () => {
        state.status = 'completed'
        loop.abort()
        this.tasks.delete(sessionId)
      },
    })

    this.tasks.set(sessionId, handle)
    return handle
  }

  /**
   * 在轮次队列中执行一轮，并流转任务状态。
   *
   * @param handle - 任务句柄（用于错误消息定位）。
   * @param state - 共享任务状态。
   * @param enqueue - per-session 队列入口。
   * @param operation - 实际执行主循环的操作函数。
   * @returns 本轮运行结果。
   * @throws {Error} 当任务已结束，或底层模型/工具执行失败时抛错。
   */
  private async executeTurn(
    handle: AgentTaskHandle,
    state: IAgentTaskState,
    enqueue: <T>(operation: () => Promise<T>) => Promise<T>,
    operation: () => Promise<import('../loop/agent-loop').IAgentLoopResult>,
  ): Promise<import('../loop/agent-loop').IAgentLoopResult> {
    return enqueue(async () => {
      if (state.status === 'completed' || state.status === 'aborted') {
        throw new Error(`会话 ${handle.sessionId} 已结束，无法继续发送消息`)
      }
      state.status = 'running'
      try {
        const result = await operation()
        // 运行以错误收尾（errorMessage 非空）时视为 error，否则回到 idle。
        state.status = result.errorMessage ? 'error' : 'idle'
        return result
      } catch (error) {
        state.status = 'error'
        throw error
      }
    })
  }
}

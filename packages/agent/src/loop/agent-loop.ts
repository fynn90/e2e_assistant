/**
 * Agent 主循环模块。
 *
 * 本模块是「核心驱动 + 插件组合根」：封装 pi-agent-core 的 Agent，
 * 将 Agent 基础配置（系统提示词 + 工具）与模型运行时（模型 + 流式调用函数 + 思考等级）
 * 组合为可运行的 Agent 对象；同时把 Harness 各插件接到 Agent 的扩展点上，
 * 并在 run 生命周期中编排「会话恢复 → 执行（带重试）→ 持久化 → 观测」。
 *
 * 核心只依赖插件接口（见 harness/interfaces.ts），不依赖具体实现；
 * 未配置的插件由 resolver 用 Noop 默认补齐，向后兼容。
 */

import {
  Agent,
  uuidv7,
  type AgentEvent,
  type AgentMessage,
} from '@earendil-works/pi-agent-core'
import type { IAgentBaseConfig } from '../agents/types'
import type { IAgentModelRuntime } from '../model'
import { resolvePlugins } from '../harness/resolver'
import type {
  IHarnessRunContext,
  IResolvedPlugins,
} from '../harness/interfaces'
import {
  ToolTraceRecorder,
  toToolCallView,
  type IToolCallRecord,
} from '../tool-trace'
import type { IToolCallView } from '@fynn90-e2e_assistant/types'

/**
 * Agent 主循环事件监听器。
 *
 * 收到的事件为事件适配层翻译后的应用事件；未配置适配器时为原始 AgentEvent。
 */
export type AgentLoopListener<TAppEvent = AgentEvent> = (
  event: TAppEvent,
  signal: AbortSignal,
) => void | Promise<void>

/**
 * 创建 Agent 主循环的可选配置。
 */
export interface IAgentLoopOptions {
  /** 会话 ID，透传给模型提供方用于缓存识别；缺省时由底层运行时不传。 */
  sessionId?: string
  /** Harness 插件集合；未配置的插槽由默认实现补齐。 */
  plugins?: import('../harness/interfaces').IHarnessPlugins
}

/**
 * 一次 prompt/continue 运行结束后的结果。
 */
export interface IAgentLoopResult {
  /** 本次运行的唯一标识，用于日志与观测关联。 */
  runId: string
  /** 运行结束后当前会话的完整消息列表（数组副本，不共享底层状态）。 */
  messages: AgentMessage[]
  /** 最近一次运行出现的错误信息；运行成功时为 undefined。 */
  errorMessage?: string
}

/**
 * Agent 主循环，封装 pi-agent-core Agent 的创建、插件编排与运行控制。
 *
 * 持有单个 pi-agent-core Agent 实例与一份已解析的插件集合；
 * 事件适配与可观测共用一条订阅通道，翻译后广播给应用层。
 */
export class AgentLoop<TAppEvent = AgentEvent> {
  /** 底层 pi-agent-core Agent 实例，供需要深入控制的上层直接使用。 */
  readonly agent: Agent

  /** 已解析（含默认实现补齐）的 Harness 插件集合。 */
  private readonly plugins: IResolvedPlugins<TAppEvent>

  /** 应用层事件监听器集合。 */
  private readonly listeners = new Set<AgentLoopListener<TAppEvent>>()

  /** 当前运行的上下文；只在 run / continue 的执行期间存在。 */
  private activeRunContext: IHarnessRunContext | undefined

  /** 当前运行的工具调用事件归并器，用于持久化与安全展示。 */
  private activeToolTraceRecorder: ToolTraceRecorder | undefined

  /** 当前运行自产事件（如轮次开始/结束）使用的取消信号源；随运行生灭。 */
  private activeRunAbort: AbortController | undefined

  /**
   * @param agentConfig - Agent 基础配置：系统提示词与可用工具。
   * @param modelRuntime - 模型运行时：模型、流式调用函数与思考等级。
   * @param options - 可选配置：会话 ID 与 Harness 插件集合。
   */
  constructor(
    agentConfig: IAgentBaseConfig,
    modelRuntime: IAgentModelRuntime,
    options: IAgentLoopOptions = {},
  ) {
    this.plugins = resolvePlugins<TAppEvent>(options.plugins)

    // 将项目自身的配置、运行时与插件扩展点组合成 pi-agent-core 可运行的 Agent。
    this.agent = new Agent({
      initialState: {
        systemPrompt: agentConfig.systemPrompt,
        model: modelRuntime.model,
        thinkingLevel: modelRuntime.thinkingLevel,
        tools: agentConfig.tools,
      },
      streamFn: modelRuntime.streamFn,
      sessionId: options.sessionId,
      // —— 上下文层：每轮调用前压缩 + 上下文接近上限时优雅收尾 ——
      transformContext: (messages, signal) =>
        this.plugins.contextPolicy.transform(messages, signal),
      shouldStopAfterTurn: (ctx) =>
        this.plugins.contextPolicy.shouldStopAfterTurn(ctx.context.messages),
      // —— 工具守卫层：执行前拦截 / 审批，执行后观测 ——
      beforeToolCall: async (ctx, signal) =>
        this.plugins.toolGuard.beforeCall?.(
          { name: ctx.toolCall.name, args: ctx.args },
          signal,
        ),
      afterToolCall: async (ctx) => {
        await this.plugins.toolGuard.afterCall?.(
          { name: ctx.toolCall.name, args: ctx.args },
          ctx.result,
        )
        return undefined
      },
    })

    // —— 工具审计 → 事件适配 → 可观测：先尝试持久化，再广播并采样用量 ——
    this.agent.subscribe(async (event, signal) => {
      await this.recordToolExecutionEvent(event)
      const appEvents = this.plugins.eventAdapter.translate(event)
      if (appEvents) {
        const list = Array.isArray(appEvents) ? appEvents : [appEvents]
        for (const appEvent of list) {
          await this.emit(appEvent, signal)
        }
      }
      // 从 assistant 消息事件中采样模型用量，交给可观测层。
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        await this.plugins.observability.onUsage?.(event.message.usage)
      }
    })
  }

  /**
   * 订阅 Agent 主循环生命周期事件（翻译后的应用事件）。
   *
   * 监听器的 promise 会纳入当前运行的结算，Agent 只有在所有事件监听器结束后才算空闲。
   *
   * @param listener - 事件监听器，接收翻译后的事件对象与当前运行的取消信号。
   * @returns 取消订阅函数；调用后不再接收后续事件。
   */
  subscribe (listener: AgentLoopListener<TAppEvent>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 用一段用户输入启动一轮运行。
   *
   * 生命周期：断点恢复（按 sessionId load 历史）→ 执行（带重试）→ 持久化（save 快照）→ 观测收尾。
   * sessionId 是历史查询与断点续跑的主键：同一对话须复用同一 sessionId。
   *
   * @param sessionId - 会话 ID，用于定位持久化的历史会话。
   * @param input - 用户文本，或一条/多条 AgentMessage 消息。
   * @returns 运行结束后的会话消息与错误信息。
   * @throws {Error} 当重试策略判定不可重试，且模型流式调用或工具执行失败时，透传底层异常。
   */
  async run (
    sessionId: string,
    input: string | AgentMessage[],
  ): Promise<IAgentLoopResult> {
    const context = this.createRunContext(sessionId, input)
    this.beginRun(context)

    try {
      await this.plugins.observability.onRunStart?.(context)
      // 事件适配层的运行开始钩子：产出「轮次开始」等 pi-agent-core 没有原始事件的生命周期事件。
      await this.emitLifecycleEvents(
        this.plugins.eventAdapter.onRunStart?.(context),
      )
      // 断点恢复：先重置内存态，再按 sessionId 加载历史作为本轮起点。
      // 这样切换到新会话时不会残留上一个会话的内存消息。
      this.agent.reset()
      const history = await this.plugins.sessionStore.load(sessionId)
      if (history.length > 0) {
        this.agent.state.messages = history
      }

      // 工具循环由 pi-agent-core 驱动：模型 toolCall → 执行工具 → toolResult 回注下一轮模型。
      await this.executeRun(context, async () => {
        if (typeof input === 'string') {
          await this.agent.prompt(input)
          return
        }
        await this.agent.prompt(input)
      })
      return await this.finishRun(context)
    } catch (error) {
      // 运行失败也要广播「轮次结束（失败）」，保证事件流消费者的组件都能收尾。
      await this.emitRunEndLifecycle(context, error)
      // 已结束或已产生的工具结果也应尽力落盘，但绝不掩盖模型/工具主错误。
      await this.persistSnapshotSafely(context)
      throw error
    } finally {
      this.endRun(context)
    }
  }

  /**
   * 从当前会话上下文继续运行，不追加新的用户消息。
   *
   * 适用于重试等场景；要求最后一条消息可转换为 user 或 toolResult，否则底层会拒绝请求。
   * 注意：continue 以当前内存状态为准，不重新加载会话存储中的历史。
   *
   * @param sessionId - 会话 ID，用于把续跑结果持久化到对应会话。
   * @returns 运行结束后的会话消息与错误信息。
   * @throws {Error} 当最后一条消息不符合继续运行前提，或模型/工具执行失败时，透传底层异常。
   */
  async continue (sessionId: string): Promise<IAgentLoopResult> {
    const context = this.createRunContext(sessionId)
    this.beginRun(context)

    try {
      await this.plugins.observability.onRunStart?.(context)
      await this.emitLifecycleEvents(
        this.plugins.eventAdapter.onRunStart?.(context),
      )
      await this.executeRun(context, () => this.agent.continue())
      return await this.finishRun(context)
    } catch (error) {
      await this.emitRunEndLifecycle(context, error)
      await this.persistSnapshotSafely(context)
      throw error
    } finally {
      this.endRun(context)
    }
  }

  /**
   * 中止当前运行。
   *
   * 未运行时不产生副作用；已运行的 prompt/continue 会以 aborted 状态结束。
   */
  abort (): void {
    this.agent.abort()
  }

  /**
   * 等待当前运行与所有已订阅事件监听器全部结束。
   */
  async waitForIdle (): Promise<void> {
    await this.agent.waitForIdle()
  }

  /**
   * 重置会话状态：清空内存消息、运行时状态与待处理的 steering/follow-up 队列。
   *
   * 仅重置内存态；如需清空持久化历史和工具调用审计，请显式调用 ISessionStore.remove()。
   */
  reset (): void {
    this.agent.reset()
  }

  /**
   * 查询当前运行中指定工具调用的完整审计记录。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @returns 当前记录副本；当前运行不存在该调用时返回 undefined。
   */
  getToolCallRecord (toolCallId: string): IToolCallRecord | undefined {
    return this.activeToolTraceRecorder?.get(toolCallId)
  }

  /**
   * 查询当前运行中指定工具调用的安全展示投影。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @returns 已脱敏、截断的展示对象；记录不存在时返回 undefined。
   */
  getToolCallView (toolCallId: string): IToolCallView | undefined {
    const record = this.getToolCallRecord(toolCallId)
    return record ? this.projectToolCall(record) : undefined
  }

  /**
   * 初始化一次运行的工具追踪上下文。
   *
   * @param context - 当前运行元信息。
   */
  private beginRun (context: IHarnessRunContext): void {
    this.activeRunContext = context
    this.activeRunAbort = new AbortController()
    this.activeToolTraceRecorder = new ToolTraceRecorder({
      sessionId: context.sessionId!,
      runId: context.runId,
      resolveToolLabel: (toolName) =>
        this.agent.state.tools.find((tool) => tool.name === toolName)?.label,
    })
  }

  /**
   * 清除与指定运行匹配的临时工具追踪上下文。
   *
   * @param context - 已结束的运行元信息。
   */
  private endRun (context: IHarnessRunContext): void {
    if (this.activeRunContext?.runId !== context.runId) return
    this.activeRunContext = undefined
    this.activeToolTraceRecorder = undefined
    this.activeRunAbort?.abort()
    this.activeRunAbort = undefined
  }

  /**
   * 广播事件适配层产出的运行生命周期事件（轮次开始/结束等）。
   *
   * @param events - 适配器钩子返回的事件（单个、数组或 null）。
   */
  private async emitLifecycleEvents (
    events: TAppEvent | TAppEvent[] | null | undefined,
  ): Promise<void> {
    if (!events) return
    const signal = this.activeRunAbort?.signal ?? new AbortController().signal
    const list = Array.isArray(events) ? events : [events]
    for (const event of list) {
      await this.emit(event, signal)
    }
  }

  /**
   * 在运行以异常收尾时广播「轮次结束」生命周期事件。
   *
   * 广播失败只静默忽略——异常路径的首要职责是透传原始错误，
   * 不能让收尾事件掩盖模型/工具主错误。
   *
   * @param context - 失败运行的上下文。
   * @param error - 导致运行失败的原始错误。
   */
  private async emitRunEndLifecycle (
    context: IHarnessRunContext,
    error: unknown,
  ): Promise<void> {
    try {
      await this.emitLifecycleEvents(
        this.plugins.eventAdapter.onRunEnd?.(
          {
            runId: context.runId,
            messages: [...this.agent.state.messages],
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
          context,
        ),
      )
    } catch {
      // 忽略收尾广播异常，保留原始错误透传。
    }
  }

  /**
   * 在原始运行失败后尽最大努力保存当前消息快照。
   *
   * @param context - 失败运行的上下文。
   * @returns 始终正常结束，保证不会覆盖原始模型或工具异常。
   */
  private async persistSnapshotSafely (
    context: IHarnessRunContext,
  ): Promise<void> {
    try {
      await this.plugins.sessionStore.save(context.sessionId!, [
        ...this.agent.state.messages,
      ])
    } catch (error) {
      await this.plugins.observability.onError?.(error, context)
    }
  }

  /**
   * 广播一个翻译后的应用事件给所有订阅者。
   *
   * @param event - 翻译后的应用事件。
   * @param signal - 当前运行的取消信号。
   */
  private async emit (event: TAppEvent, signal: AbortSignal): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event, signal)
    }
  }

  /**
   * 执行一次主循环操作，按重试策略处理失败。
   *
   * @param context - 本次运行的上下文元信息。
   * @param operation - 实际执行主循环的操作函数（prompt / continue）。
   * @throws {Error} 当重试策略判定不可重试时，上报可观测层后透传原错误。
   */
  private async executeRun (
    context: IHarnessRunContext,
    operation: () => Promise<void>,
  ): Promise<void> {
    let attempt = 0
    for (; ;) {
      try {
        await operation()
        return
      } catch (error) {
        if (await this.plugins.retryPolicy.shouldRetry(error, attempt)) {
          await sleep(await this.plugins.retryPolicy.delayMs(attempt))
          attempt += 1
          continue
        }
        await this.plugins.observability.onError?.(error, context)
        throw error
      }
    }
  }

  /**
   * 将底层工具生命周期事件归并并增量写入会话存储。
   *
   * 审计写入失败只进入可观测层，不能打断已经由 pi-agent-core 管理的工具执行和 toolResult
   * 回注流程。
   *
   * @param event - pi-agent-core 发出的生命周期事件。
   * @returns 审计成功、无需处理或失败已上报后正常结束。
   */
  private async recordToolExecutionEvent (event: AgentEvent): Promise<void> {
    if (
      event.type !== 'tool_execution_start' &&
      event.type !== 'tool_execution_update' &&
      event.type !== 'tool_execution_end'
    ) {
      return
    }

    const recorder = this.activeToolTraceRecorder
    if (!recorder) return
    const record = recorder.apply(event)
    if (!record) return

    try {
      await this.plugins.sessionStore.upsertToolCall(record)
    } catch (error) {
      const context = this.activeRunContext
      if (context) {
        await this.plugins.observability.onError?.(error, context)
      }
    }
  }

  /**
   * 将工具记录投影为客户端安全 DTO。
   *
   * @param record - 完整工具调用记录。
   * @returns 脱敏、截断后的客户端展示对象。
   */
  private projectToolCall (record: IToolCallRecord): IToolCallView {
    return toToolCallView(record)
  }

  /**
   * 运行收尾：收集结果、持久化消息快照并通知可观测层。
   *
   * @param context - 本次运行上下文。
   * @returns 包含 runId、会话消息与错误信息的运行结果。
   */
  private async finishRun (
    context: IHarnessRunContext,
  ): Promise<IAgentLoopResult> {
    const result = this.collectResult(context.runId)
    // 先广播「轮次结束」，再持久化快照：事件流消费者据此收尾组件。
    await this.emitLifecycleEvents(
      this.plugins.eventAdapter.onRunEnd?.(result, context),
    )
    await this.plugins.sessionStore.save(context.sessionId!, result.messages)
    await this.plugins.observability.onRunEnd?.(result, context)
    return result
  }

  /**
   * 收集最近一次运行结束后的会话消息与错误信息。
   *
   * @param runId - 本次运行的唯一标识。
   * @returns 当前会话消息副本与最近一次运行的错误信息。
   */
  private collectResult (runId: string): IAgentLoopResult {
    const { messages, errorMessage } = this.agent.state
    return { runId, messages: [...messages], errorMessage }
  }

  /**
   * 构建本次运行的上下文元信息。
   *
   * @param sessionId - 会话 ID（历史查询与断点续跑的主键）。
   * @param input - 本次运行输入；continue 续跑时不传。
   * @returns 运行元信息，含唯一 runId、起始时间与会话 ID。
   */
  private createRunContext (
    sessionId: string,
    input?: string | AgentMessage[],
  ): IHarnessRunContext {
    return {
      runId: uuidv7(),
      startedAt: Date.now(),
      sessionId,
      input,
    }
  }
}

/**
 * 创建 Agent 主循环实例。
 *
 * @param agentConfig - Agent 基础配置：系统提示词与可用工具。
 * @param modelRuntime - 模型运行时：模型、流式调用函数与思考等级。
 * @param options - 可选配置：会话 ID 与 Harness 插件集合。
 * @returns 已绑定配置、运行时与插件的 Agent 主循环，可直接调用 run 启动对话。
 */
export function createAgentLoop (
  agentConfig: IAgentBaseConfig,
  modelRuntime: IAgentModelRuntime,
  options?: IAgentLoopOptions,
): AgentLoop {
  return new AgentLoop(agentConfig, modelRuntime, options)
}

/**
 * 等待指定毫秒数。
 *
 * @param ms - 等待时长（毫秒）。
 * @returns 到时后 resolve 的 Promise。
 */
function sleep (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Harness 插件机制：各 Harness 能力的接口契约。
 *
 * 核心 AgentLoop 只依赖本模块定义的接口，不依赖任何具体实现；
 * 插件实现可替换、可组合，缺省由 resolver 用 Noop 默认补齐。
 *
 * 依赖方向统一为「AgentLoop → 插件接口 → 实现」，插件之间不互相依赖。
 */

import type {
  AgentEvent,
  AgentMessage,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import type { Usage } from '@earendil-works/pi-ai'
import type { IToolCallQuery, IToolCallRecord } from '../tool-trace/types'

/**
 * 一次 prompt/continue 运行的元信息，提供给可观测层与运行结果层。
 */
export interface IHarnessRunContext {
  /** 本次运行的唯一标识，用于日志与观测关联。 */
  runId: string
  /** 运行开始时间戳（毫秒）。 */
  startedAt: number
  /** 会话 ID；未配置时为 undefined。 */
  sessionId?: string
  /** 本次运行输入；continue 续跑时为 undefined。 */
  input?: string | AgentMessage[]
}

/**
 * 会话状态。
 */
export type ISessionStatus = 'active' | 'completed' | 'aborted'

/**
 * 会话元信息（写入时可选，供历史浏览与查询过滤）。
 */
export interface ISessionMeta {
  /** 关联测试用例 Skill ID。 */
  skillId?: string
  /** 工作区路径。 */
  workspace?: string
  /** 会话状态。 */
  status?: ISessionStatus
  /** 会话标题（历史浏览用）。 */
  title?: string
  /** 扩展字段。 */
  [key: string]: unknown
}

/**
 * 会话概要（列表 / 详情查询返回）。
 */
export interface ISessionSummary {
  /** 会话 ID。 */
  id: string
  /** 消息数量。 */
  messageCount: number
  status?: ISessionStatus
  skillId?: string
  workspace?: string
  title?: string
  createdAt: number
  updatedAt: number
}

/**
 * 会话查询条件（历史会话浏览）。
 */
export interface ISessionQuery {
  skillId?: string
  status?: ISessionStatus
  /** 分页页码，从 0 开始。 */
  page?: number
  pageSize?: number
}

/**
 * 会话层：对话消息持久化。
 *
 * 多会话、可查询、支持断点续跑：
 * - save/load 按 sessionId 定位会话（覆盖式快照，幂等）；
 * - listSessions / getSession 供用户浏览历史会话；
 * - 服务中断后，同一 sessionId 的数据仍在存储中，run(sessionId) 即可从断点继续。
 */
export interface ISessionStore {
  /** 插件唯一标识。 */
  readonly id: string
  /** 覆盖保存某会话的完整消息快照与元信息；会话不存在则创建。 */
  save(
    sessionId: string,
    messages: AgentMessage[],
    meta?: ISessionMeta,
  ): Promise<void>
  /** 加载某会话的完整消息；不存在返回空数组。 */
  load(sessionId: string): Promise<AgentMessage[]>
  /** 查询某会话的概要信息；不存在返回 undefined。 */
  getSession(sessionId: string): Promise<ISessionSummary | undefined>
  /** 按条件查询会话列表（默认按更新时间倒序）。 */
  listSessions(query?: ISessionQuery): Promise<ISessionSummary[]>
  /** 删除某会话及其全部消息和工具调用审计记录。 */
  remove(sessionId: string): Promise<void>
  /** 删除所有关联某 Skill 的会话及其全部消息和工具调用记录；返回被删会话 ID。 */
  removeBySkillId(skillId: string): Promise<string[]>
  /** 增量写入或更新一次工具调用事实；同一 session/run/toolCallId 覆盖更新。 */
  upsertToolCall(record: IToolCallRecord): Promise<void>
  /** 按会话查询工具调用审计记录，可选限定到单次运行。 */
  listToolCalls(
    sessionId: string,
    query?: IToolCallQuery,
  ): Promise<IToolCallRecord[]>
}

/**
 * 上下文层：token 估算与自动压缩。
 *
 * transform 在每一轮 LLM 调用前被调用，可裁剪 / 压缩消息以控制上下文窗口；
 * 原样返回表示不压缩。shouldStopAfterTurn 用于上下文接近上限时优雅结束本轮。
 */
export interface IContextPolicy {
  /** 插件唯一标识。 */
  readonly id: string
  /** 对送入模型的上下文做裁剪 / 压缩，返回处理后消息。 */
  transform(
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]>
  /** 当上下文接近上限时返回 true，本轮结束后不再启动下一轮。 */
  shouldStopAfterTurn(messages: AgentMessage[]): Promise<boolean>
}

/**
 * 重试层：错误分类与重试退避。
 *
 * shouldRetry 决定某次失败是否重试，delayMs 给出两次重试之间的等待时间。
 */
export interface IRetryPolicy {
  /** 插件唯一标识。 */
  readonly id: string
  /** 判断该错误在第 attempt 次失败后是否值得重试（attempt 从 0 开始）。 */
  shouldRetry(error: unknown, attempt: number): Promise<boolean>
  /** 第 attempt 次失败后到下次重试的等待毫秒数。 */
  delayMs(attempt: number): Promise<number>
}

/**
 * 一次运行结束时的摘要信息，供事件适配层产出运行结束类事件。
 *
 * 结构上与 loop 的 IAgentLoopResult 一致；此处独立声明以避免
 * harness 接口与 loop 模块之间的循环依赖。
 */
export interface IRunEndInfo {
  /** 本次运行的唯一标识。 */
  runId: string
  /** 运行结束后的会话消息列表。 */
  messages: AgentMessage[]
  /** 最近一次运行的错误信息；运行成功时为 undefined。 */
  errorMessage?: string
}

/**
 * 事件适配层：把 pi-agent-core 的 AgentEvent 翻译为应用层事件。
 *
 * 返回 null 表示丢弃该事件；默认实现为透传（原样返回 AgentEvent），
 * 保证未配置适配器时上层收到的是原始事件。
 *
 * 可选的 onRunStart / onRunEnd 钩子用于产出 pi-agent-core 没有对应原始事件的
 * 运行生命周期事件（如「轮次开始 / 轮次结束」），由 AgentLoop 在运行边界调用。
 */
export interface IEventAdapter<TAppEvent = unknown> {
  /** 插件唯一标识。 */
  readonly id: string
  /** 翻译单个 AgentEvent；返回 null 丢弃，数组则广播多条。 */
  translate(event: AgentEvent): TAppEvent | TAppEvent[] | null
  /** 运行开始时产出额外事件；缺省不产生。 */
  onRunStart?(context: IHarnessRunContext): TAppEvent | TAppEvent[] | null
  /** 运行结束时产出额外事件；缺省不产生。 */
  onRunEnd?(
    run: IRunEndInfo,
    context: IHarnessRunContext,
  ): TAppEvent | TAppEvent[] | null
}

/**
 * 可观测层：日志 / usage / 成本采样。
 *
 * 所有钩子均为可选；在 run 生命周期由 AgentLoop 编排调用。
 */
export interface IObservability {
  /** 插件唯一标识。 */
  readonly id: string
  /** 一次运行开始。 */
  onRunStart?(context: IHarnessRunContext): void | Promise<void>
  /** 采样到一次模型用量（从 assistant 消息事件中提取）。 */
  onUsage?(usage: Usage): void | Promise<void>
  /** 一次运行结束。 */
  onRunEnd?(result: unknown, context: IHarnessRunContext): void | Promise<void>
  /** 一次运行出错。 */
  onError?(error: unknown, context: IHarnessRunContext): void | Promise<void>
}

/**
 * 工具守卫层：工具调用前的拦截 / 审批与调用后的观测。
 *
 * beforeCall 返回 { block: true } 阻止工具执行；缺省（返回 undefined）放行。
 */
export interface IToolGuard {
  /** 插件唯一标识。 */
  readonly id: string
  /** 工具执行前调用；返回 { block: true } 阻止执行。 */
  beforeCall?(
    toolCall: { name: string; args: unknown },
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined>
  /** 工具执行后调用，用于观测或审计。 */
  afterCall?(
    toolCall: { name: string; args: unknown },
    result: unknown,
  ): void | Promise<void>
}

/**
 * Harness 插件集合：每项可独立替换，缺省由 resolver 用 Noop 实现补齐。
 */
export interface IHarnessPlugins {
  sessionStore?: ISessionStore
  contextPolicy?: IContextPolicy
  retryPolicy?: IRetryPolicy
  eventAdapter?: IEventAdapter
  observability?: IObservability
  toolGuard?: IToolGuard
}

/**
 * 经 resolver 补齐默认值后的插件集合，所有插槽必有实现。
 *
 * TAppEvent 为事件适配层翻译出的应用事件类型；未配置适配器时缺省为 AgentEvent。
 */
export interface IResolvedPlugins<TAppEvent = AgentEvent> {
  sessionStore: ISessionStore
  contextPolicy: IContextPolicy
  retryPolicy: IRetryPolicy
  eventAdapter: IEventAdapter<TAppEvent>
  observability: IObservability
  toolGuard: IToolGuard
}

/**
 * Agent 工作通道运行时：把 AgentService 的多轮会话桥接为可视化的工作事件流。
 *
 * 每个工作区（workspace）持有一个常驻运行时：
 *   - 内建一个 AgentService（SQLite 模型上下文存储，跨进程断点续跑）；
 *   - 每个会话首次创建时挂入 ClientEventTranslator（eventAdapter 插件），
 *     把 loop 事件翻译为客户端事件草稿并发布到 SessionEventBus；
 *   - 工作块物化存储（WorkBlockStore）支撑会话列表与历史时间线恢复。
 *
 * 与 skill-chat 的区别：skill-chat 是「一次请求一个运行时」的无状态模型，
 * 本会话通道是「会话跨请求存活」的服务端状态模型——上下文以服务端 SQLite 为准。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  AgentService,
  ClientEventTranslator,
  askUserRegistry,
  newBlockId,
} from '@authine-e2e-agent/agent'
import type {
  AgentOperateType,
  IChatHandle,
  IToolGuard,
  IWorkbenchAgentAssembly,
} from '@authine-e2e-agent/agent'

import type {
  IAgentSessionSummary,
  IAgentWorkBlock,
  IAgentWorkbenchTaskSummary,
  TAgentClientEvent,
  TAgentClientEventDraft,
  TAgentClientEventPayload,
  TAgentInteractionAnswer,
  TAgentSessionKind,
  TAgentWorkbenchTaskKind,
  TAgentWorkbenchTaskStatus,
} from '@authine-e2e-agent/types'
import {
  createSessionEventBus,
  type ISessionEventBus,
} from './session-event-bus'
import { createWorkBlockStore, type IWorkBlockStore } from './work-block-store'
import {
  createInteractionRegistry,
  type IInteractionRegistry,
} from './interaction-registry'
import { createAskUserHost } from './ask-user-host'

/** 会话数据库与工作块数据库在工作区下的存放目录（与 agent 层会话库同目录）。 */
export const RUNTIME_DATA_DIR = '.e2e-agent'

/** 工作通道运行时构造选项。 */
export interface IAgentWorkRuntimeOptions {
  /** Agent 工作目录（平台 projectDirectory）。 */
  workspace: string
  /** 模型名称。 */
  model: string
  /** 模型 API 根地址。 */
  apiBaseUrl: string
  /** 模型 API 密钥。 */
  apiKey: string
  /** bash 可执行文件绝对路径（CLI 启动时探测注入）；缺省由 pi-agent-core 自行探测。 */
  shellPath?: string
}

/**
 * 工作台会话的能力装配（CLI 侧别名）。
 *
 * 直接复用 agent 包导出的装配类型，避免两侧各声明一份结构相同的形状
 * （依赖方向仍为 CLI → agent，单向）。
 */
export type IWorkbenchAssembly = IWorkbenchAgentAssembly

/** 发送消息的入参。 */
export interface IAgentWorkMessageInput {
  /** 会话 ID；缺省自动生成（续接已有会话时传入）。 */
  sessionId?: string
  /** 用户消息（生成任务中为构造好的 prompt）。 */
  message: string
  /** 会话种类；缺省 'chat'。平台生成任务传 'generation'（不进会话列表）。 */
  kind?: TAgentSessionKind
  /** 会话标题预览覆盖；仅会话首建生效，避免长 prompt 被截断为标题。 */
  title?: string
  /** 仅会话首建生效的额外插件（如生成任务的文件写入白名单守卫）。 */
  plugins?: { toolGuard?: IToolGuard }
  /**
   * 工作台会话的能力装配（v16）：提供时本会话按 'workbench' 类型创建。
   *
   * 只对新会话生效（续轮时工具与守卫已装配完成，传了也被忽略）——
   * 与 `plugins` 同一时序约束，见 `AgentTaskRunner.getOrCreate`。
   */
  workbench?: IWorkbenchAgentAssembly
}

/** 发送消息的结果：会话 ID 与可等待本轮结果的任务句柄。 */
export interface IAgentWorkMessageHandle {
  /** 会话 ID（续接与订阅事件流使用）。 */
  sessionId: string
  /** 任务句柄：调用方可等待本轮结果、中止或续轮。 */
  handle: IChatHandle
}

/** 任务卡片块的发布入参（v16）。 */
export interface IWorkbenchTaskCardInput {
  /** 目标会话（卡片挂在哪个对话流上）。 */
  sessionId: string
  /** 任务 ID：执行任务为 executionId，生成任务为子会话 ID。 */
  taskId: string
  /** 任务种类（决定客户端渲染分派）。 */
  taskKind: TAgentWorkbenchTaskKind
  /** 目标 SKILL ID。 */
  skillId: string
  /** 目标 SKILL 标题。 */
  skillTitle: string
  /** 任务状态。 */
  status: TAgentWorkbenchTaskStatus
  /** 任务创建时刻（毫秒）。 */
  startedAt: number
  /** 执行任务的目标执行 ID（与 taskId 同值时仍需显式传入）。 */
  executionId?: string
  /** 终态摘要。 */
  summary?: IAgentWorkbenchTaskSummary
  /** 失败或阻断原因。 */
  errorMessage?: string
  /** 生成任务终态的产物完备性。 */
  artifacts?: { hasSkillDocument: boolean; hasPlaywrightScript: boolean }
  /** batch 专用（v17）：批次状态。 */
  batchStatus?: string
  /** batch 专用（v17）：条目清单与逐条状态。 */
  items?: unknown[]
  /** batch 专用（v17）：单批上限。 */
  batchLimit?: number
}

/**
 * 提案卡片的发布入参（v17）。
 *
 * 与动作卡片同理：状态变化以**同一 blockId** 重发本事件，客户端原位更新。
 * 载荷里**永远没有值**——env 补齐只传 key（D7 的结构性保证）。
 */
export interface IWorkbenchProposalCardInput {
  /** 提案 ID（块的 blockId 后缀，也是 apply / cancel 的路径参数）。 */
  proposalId: string
  /** 提案种类。 */
  proposalKind: string
  /** 目标会话。 */
  sessionId: string
  /** 目标 SKILL。 */
  skillId: string
  skillTitle: string
  /** 卡片标题。 */
  label: string
  description?: string
  state: string
  changes?: unknown[]
  envKeys?: Array<{ key: string; usage: string }>
  envKeyOps?: unknown[]
  requiresModalConfirm: boolean
  reportCount?: number
  releaseBytes?: number
  evidence?: unknown
  resultMessage?: string
}

/**
 * 只读视图卡片的发布入参（v17）。
 *
 * `payload` 由宿主自取后填充（协议传选择不传数据）——本运行时只负责套信封
 * 与分配 seq，不理解 payload 的内部结构。
 */
export interface IWorkbenchViewCardInput {
  sessionId: string
  /** 视图 ID（块的 blockId 后缀）。 */
  viewId: string
  viewKind: string
  skillId: string | null
  payload: Record<string, unknown>
}

/** 报告卡片的发布入参（v16）。 */
export interface IWorkbenchReportCardInput {
  /** 目标会话（卡片挂在哪个对话流上）。 */
  sessionId: string
  /** 关联的执行 ID（与执行卡片的 taskId 同值）。 */
  executionId: string
  /** 目标 SKILL ID。 */
  skillId: string
  /** 目标 SKILL 标题。 */
  skillTitle: string
  /** 执行终态（报告只在终态发布，故不含 running）。 */
  taskStatus: 'completed' | 'failed' | 'interrupted'
  /** 统计与展示数据。 */
  summary: IAgentWorkbenchTaskSummary
}

/** 工作通道运行时接口。 */
export interface IAgentWorkRuntime {
  /** 会话事件总线（SSE 路由据此订阅/补发）。 */
  readonly bus: ISessionEventBus
  /** 发送一条用户消息：会话不存在则创建，存在则续接新一轮。 */
  sendMessage(input: IAgentWorkMessageInput): IAgentWorkMessageHandle
  /**
   * 在指定会话中发布一个工作块事件（v16：工作台卡片块的唯一发布入口）。
   *
   * 服务端编排（动作卡片、任务卡片、执行终态镜像）不经过模型事件流，
   * 需要直接往父会话总线投递块事件；信封字段（sessionId / blockId / timestamp）
   * 由本方法补齐，seq 由总线分配。
   *
   * @param sessionId - 目标会话 ID（不存在时由总线按需创建通道，不报错）。
   * @param payload - 块事件载荷（工作台以 workbench_action / workbench_task 为主）。
   * @returns 已分配 seq 的完整事件（调用方可据此判断是否成功）。
   * @throws 不抛出异常。
   */
  publishBlock(
    sessionId: string,
    payload: TAgentClientEventPayload,
  ): TAgentClientEvent
  /**
   * 声明 / 更新一张执行或生成任务的卡片块状态（v16）。
   *
   * 与 {@link publishBlock} 的分工：本方法按「任务卡片」的形状组装载荷
   * （补 skillTitle、状态、摘要），避免调用方在每处重复拼字段。
   *
   * @param input - 任务卡片的目标会话、任务身份、状态与可选摘要。
   * @returns 已分配 seq 的完整事件。
   * @throws 不抛出异常。
   */
  publishTaskCard(input: IWorkbenchTaskCardInput): TAgentClientEvent
  /**
   * 发布一张报告卡片（v16，PRD RPT-2/RPT-3）。
   *
   * 与执行卡片**平级**：执行卡片记过程，报告卡片记结果，两者是对话流里
   * 先后出现的两张卡（靠 seq 排序）。报告卡片只在执行终态发布一次，不更新。
   *
   * @param input - 关联的执行、目标用例与统计摘要。
   * @returns 已分配 seq 的完整事件。
   * @throws 不抛出异常。
   */
  publishReportCard(input: IWorkbenchReportCardInput): TAgentClientEvent
  /**
   * 发布 / 更新一张提案卡片（v17）。
   *
   * 与动作卡片同理：创建时 state 为 pending，用户操作后以同一 proposalId
   * 重发本事件表达终态，客户端按 blockId 原位更新。
   *
   * @param input - 提案身份、种类、状态与人话对照。
   * @returns 已分配 seq 的完整事件。
   * @throws 不抛出异常。
   */
  publishProposalCard(input: IWorkbenchProposalCardInput): TAgentClientEvent
  /**
   * 发布 / 更新一张只读视图卡片（v17）。
   *
   * 与提案卡的分工：视图卡没有状态机（发布即终态），同一 viewId 重发即为
   * 原位更新（清单卡筛选后即走这条路）。
   *
   * @param input - 视图身份、种类与平台自取的载荷。
   * @returns 已分配 seq 的完整事件。
   * @throws 不抛出异常。
   */
  publishViewCard(input: IWorkbenchViewCardInput): TAgentClientEvent
  /**
   * 中止指定会话当前运行的轮次；会话不存在返回 false。
   */
  abort(sessionId: string): boolean
  /** 提交交互回答；未命中等待中的交互返回 false。 */
  answerInteraction(
    sessionId: string,
    interactionId: string,
    answer: TAgentInteractionAnswer,
  ): boolean
  /**
   * 挂起等待一个交互的回答（v14：ask host 的等待落点）。
   *
   * 与 answerInteraction 互补的下行半边：ask host 先经 bus 发布 interaction begin，
   * 再调用本方法等待用户回答；**不设超时**（Q8：禁止超时自动默认——等待只被
   * 回答或取消/中止终结，中止时 Promise 被 reject）。
   *
   * @param sessionId - 会话 ID。
   * @param interactionId - 交互 ID。
   * @returns 用户提交的回答值（单问题 string / 多问题回答表）。
   * @throws 会话中止（abort/releaseSession）时 reject。
   */
  waitForInteractionAnswer(
    sessionId: string,
    interactionId: string,
  ): Promise<TAgentInteractionAnswer>
  /**
   * 中止并释放指定会话的任务（生成任务结束后调用，避免任务泄漏）。
   *
   * @param sessionId - 会话 ID。
   * @returns 释放完成后兑现的 Promise；会话本就存在时重复调用安全。
   */
  releaseSession(sessionId: string): Promise<void>
  /**
   * 会话列表（按最近活跃倒序）。
   *
   * @param options.kind - 只返回指定种类的会话；缺省返回全部。
   */
  listSessions(options?: { kind?: TAgentSessionKind }): IAgentSessionSummary[]
  /** 指定会话的历史工作块（按 seq 升序）。 */
  listBlocks(sessionId: string): IAgentWorkBlock[]
  /**
   * 重命名一个会话（v17 S1）。
   *
   * 只改展示标题——**不动**任何工作块与模型上下文（S4：不改变任何任务状态
   * 与结果呈现）。平台自动生成的标题可被覆盖（S1 明确允许）。
   *
   * @param sessionId - 会话 ID。
   * @param title - 新的会话标题（已 trim；调用方负责长度与字符校验）。
   * @returns 是否找到并更新了会话。
   * @throws 不抛出异常。
   */
  renameSession(sessionId: string, title: string): boolean
  /**
   * 删除一个会话（v17 S2）。
   *
   * **只删对话记录**：不影响用例、产物与报告。调用方须先 `releaseSession`
   * 收尾正在进行的轮次（否则后台任务失去观察者）。
   *
   * 与 `releaseSession` 的分工：那个释放的是**运行中任务**，本方法删除的是
   * **落盘的展示数据**（会话行 + 工作块）。
   *
   * @param sessionId - 会话 ID。
   * @returns 无返回值；会话不存在时静默（幂等）。
   * @throws 不抛出异常。
   */
  removeSession(sessionId: string): void
  /** 释放运行时（AgentService + 工作块存储）。 */
  dispose(): Promise<void>
}

/**
 * 创建工作通道运行时。
 *
 * @param options - 工作区与模型配置。
 * @returns 工作通道运行时实例。
 * @throws {Error} 当工作区为空或工作块数据库无法打开时抛出。
 */
export function createAgentWorkRuntime(
  options: IAgentWorkRuntimeOptions,
): IAgentWorkRuntime {
  const blockStore: IWorkBlockStore = createWorkBlockStore({
    dbPath: join(options.workspace, RUNTIME_DATA_DIR, 'work-blocks.db'),
  })
  const bus = createSessionEventBus({ blockStore })
  // 交互注册表：ask_user 工具 / toolGuard 确认拦截（P1）的挂起等待落点。
  const interactions: IInteractionRegistry = createInteractionRegistry()

  // 常驻 AgentService：SQLite 模型上下文存储，支持进程重启后的断点续跑；
  // 开启思考能力，让客户端能看到 thinking 流。
  const agentService = new AgentService(
    options.workspace,
    {
      name: options.model,
      url: options.apiBaseUrl,
      key: options.apiKey,
      thinkingLevel: 'max',
      supportsThinking: true,
    },
    {
      // bash 路径透传：CLI 启动时探测到的 bash.exe 绝对路径（可选）。
      ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    },
  )

  /** 已挂接事件桥接的会话集合（每会话只挂一次）。 */
  const wiredSessions = new Set<string>()

  /**
   * 工作台会话的能力装配（sessionId → 装配）。
   *
   * 为什么必须记住：装配只在**会话首建**时生效（`getOrCreate` 对已存在会话
   * 提前返回），而会话在生命周期内会被多次 `sendMessage` —— 用户续轮、以及
   * 平台自己注入的完成通知（执行结束后的解读轮次）都走同一条路径。
   * 若不记住，第二次调用就拿不到 `workbench` 字段，运行时会把它当普通 chat
   * 会话处理，而 `AgentTaskRunner.getOrCreate` 会因操作类型不一致直接抛错
   * （会话是 workbench、本次声明 chat）——表现为解读轮次永不发生。
   *
   * 生命周期与本运行时的会话一致：`releaseSession` 释放会话时一并清除，
   * 使同一 ID 重建会话不会继承旧的装配。
   */
  const workbenchAssemblies = new Map<string, IWorkbenchAgentAssembly>()

  /**
   * 本运行时登记过发问宿主的会话集合。
   *
   * 与 wiredSessions 分开维护：宿主登记发生在 agentService.chat **之前**（工具
   * 装配的时序要求），而事件桥接挂接在其**之后**；若 chat 抛错，会话会已登记
   * 宿主却未进入 wiredSessions，用它来清理会漏掉这条注册。
   */
  const askHostSessions = new Set<string>()

  // 运行时自身：ask host 的 resolveRuntime 需要它，故用具名变量而非直接 return。
  // 提问能力对所有跑在本运行时上的会话开放（普通 Chat / SKILL.md 生成 /
  // Playwright 生成），注册点因此放在会话创建处，而不是各条生成路由里。
  const runtime: IAgentWorkRuntime = {
    bus,

    sendMessage(input: IAgentWorkMessageInput): IAgentWorkMessageHandle {
      const sessionId = input.sessionId ?? randomUUID()
      // 会话种类是创建期属性：先落库声明，后续事件只推进 title/status/max_seq。
      blockStore.registerSession(sessionId, input.kind ?? 'chat')
      // 登记发问宿主：必须在 agentService.chat 之前完成——工具列表在会话创建时
      // 装配，Agent 配置工厂据 sessionId 查询注册表决定是否注入 ask_user_question。
      // host 的运行时解析是惰性的（见 createAskUserHost 依赖说明），此处登记不会
      // 为从不发问的会话打开额外资源。
      askUserRegistry.register(
        sessionId,
        createAskUserHost({ resolveRuntime: () => runtime, sessionId }),
      )
      askHostSessions.add(sessionId)

      // v16：工作台会话按 'workbench' 类型创建，能力装配随创建参数直接传入
      // （工具、规则提示词、专用守卫）。装配只在**会话首建**时生效——
      // `getOrCreate` 对已存在会话提前返回；因此这里把装配记在会话上，
      // 后续轮次（用户续轮、平台注入的解读轮次）即便不重复传也能保持一致。
      const assembly = input.workbench ?? workbenchAssemblies.get(sessionId)
      if (input.workbench) {
        workbenchAssemblies.set(sessionId, input.workbench)
      }

      // 注意 operateType 与 kind 是**两个正交的维度**：kind 区分「用户对话 /
      // 平台生成任务」（决定是否进会话列表），operateType 决定「由哪个 Agent 配置
      // 承载」（见 agents/factory.ts）。生成任务是 chat 类型——它服务于单个 Skill。
      const operateType: AgentOperateType = assembly ? 'workbench' : 'chat'

      // 首次创建会话时注入翻译器插件（仅首建生效，复用时被忽略）；
      // chat 门面自动启动首轮，已存在会话则续接新一轮。
      const handle = agentService.chat(input.message, {
        sessionId,
        operateType,
        // 续轮时传回记住的装配：`getOrCreate` 虽会忽略它，但显式传参让
        // 「本会话是工作台会话」在调用点可读，也避免装配在下游被误判为缺失。
        ...(assembly ? { workbench: assembly } : {}),
        plugins: {
          eventAdapter: new ClientEventTranslator({
            sessionId,
            workspace: options.workspace,
            ...(input.title ? { inputPreviewOverride: input.title } : {}),
          }),
          // 守卫优先级：工作台守卫 > 生成任务守卫 > 缺省放行。
          // 两者互斥（工作台会话不是生成任务），合并会让语义含糊。
          ...(assembly
            ? { toolGuard: assembly.toolGuard }
            : input.plugins?.toolGuard
              ? { toolGuard: input.plugins.toolGuard }
              : {}),
        },
      })

      // 事件桥接每会话只挂一次：loop 事件（草稿）→ 总线（分配 seq + 落盘 + 广播）。
      if (!wiredSessions.has(sessionId)) {
        wiredSessions.add(sessionId)
        handle.loop.subscribe((event) => {
          bus.publish(event as unknown as TAgentClientEventDraft)
        })
      }
      return { sessionId, handle }
    },

    abort(sessionId: string): boolean {
      const handle = agentService.getTask(sessionId)
      interactions.abortAll(sessionId)
      if (!handle) return false
      handle.abort()
      return true
    },

    async releaseSession(sessionId: string): Promise<void> {
      // 先清本地簿记，避免释放后以同一 ID 重新建会话时事件桥接被跳过。
      wiredSessions.delete(sessionId)
      interactions.abortAll(sessionId)
      // 注销发问宿主：否则同 ID 会话复活时会拿到已释放的宿主（挂起的提问已随
      // abortAll 以中止语义收尾）。
      askHostSessions.delete(sessionId)
      askUserRegistry.unregister(sessionId)
      // 装配属于会话：会话释放后同 ID 重建不应继承旧装配（否则新会话会被
      // 误判为工作台会话）。
      workbenchAssemblies.delete(sessionId)
      await agentService.removeTask(sessionId)
    },

    publishBlock(
      sessionId: string,
      payload: TAgentClientEventPayload,
    ): TAgentClientEvent {
      // 信封字段在此补齐：调用方只关心业务载荷，序号由总线统一分配。
      return bus.publish({
        ...payload,
        sessionId,
        blockId: nextBlockId(payload),
        timestamp: Date.now(),
      } as TAgentClientEventDraft)
    },

    publishTaskCard(input: IWorkbenchTaskCardInput): TAgentClientEvent {
      return runtime.publishBlock(input.sessionId, {
        type: 'workbench_task',
        phase: 'begin',
        taskId: input.taskId,
        taskKind: input.taskKind,
        skillId: input.skillId,
        skillTitle: input.skillTitle,
        status: input.status,
        startedAt: input.startedAt,
        ...(input.executionId ? { executionId: input.executionId } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
        ...(input.artifacts ? { artifacts: input.artifacts } : {}),
        // v17：连续执行卡的进度与条目（其余 taskKind 传空则不落字段）。
        ...(input.batchStatus ? { batchStatus: input.batchStatus } : {}),
        ...(input.items ? { items: input.items } : {}),
        ...(input.batchLimit !== undefined
          ? { batchLimit: input.batchLimit }
          : {}),
      } as TAgentClientEventPayload)
    },

    publishReportCard(input: IWorkbenchReportCardInput): TAgentClientEvent {
      return runtime.publishBlock(input.sessionId, {
        type: 'workbench_report',
        phase: 'begin',
        executionId: input.executionId,
        skillId: input.skillId,
        skillTitle: input.skillTitle,
        taskStatus: input.taskStatus,
        summary: input.summary,
      })
    },

    publishProposalCard(input: IWorkbenchProposalCardInput): TAgentClientEvent {
      return runtime.publishBlock(input.sessionId, {
        type: 'workbench_proposal',
        phase: 'begin',
        proposalId: input.proposalId,
        proposalKind: input.proposalKind,
        skillId: input.skillId,
        skillTitle: input.skillTitle,
        label: input.label,
        ...(input.description ? { description: input.description } : {}),
        state: input.state,
        ...(input.changes ? { changes: input.changes } : {}),
        ...(input.envKeys ? { envKeys: input.envKeys } : {}),
        ...(input.envKeyOps ? { envKeyOps: input.envKeyOps } : {}),
        requiresModalConfirm: input.requiresModalConfirm,
        ...(input.reportCount !== undefined
          ? { reportCount: input.reportCount }
          : {}),
        ...(input.releaseBytes !== undefined
          ? { releaseBytes: input.releaseBytes }
          : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.resultMessage ? { resultMessage: input.resultMessage } : {}),
      } as TAgentClientEventPayload)
    },

    publishViewCard(input: IWorkbenchViewCardInput): TAgentClientEvent {
      return runtime.publishBlock(input.sessionId, {
        type: 'workbench_view',
        phase: 'begin',
        viewId: input.viewId,
        viewKind: input.viewKind,
        skillId: input.skillId,
        payload: input.payload,
      } as TAgentClientEventPayload)
    },

    answerInteraction(
      sessionId: string,
      interactionId: string,
      answer: TAgentInteractionAnswer,
    ): boolean {
      return interactions.answer(sessionId, interactionId, answer)
    },

    waitForInteractionAnswer(
      sessionId: string,
      interactionId: string,
    ): Promise<TAgentInteractionAnswer> {
      return interactions.waitForAnswer(sessionId, interactionId)
    },

    listSessions(
      options: { kind?: TAgentSessionKind } = {},
    ): IAgentSessionSummary[] {
      return blockStore.listSessions(options)
    },

    listBlocks(sessionId: string): IAgentWorkBlock[] {
      return blockStore.listBlocks(sessionId)
    },

    renameSession(sessionId: string, title: string): boolean {
      return blockStore.renameSession(sessionId, title)
    },

    removeSession(sessionId: string): void {
      // 先清内存簿记（与 releaseSession 同一理由：避免同 ID 重建时
      // 事件桥接被跳过、装配被继承）。
      wiredSessions.delete(sessionId)
      interactions.abortAll(sessionId)
      askHostSessions.delete(sessionId)
      askUserRegistry.unregister(sessionId)
      workbenchAssemblies.delete(sessionId)
      blockStore.removeSession(sessionId)
    },

    async dispose(): Promise<void> {
      // 释放整个运行时：先注销本运行时登记过的全部发问宿主，避免注册表残留
      // 指向已释放实例（未走完 releaseSession 的会话也能被清理干净）。
      for (const sessionId of askHostSessions) {
        askUserRegistry.unregister(sessionId)
      }
      askHostSessions.clear()
      wiredSessions.clear()
      await agentService.dispose()
      blockStore.close()
    },
  }

  return runtime
}

/**
 * 为直接发布的工作台块分配 blockId（v16）。
 *
 * 动作卡片与任务卡片的 blockId 必须**稳定可复现**——终态镜像会用同一 blockId
 * 重发事件来更新已有卡片（客户端与物化存储都按 blockId 定位）。因此这里按
 * 业务 ID 派生而不是每次生成新 ID：动作卡片用 actionId、任务卡片用 taskId。
 *
 * 前缀沿用 agent 包的 `blk_` 约定，保持与模型事件流块的同构外观（便于排查时区分来源）。
 *
 * @param payload - 块事件载荷。
 * @returns 稳定的块 ID；非工作台块回退为一次性随机 ID。
 * @throws 不抛出异常。
 */
function nextBlockId(payload: TAgentClientEventPayload): string {
  if (payload.type === 'workbench_action') {
    return `blk_action_${payload.actionId}`
  }
  if (payload.type === 'workbench_task') {
    return `blk_task_${payload.taskId}`
  }
  if (payload.type === 'workbench_report') {
    // 一次执行只发一张报告卡片，用执行 ID 派生即可保持稳定可复现。
    return `blk_report_${payload.executionId}`
  }
  if (payload.type === 'workbench_view') {
    // 视图卡：同一 viewId 重发即为原位更新（清单卡筛选后走这条路）。
    return `blk_view_${payload.viewId}`
  }
  if (payload.type === 'workbench_proposal') {
    // 提案卡：创建与终态必须落同一个块，否则历史回看会看到两张半截卡片。
    return `blk_proposal_${payload.proposalId}`
  }
  // 其余块类型（当前没有调用方）按 agent 包的规则生成。
  return newBlockId()
}

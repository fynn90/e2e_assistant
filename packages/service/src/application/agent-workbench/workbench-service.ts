/**
 * Agent 工作台能力服务（v16 §6.1）：承载 `/agent` 会话的执行、生成与动作编排。
 *
 * 为什么独立成服务而不是塞进 agent 运行时（PRD §9.6 决策 D1）：
 *   - agent 运行时的职责是「会话与事件通道」，执行/生成是**业务编排**；
 *   - 两者的生命周期不同——运行时按工作区常驻，本服务持有任务编排状态；
 *   - 守卫与工具注入是**策略**，应由应用层决定（依赖倒转原则）。
 *
 * 分工：本服务只做「能不能做」的判定与编排，不替 Agent 做意图识别——
 * 意图识别（三态匹配、缺口判断）由 Agent 依据系统提示词完成，本服务负责
 * 把 Agent 的决定落实为执行、生成或动作卡片，并在执行结束后注入解读轮次。
 *
 * 拆分为四块（单一职责）：
 *   - 检索：`skill-catalog.ts`（只读查询，与编排无共享状态）；
 *   - 守卫：`workbench-tool-guard.ts`（PRD SEC-1 权限矩阵）；
 *   - 生成编排：`generation-orchestrator.ts`（生成 + 服务端落盘）；
 *   - 本模块：执行宿主、动作卡片、覆盖确认、终态镜像与解读轮次。
 */

import { randomUUID } from 'node:crypto'
import {
  FileE2ETestCaseRepository,
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  SKILL_ENV_FILE_NAME,
  listTestReportRuns,
  readFixedUtf8File,
  readTestReportSummary,
  resolveSkill,
} from '@fynn90-e2e_assistant/skill-manager'
import type { ISkillStorageOptions } from '@fynn90-e2e_assistant/skill-manager'
import { DefaultSensitiveDataRedactor } from '@fynn90-e2e_assistant/playwright-engine'
import { parseEnvFileContent } from '@fynn90-e2e_assistant/types'
import type { IRepairContext } from '../e2e-test-case/playwright-script-generator'
import type {
  IAgentSkillCandidate,
  IAgentWorkbenchTaskSummary,
  TAgentWorkbenchAction,
} from '@fynn90-e2e_assistant/types'
import type {
  IBatchRunnerHost,
  IExecuteTestIssue,
  IProposalHost,
  IReadinessHost,
  ISkillCatalogHost,
  ITestRunnerHost,
  IViewHost,
  IWorkbenchActionHost,
  TExecuteTestHostResult,
  TReadSkillDocumentHostResult,
} from '@fynn90-e2e_assistant/agent'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import type { ITestExecutionService } from '../test-execution/execution-service'
import type { IExecutionEventBus } from '../test-execution/execution-event-bus'
import type { IAgentWorkRuntime } from '../../agent-runtime/agent-work-runtime'
import { ApiError } from '../../shared/errors/api-error'
import { createSkillCatalog, type ISkillCatalog } from './skill-catalog'
import {
  createReadinessService,
  type IReadinessService,
} from './execution-readiness'
import { createViewHost } from './view-host'
import type { IProposalService } from './proposal-service'
import type { IBatchExecutionService } from './batch-execution-service'
import {
  createGenerationOrchestrator,
  type IGenerationOrchestrator,
  type TGenerationAction,
  type TGenerationOutcome,
} from './generation-orchestrator'

/**
 * 执行卡片发布门的兜底等待上限（毫秒）。
 *
 * 正常路径下 `turn end` 在本轮文本写完后立刻到达（秒级），本上限不会触发；
 * 它只兜住「等不到 turn end」的异常情形（服务重启后会话状态残留为 running，
 * PRD LOG-4 的已知边界）。取值远大于正常轮次时长，避免误伤正常的延后发布。
 */
const PUBLISH_GUARD_MS = 120_000

/** 动作卡片在内存中的登记（供点击时校验并定位目标）。 */
interface IActionRecord {
  actionId: string
  action: TAgentWorkbenchAction
  skillId: string | null
  skillTitle?: string
  label: string
  description?: string
  /** 点击前需用户确认（GEN-10 覆盖确认）。 */
  requiresConfirm?: boolean
  /** 目标会话（卡片挂载处；点击校验归属用）。 */
  sessionId: string
  /** 卡片当前状态：consumed / expired 后不再受理点击。 */
  state?: 'pending' | 'consumed' | 'expired'
  /** 修复动作（v17 G2）的失败来源：失败所在运行的编号。 */
  reportRunId?: string
}

/**
 * 同一 `(skillId, reportRunId)` 上由 Agent 主动提议修复的次数上限（v17 G4）。
 *
 * 达上限后**不再自动给出修复动作卡片**（改由用户明确要求才发起）——
 * 「不得陷入无效循环」的落点。计数存在会话内存即可（不需要跨会话持久化：
 * 换会话重来一次是合理的）。
 */
const REPAIR_SUGGESTION_LIMIT = 2

/** 会话内运行中的执行任务（PRD RUN-4：同一会话同时只允许一个）。 */
interface IRunningExecution {
  executionId: string
  skillId: string
  skillTitle: string
  startedAt: number
}

/** 一次执行的终态（卡片镜像与解读轮次共用）。 */
interface IExecutionOutcome {
  status: 'completed' | 'failed' | 'interrupted'
  summary?: IAgentWorkbenchTaskSummary
  /** 给模型看的一句话结论（只含统计与 key 名，无 env 值）。 */
  summaryLine: string
}

/** 一次执行在对话流中的卡片状态。 */
interface IExecutionCardState {
  /** 卡片是否已发布到对话流（发布门：本轮 turn end 之后才为 true）。 */
  published: boolean
  /** 终态是否已写进卡片（避免发布与镜像两条路径重复写同一终态）。 */
  mirrored?: boolean
  /** 执行终态；若在卡片发布前就结束，会带上它让卡片一次到位。 */
  outcome?: IExecutionOutcome
  /** 执行总线的订阅取消函数。 */
  unsubscribe: () => void
}

/**
 * 工作台服务的可替换依赖（组合根注入）。
 *
 * 不持有「按工作区解析运行时」的能力：需要发卡片时统一由调用方把运行时传进来
 * ——运行时的解析依赖平台配置（异步），而路由层已经拿到它；让服务自己去解析
 * 会引入第二条解析路径与额外的时序耦合。
 */
export interface IAgentWorkbenchDependencies {
  /** 生成/执行任务注册表（与 Skill 开发页共用，跨入口互斥，PRD RUN-3）。 */
  taskRegistry: IGenerationTaskRegistry
  /** 执行编排服务（v11 链路，J1–J8 与报告全复用）。 */
  testExecutionService: ITestExecutionService
  /** 执行事件总线（终态镜像与摘要来源）。 */
  executionEventBus: IExecutionEventBus
  /** 生成编排（生成 + 服务端落盘）；缺省内部创建（测试可注入替身）。 */
  generationOrchestrator?: IGenerationOrchestrator
  /** 检索服务；缺省内部创建（测试可注入替身）。 */
  skillCatalog?: ISkillCatalog
  /**
   * 提案服务（v17）：四类提案的唯一状态机。
   *
   * 缺省时提案工具不可用——与 `testExecutionService` 等必需依赖不同，
   * 本项**允许缺省**（测试场景只需验证检索/执行时不建提案服务）。
   */
  proposalService?: IProposalService
  /** 批次服务（v17）：连续执行编排；缺省时 execute_batch 不可用。 */
  batchService?: IBatchExecutionService
  /** 体检服务（v17）；缺省内部创建（与执行链路共用同一任务注册表）。 */
  readinessService?: IReadinessService
}

/** 工作台服务接口。 */
export interface IAgentWorkbenchService {
  /** 检索宿主（注入给 list_skills / read_skill_document / read_test_case / read_run_history）。 */
  createCatalogHost (rootDir: string): ISkillCatalogHost
  /**
   * 体检宿主（注入给 check_readiness，v17 R3）。
   *
   * @param rootDir - 工作区根目录。
   * @returns 体检宿主（不启动运行、不占用执行通道）。
   */
  createReadinessHost (rootDir: string): IReadinessHost
  /**
   * 视图宿主（注入给 render_view，v17 §6.2）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起会话（卡片发布落点）。
   * @param runtime - 承载该会话的常驻运行时。
   * @returns 视图宿主（按 params 自取数据后发布只读卡片）。
   */
  createViewHost (
    rootDir: string,
    sessionId: string,
    runtime: IAgentWorkRuntime,
  ): IViewHost
  /**
   * 提案宿主（注入给四个 propose_* 工具，v17 §6.3）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起会话。
   * @param runtime - 承载该会话的常驻运行时。
   * @returns 提案宿主（建提案，不执行写操作）。
   */
  createProposalHost (
    rootDir: string,
    sessionId: string,
    runtime: IAgentWorkRuntime,
  ): IProposalHost
  /**
   * 批次宿主（注入给 execute_batch，v17 §6.4）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起会话。
   * @param runtime - 承载该会话的常驻运行时。
   * @returns 批次宿主（建批次，不启动执行）。
   */
  createBatchHost (
    rootDir: string,
    sessionId: string,
    runtime: IAgentWorkRuntime,
  ): IBatchRunnerHost
  /**
   * 执行宿主（注入给 execute_test）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起执行的会话。
   * @param runtime - 承载该会话的常驻运行时（执行卡片的发布落点）。
   */
  createTestRunnerHost (
    rootDir: string,
    sessionId: string,
    runtime: IAgentWorkRuntime,
  ): ITestRunnerHost
  /**
   * 动作宿主（注入给 propose_action）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起会话。
   * @param runtime - 承载该会话的常驻运行时（动作卡片的发布落点）。
   */
  createActionHost (
    rootDir: string,
    sessionId: string,
    runtime: IAgentWorkRuntime,
  ): IWorkbenchActionHost
  /**
   * 处理动作卡片点击（PRD §6.4 的动作端点落点）。
   *
   * @param input - 目标会话、运行时、动作 ID 与可选覆盖确认。
   * @returns 处理结果；被拒绝时 message 说明原因（互斥、就绪不足、需确认等）。
   * @throws ApiError 目标会话/动作不存在时抛出。
   */
  runAction (input: {
    rootDir: string
    sessionId: string
    runtime: IAgentWorkRuntime
    actionId: string
    confirmOverwrite?: boolean
  }): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}

/**
 * 创建工作台能力服务。
 *
 * @param dependencies - 组合根单例依赖。
 * @returns 工作台服务实例。
 * @throws 不抛出异常。
 */
export function createAgentWorkbenchService (
  dependencies: IAgentWorkbenchDependencies,
): IAgentWorkbenchService {
  const catalog = dependencies.skillCatalog ?? createSkillCatalog()
  const generation =
    dependencies.generationOrchestrator ??
    createGenerationOrchestrator({ taskRegistry: dependencies.taskRegistry })
  // v17：体检服务复用同一任务注册表——J6 互斥的判定必须与执行链路同源，
  // 各持一份会让「体检说能跑、执行说在忙」这类不一致成为可能。
  const readiness =
    dependencies.readinessService ??
    createReadinessService({ taskRegistry: dependencies.taskRegistry })

  /** 动作卡片登记表（actionId → 记录）。 */
  const actions = new Map<string, IActionRecord>()
  /**
   * Agent 主动提议修复的次数（v17 G4）：`skillId:reportRunId` → 次数。
   *
   * 只记「Agent 主动提议」这一条路径（`requestAction`），用户点击已有卡片
   * 不计入——G4 约束的是「不得陷入无效循环」，即不要让 Agent 一次次地
   * 建议修复，而不是限制用户主动发起。
   */
  const repairSuggestions = new Map<string, number>()
  /** 会话 → 运行中的执行任务（PRD RUN-4）。 */
  const runningBySession = new Map<string, IRunningExecution>()

  /**
   * 发布一张动作卡片并把登记写入内存。
   *
   * @param input - 会话、动作、目标与文案。
   * @returns 登记后的动作记录。
   * @throws 不抛出异常。
   */
  function publishAction (input: {
    runtime: IAgentWorkRuntime
    sessionId: string
    action: TAgentWorkbenchAction
    skillId: string | null
    skillTitle?: string
    label: string
    description?: string
    /** 点击前需用户确认（GEN-10 覆盖确认）。 */
    requiresConfirm?: boolean
    /** 修复动作（v17）的失败来源：失败所在运行的编号。 */
    reportRunId?: string
    /**
     * 只登记、不发布卡片块（v17 Q6 的清单卡行内按钮）。
     *
     * 为什么需要这个开关：清单卡一屏 20 行，若每行都发一张动作卡片块，
     * 清单卡旁边会多出 20 张卡片，滚动与筛选都要跨块协调。行内按钮只需
     * 「登记让按钮可点」，呈现由清单卡自己负责（登记与呈现解耦）。
     */
    registerOnly?: boolean
  }): IActionRecord {
    const actionId = randomUUID()
    const record: IActionRecord = {
      actionId,
      action: input.action,
      skillId: input.skillId,
      ...(input.skillTitle ? { skillTitle: input.skillTitle } : {}),
      label: input.label,
      ...(input.description ? { description: input.description } : {}),
      ...(input.requiresConfirm ? { requiresConfirm: true } : {}),
      ...(input.reportRunId ? { reportRunId: input.reportRunId } : {}),
      sessionId: input.sessionId,
    }
    actions.set(actionId, record)

    if (input.registerOnly) {
      return record
    }

    input.runtime.publishBlock(input.sessionId, {
      type: 'workbench_action',
      phase: 'begin',
      actionId,
      action: input.action,
      skillId: input.skillId,
      ...(input.skillTitle ? { skillTitle: input.skillTitle } : {}),
      label: input.label,
      ...(input.description ? { description: input.description } : {}),
      ...(input.requiresConfirm ? { requiresConfirm: true } : {}),
      state: 'pending',
    })

    return record
  }

  /**
   * 把动作卡片定格为已消费（同 blockId 重发，客户端原位更新）。
   *
   * @param runtime - 承载该会话的运行时（重发落点）。
   * @param record - 动作记录。
   * @param state - 目标状态。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function settleAction (
    runtime: IAgentWorkRuntime,
    record: IActionRecord,
    state: 'consumed' | 'expired',
  ): void {
    record.state = state
    runtime.publishBlock(record.sessionId, {
      type: 'workbench_action',
      phase: 'begin',
      actionId: record.actionId,
      action: record.action,
      skillId: record.skillId,
      ...(record.skillTitle ? { skillTitle: record.skillTitle } : {}),
      label: record.label,
      ...(record.description ? { description: record.description } : {}),
      ...(record.requiresConfirm ? { requiresConfirm: true } : {}),
      state,
    })
  }

  /**
   * 校验目标用例存在并返回标题（所有动作的公共前置，PRD SEC-2）。
   *
   * @param rootDir - 工作区根目录。
   * @param skillId - 用例唯一 ID。
   * @returns 用例标题。
   * @throws ApiError 目标不存在或 ID 非法时抛出（INVALID_SKILL_ID / SKILL_NOT_FOUND）。
   */
  async function requireSkill (
    rootDir: string,
    skillId: string,
  ): Promise<{ title: string }> {
    const storage: ISkillStorageOptions = { rootDir }
    try {
      const resolved = await resolveSkill(storage, skillId)
      return { title: resolved.detail.title }
    } catch (error) {
      throw new ApiError({
        code: 'SKILL_NOT_FOUND',
        status: 404,
        message:
          error instanceof Error
            ? `目标用例不可执行：${error.message}`
            : '目标用例不存在。',
        cause: error,
      })
    }
  }

  /**
   * 发起一次执行并把执行卡片挂到会话上（RUN-1/RUN-2/RUN-4）。
   *
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起执行的会话。
   * @param skillId - 目标用例。
   * @returns 与 `ITestRunnerHost` 同构的结果。
   * @throws 不抛出异常——互斥与就绪失败都归一为 `{ ok: false, issues }`。
   */
  async function startExecution (
    runtime: IAgentWorkRuntime,
    rootDir: string,
    sessionId: string,
    skillId: string,
  ): Promise<TExecuteTestHostResult> {
    // RUN-4：同一会话同一时刻只允许一个执行任务。
    const running = runningBySession.get(sessionId)
    if (running) {
      return {
        ok: false,
        issues: [
          {
            code: 'EXECUTION_SESSION_BUSY',
            message: `当前会话已有执行任务在运行（${running.skillTitle}）。请等待其结束，或在执行卡片上点击「停止执行」后再发起。`,
          },
        ],
      }
    }

    const { title } = await requireSkill(rootDir, skillId)

    // 执行链路（v11）：就绪校验 J1–J8、互斥、env 注入、报告全部复用。
    const result = await dependencies.testExecutionService.start({
      rootDir,
      skillId,
    })

    if (!result.ok) {
      return { ok: false, issues: toExecutionIssues(result.issues) }
    }

    const executionId = result.executionId
    const startedAt = Date.now()

    runningBySession.set(sessionId, {
      executionId,
      skillId,
      skillTitle: title,
      startedAt,
    })

    // 执行卡片（RUN-6）：先武装、**等本轮对话结束再发布**。
    //
    // 为什么不在这里直接发布：卡片若是此刻上屏，就会排在本轮 Agent 的说明文本
    // **之前**（文本要等模型把这一轮流式写完）——用户看到的是「先跳出执行结果、
    // 后读到『已为你发起执行』」，叙述顺序与事实相反。改为等 turn end 发布后，
    // 对话流顺序变成：Agent 说明 → 执行卡片（含过程与结果）→ Agent 总结。
    watchExecutionTerminal(runtime, {
      executionId,
      sessionId,
      skillId,
      skillTitle: title,
      startedAt,
    })

    return {
      ok: true,
      executionId,
      message: `已发起用例「${title}」的执行，进度见对话流中的执行卡片。请把这句话转述给用户后结束本轮，不要等待执行结束、也不要轮询进度。`,
    }
  }

  /**
   * 跟踪一次执行：等本轮对话结束再发布卡片，等执行终态再镜像摘要与注入解读轮次。
   *
   * 两个等待相互独立，因此各有一个「是否已兑现」的标记：
   *   - **发布门**（turn end）：执行可能在轮次结束前就已完成（小用例几秒即结束），
   *     此时把终态一起带上，卡片一次到位、不出现「先 running 再 completed」的抖动；
   *   - **终态门**（执行总线）：订阅一旦解除就不再改动卡片。
   *
   * @param runtime - 承载该会话的运行时（卡片镜像与解读轮次的落点）。
   * @param context - 本次执行的标识与展示信息。
   * @returns 无返回值（订阅在两扇门都兑现后自行解除）。
   * @throws 不抛出异常。
   */
  function watchExecutionTerminal (
    runtime: IAgentWorkRuntime,
    context: {
      executionId: string
      sessionId: string
      skillId: string
      skillTitle: string
      startedAt: number
    },
  ): void {
    const { executionId } = context
    /** 终态 status 已到达、但 summary 可能紧随其后的等待句柄。 */
    let pendingFallback: ReturnType<typeof setTimeout> | undefined

    const state: IExecutionCardState = {
      published: false,
      unsubscribe: () => undefined,
    }

    // —— 发布门：等本轮对话结束（turn end）再上屏 ——
    //
    // 两种发起来源必须区别对待：
    //   ① 用户在对话里说「跑一下」→ `execute_test` 在**本轮之内**被调用，
    //      本轮结束后才有 Agent 的说明文本，故须等 turn end 再发布；
    //   ② 用户**点击动作卡片**发起 → 这是独立的 HTTP 请求，**没有任何进行中的
    //      轮次**，若也等 turn end 就永远不会发布（卡片凭空消失）。
    // 以会话状态区分：进行中的轮次会把会话标为 running（见 work-block-store
    // 的 turn begin 分支），此时才需要等。
    let unsubscribeTurn: (() => void) | undefined
    let publishGuard: ReturnType<typeof setTimeout> | undefined

    const publish = (): void => {
      if (state.published) return
      state.published = true
      if (publishGuard) clearTimeout(publishGuard)
      unsubscribeTurn?.()
      publishExecutionCard(runtime, context, state)
    }

    if (!hasOpenTurn(runtime, context.sessionId)) {
      publish()
    } else {
      // afterSeq 取当前最大序号：只接**之后**的事件。若传 undefined，总线会把
      // 缓冲里的历史事件整体补发，上一条 `turn end` 会立刻把卡片放出去——
      // 发布门就形同虚设。
      unsubscribeTurn = runtime.bus.subscribe(
        context.sessionId,
        runtime.bus.currentSeq(context.sessionId),
        (event) => {
          if (event.type !== 'turn' || event.phase !== 'end') return
          publish()
        },
      )

      // 兜底：turn end 理应在本轮文本写完后立刻到达，但会话状态可能因服务重启
      // 残留为 running（PRD LOG-4 的已知边界），此时等不到任何 turn end——
      // 卡片会永远不出现。这里的等待上限远大于正常轮次时长，正常路径不会触发；
      // 一旦触发，宁可卡片早于文本出现，也不能让用户发起执行后什么都看不到。
      publishGuard = setTimeout(publish, PUBLISH_GUARD_MS)
      publishGuard.unref?.()
    }

    const unsubscribe = dependencies.executionEventBus.subscribe(
      executionId,
      undefined,
      (event) => {
        if (state.outcome) return

        // 有 summary 一律以它为准：这是唯一能给出统计与失败定位的终态来源。
        if (event.type === 'summary') {
          if (pendingFallback) clearTimeout(pendingFallback)
          unsubscribe()
          state.unsubscribe = () => undefined
          state.outcome = {
            status:
              event.summary.status === 'interrupted'
                ? 'interrupted'
                : 'completed',
            summary: {
              total: event.summary.total,
              passed: event.summary.passed,
              failed: event.summary.failed,
              interrupted: event.summary.interrupted,
              skipped: event.summary.skipped,
              durationMs: event.summary.durationMs,
              runId: event.summary.runId,
              // RPT-2 要求摘要含「运行时间」与「目标 URL」。
              startedAt: event.summary.startedAt,
              ...(event.summary.baseUrl
                ? { baseUrl: event.summary.baseUrl }
                : {}),
            },
            summaryLine: describeSummary(event.summary),
          }
          settleExecution(runtime, context, state)
          return
        }

        if (
          event.type !== 'status' ||
          !isTerminalExecutionStatus(event.status)
        ) {
          return
        }

        // 终态 status 先于 summary 到达（执行服务在 finalize 中「先发状态、再发
        // 摘要」，两者在同一同步块内完成）。因此这里**延后一拍**再定稿：
        // 若摘要在同一批事件里到达，上面的分支会先命中并以摘要为准；
        // 只有确实没有摘要的失败（浏览器/环境未能启动）才会落到兜底。
        const status = event.status
        if (pendingFallback) clearTimeout(pendingFallback)
        pendingFallback = setTimeout(() => {
          if (state.outcome) return
          unsubscribe()
          state.unsubscribe = () => undefined
          state.outcome = {
            status,
            summaryLine:
              status === 'interrupted'
                ? '执行已中断，本次没有生成报告。'
                : '执行未能正常完成（可能是浏览器或运行环境未能启动），本次没有生成报告。',
          }
          settleExecution(runtime, context, state)
        }, 0)
      },
    )
    state.unsubscribe = unsubscribe
  }

  /**
   * 发布执行卡片（RUN-6）：把「发布门」已开启的执行块写到父会话总线。
   *
   * 若执行在轮次结束前已拿到终态，直接以终态发布——避免卡片先以 running 上屏、
   * 紧接着又被改写成 completed（用户会看到一次无意义的状态跳变）。
   *
   * @param runtime - 承载该会话的运行时。
   * @param context - 本次执行的标识与展示信息。
   * @param state - 本次执行的卡片状态（读取 outcome）。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function publishExecutionCard (
    runtime: IAgentWorkRuntime,
    context: {
      executionId: string
      sessionId: string
      skillId: string
      skillTitle: string
      startedAt: number
    },
    state: IExecutionCardState,
  ): void {
    const outcome = state.outcome

    runtime.publishTaskCard({
      sessionId: context.sessionId,
      taskId: context.executionId,
      taskKind: 'execution',
      skillId: context.skillId,
      skillTitle: context.skillTitle,
      status: outcome ? outcome.status : 'running',
      startedAt: context.startedAt,
      executionId: context.executionId,
      ...(outcome?.summary ? { summary: outcome.summary } : {}),
      ...(outcome && outcome.status === 'failed'
        ? { errorMessage: outcome.summaryLine }
        : {}),
    })

    // 已定的终态不必再等 `settleExecution` 的第二条路径。
    if (outcome) state.mirrored = true
  }

  /**
   * 执行终态：镜像摘要、释放会话占用、注入解读轮次（RUN-10 / LOG-2 / §6.7）。
   *
   * 卡片尚未发布时（执行在本轮文本输出完毕前就结束）不在这里发——发布门一开，
   * `publishExecutionCard` 会直接以终态发布，避免多一次状态跳变。
   *
   * @param runtime - 承载该会话的运行时。
   * @param context - 本次执行的标识。
   * @param state - 本次执行的卡片状态。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function settleExecution (
    runtime: IAgentWorkRuntime,
    context: {
      executionId: string
      sessionId: string
      skillId: string
      skillTitle: string
      startedAt: number
    },
    state: IExecutionCardState,
  ): void {
    if (state.published && !state.mirrored) {
      // 卡片已在屏上（running）：同 blockId 重发终态 → 物化落盘（LOG-2）。
      runtime.publishTaskCard({
        sessionId: context.sessionId,
        taskId: context.executionId,
        taskKind: 'execution',
        skillId: context.skillId,
        skillTitle: context.skillTitle,
        status: state.outcome!.status,
        startedAt: context.startedAt,
        executionId: context.executionId,
        ...(state.outcome!.summary ? { summary: state.outcome!.summary } : {}),
        ...(state.outcome!.status === 'failed'
          ? { errorMessage: state.outcome!.summaryLine }
          : {}),
      })
      state.mirrored = true
    }

    // 报告卡片（RPT-2/RPT-3）：与执行卡片**平级**的独立一张，紧跟其后发布
    //（seq 保证顺序）。只有拿到统计摘要时才发——「未启动运行」的失败没有报告，
    // 此时卡片上会出现一个点开必然 missing 的入口，不如不给。
    if (state.outcome?.summary) {
      runtime.publishReportCard({
        sessionId: context.sessionId,
        executionId: context.executionId,
        skillId: context.skillId,
        skillTitle: context.skillTitle,
        taskStatus: state.outcome.status,
        summary: state.outcome.summary,
      })
    }

    runningBySession.delete(context.sessionId)

    // RUN-10 / §6.7：非阻塞发起与「读报告给结论」有冲突，用一条服务注入的
    // 完成消息化解——发起轮次秒回，解读轮次自动发生。消息只含统计与 key 名，
    // 不含任何 env 值（SEC-4）。
    //
    // 整段包在 try 里：本函数由执行总线的订阅回调同步调用（执行服务的
    // `finalize` 内 publish → 监听器），若在此抛错会冒泡回执行服务——
    // 那里会把一个**已经成功**的执行误判为 failed 并改写状态。
    // 解读轮次只是锦上添花，绝不能污染执行结果。
    try {
      runtime.sendMessage({
        sessionId: context.sessionId,
        message: [
          `【平台通知】用例「${context.skillTitle}」的本次执行已结束。`,
          state.outcome!.summaryLine,
          // 统计、运行编号、报告入口已由对话流中的报告卡片承载，此处只要求
          // Agent 给出**卡片给不了的东西**：失败原因解读与下一步建议。
          // 明确禁止复述统计表——否则对话流里会出现两张内容相同的表
          //（一张卡片、一段 Markdown），既冗余又容易与卡片数据不一致。
          '报告卡片已在对话流中给出统计与报告入口，**不要再用表格复述统计数字**。',
          '请只给出：一句话解读（结果是否正常）；有失败时说明失败发生在哪一步、可能原因与修复方向。',
          state.outcome!.status === 'completed' &&
            (state.outcome!.summary?.failed ?? 0) > 0
            ? '存在失败：然后用 propose_action 给出 update-playwright-script 入口，不要自行修改脚本。'
            : '',
          '不要编造结果之外的过程细节。',
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      })
    } catch (error) {
      // 解读轮次失败不影响卡片终态：卡片已物化，用户仍能看到结果与报告。
      // 不重试、不上抛——执行已经结束，任何后续失败都不该改变那个事实。
      void error
    }
  }

  /**
   * 从已物化的工作块里恢复一张动作卡片的登记（服务重启后的历史卡片）。
   *
   * @param runtime - 承载该会话的运行时。
   * @param sessionId - 会话 ID。
   * @param actionId - 动作 ID（即该块的 blockId 后缀，见运行时的 blockId 规则）。
   * @returns 恢复出的登记；找不到时返回 undefined。
   * @throws 不抛出异常（块不存在或 payload 不完整时返回 undefined）。
   */
  function recoverAction (
    runtime: IAgentWorkRuntime,
    sessionId: string,
    actionId: string,
  ): IActionRecord | undefined {
    try {
      const block = runtime
        .listBlocks(sessionId)
        .find(
          (item) =>
            item.kind === 'workbench_action' &&
            (item.payload as { actionId?: unknown }).actionId === actionId,
        )
      if (!block) return undefined

      const payload = block.payload as {
        action?: TAgentWorkbenchAction
        skillId?: string | null
        skillTitle?: string
        label?: string
        description?: string
        requiresConfirm?: boolean
        state?: 'pending' | 'consumed' | 'expired'
      }
      if (!payload.action || typeof payload.label !== 'string') return undefined

      const recovered: IActionRecord = {
        actionId,
        action: payload.action,
        skillId: payload.skillId ?? null,
        ...(payload.skillTitle ? { skillTitle: payload.skillTitle } : {}),
        label: payload.label,
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.requiresConfirm ? { requiresConfirm: true } : {}),
        sessionId,
        ...(payload.state ? { state: payload.state } : {}),
      }
      actions.set(actionId, recovered)
      return recovered
    } catch {
      return undefined
    }
  }

  return {
    createCatalogHost (rootDir: string): ISkillCatalogHost {
      return {
        listSkills: (): Promise<IAgentSkillCandidate[]> =>
          catalog.listCandidates(rootDir),
        listFiltered: (filter) => catalog.listFiltered(rootDir, filter),
        readSkillDocument: (
          skillId: string,
        ): Promise<TReadSkillDocumentHostResult> =>
          catalog.readSkillDocument(rootDir, skillId),
        readTestCase: (skillId) => catalog.readTestCase(rootDir, skillId),
        readRunHistory: (skillId, limit) =>
          catalog.readRunHistory(rootDir, skillId, limit),
      }
    },

    createTestRunnerHost (
      rootDir: string,
      sessionId: string,
      runtime: IAgentWorkRuntime,
    ): ITestRunnerHost {
      return {
        startExecution: (options) =>
          startExecution(runtime, rootDir, sessionId, options.skillId),
      }
    },

    createReadinessHost (rootDir: string): IReadinessHost {
      return {
        checkReadiness: async (skillId) => {
          const result = await readiness.check(rootDir, skillId)
          return result.ok
            ? { ok: true, readiness: result.readiness }
            : { ok: false, message: result.message }
        },
      }
    },

    createViewHost (
      rootDir: string,
      sessionId: string,
      runtime: IAgentWorkRuntime,
    ): IViewHost {
      return createViewHost({
        sessionId,
        runtime,
        rootDir,
        catalog,
        readiness,
        // 行内动作登记：复用动作卡片的登记机制，但**不发布卡片块**（Q6）。
        registerInline: (input) =>
          registerInlineAction(runtime, sessionId, input).actionId,
      })
    },

    createProposalHost (
      rootDir: string,
      sessionId: string,
      runtime: IAgentWorkRuntime,
    ): IProposalHost {
      return {
        createProposal: async (input) => {
          if (!dependencies.proposalService) {
            return {
              ok: false,
              message: '平台未启用提案通道，请如实告知用户当前无法发起变更。',
            }
          }
          const result = await dependencies.proposalService.create({
            rootDir,
            sessionId,
            runtime,
            kind: input.kind,
            skillId: input.skillId,
            ...(input.origin ? { origin: input.origin } : {}),
            ...(input.caseChange ? { caseChange: input.caseChange } : {}),
            ...(input.envKeys ? { envKeys: input.envKeys } : {}),
            ...(input.envKeyOps ? { envKeyOps: input.envKeyOps } : {}),
            ...(input.runIds ? { runIds: input.runIds } : {}),
          })
          return result
        },
      }
    },

    createBatchHost (
      rootDir: string,
      sessionId: string,
      runtime: IAgentWorkRuntime,
    ): IBatchRunnerHost {
      return {
        startBatch: async (options) => {
          if (!dependencies.batchService) {
            return {
              ok: false,
              message: '平台未启用连续执行，请如实告知用户当前只能逐个执行。',
            }
          }
          const result = await dependencies.batchService.create({
            rootDir,
            sessionId,
            runtime,
            skillIds: options.skillIds,
          })
          return result.ok
            ? {
              ok: true,
              batchId: result.batchId,
              message: result.message,
            }
            : { ok: false, message: result.message }
        },
      }
    },

    createActionHost (
      rootDir: string,
      sessionId: string,
      runtime: IAgentWorkRuntime,
    ): IWorkbenchActionHost {
      return {
        async requestAction (input) {
          return requestAction(runtime, rootDir, sessionId, input)
        },
      }
    },

    async runAction (input) {
      let record = actions.get(input.actionId)

      // 服务重启后内存登记丢失，但卡片仍物化在会话历史里：从已落盘的
      // workbench_action 块恢复登记，让用户点历史卡片也能工作（LOG-2 的
      // 「回看并继续」要求，否则历史卡片会点了没反应）。
      if (!record || record.sessionId !== input.sessionId) {
        record = recoverAction(input.runtime, input.sessionId, input.actionId)
      }

      if (!record || record.sessionId !== input.sessionId) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 404,
          message: '该动作卡片不存在或已失效。',
        })
      }

      // 已消费 / 已失效的卡片不再受理（防止刷新后重复点击）。
      if (record.state && record.state !== 'pending') {
        return { ok: false, message: '该操作已经执行过了。' }
      }

      return executeAction(
        input.runtime,
        input.rootDir,
        record,
        input.confirmOverwrite ?? false,
      )
    },
  }

  /**
   * 为清单卡的一行登记一个行内动作（v17 Q6，**不发布卡片块**）。
   *
   * 与 `publishAction` 的差别只有一个 `registerOnly: true`——复用同一份登记
   * 结构与同一套消费接口（点击仍走 `POST /sessions/:id/actions/:actionId`），
   * 因此行内按钮与正式动作卡片的行为完全一致，不会成为第二套入口。
   *
   * @param runtime - 承载该会话的运行时。
   * @param sessionId - 会话 ID。
   * @param input - 动作、目标用例与按钮文案。
   * @returns 登记后的动作记录（宿主取 actionId 下发到清单行）。
   * @throws 不抛出异常。
   */
  function registerInlineAction (
    runtime: IAgentWorkRuntime,
    sessionId: string,
    input: {
      action: TAgentWorkbenchAction
      skillId: string
      skillTitle: string
      label: string
    },
  ): IActionRecord {
    return publishAction({
      runtime,
      sessionId,
      action: input.action,
      skillId: input.skillId,
      skillTitle: input.skillTitle,
      label: input.label,
      registerOnly: true,
    })
  }

  /**
   * 处理 Agent 的动作卡片请求（校验后发布）。
   *
   * @param runtime - 承载该会话的运行时（卡片发布落点）。
   * @param rootDir - 工作区根目录。
   * @param sessionId - 发起会话。
   * @param input - 动作、目标与说明。
   * @returns 发布结果。
   * @throws 不抛出异常——校验失败归一为 `{ ok: false }`。
   */
  async function requestAction (
    runtime: IAgentWorkRuntime,
    rootDir: string,
    sessionId: string,
    input: {
      action: TAgentWorkbenchAction
      skillId: string | null
      description?: string
      reportRunId?: string
    },
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    // 创建动作不需要目标：此时用例尚不存在（PRD ID-6）。
    if (input.action === 'create-skill') {
      publishAction({
        runtime,
        sessionId,
        action: 'create-skill',
        skillId: null,
        label: '创建 e2e SKILL',
        ...(input.description
          ? { description: input.description }
          : { description: '当前工作区没有该用例，创建一个新的。' }),
      })
      return {
        ok: true,
        message:
          '已在对话流中给出「创建 e2e SKILL」入口，用户点击后会打开创建弹窗。请一并用文本说明未找到可执行的用例。',
      }
    }

    if (!input.skillId) {
      return { ok: false, message: '该动作需要目标用例的唯一 ID。' }
    }

    let title: string
    try {
      ; ({ title } = await requireSkill(rootDir, input.skillId))
    } catch {
      return {
        ok: false,
        message: `工作区内找不到 ID 为 ${input.skillId} 的用例，无法给出该动作入口。`,
      }
    }

    // 动作与产物的缺口必须相符（ID-7 / GEN-11）：脚本生成要求 SKILL.md 零缺陷，
    // 跳步必然失败；给出一个点了就报错的入口比不给更糟。
    const state = await readArtifactState(rootDir, input.skillId)
    const mismatch = describeActionMismatch(input.action, state)
    if (mismatch) {
      return { ok: false, message: mismatch }
    }

    const reportRunId = input.reportRunId?.trim() ?? ''
    if (input.action === 'repair-script') {
      return requestRepairAction(runtime, rootDir, sessionId, {
        skillId: input.skillId,
        skillTitle: title,
        reportRunId,
        ...(input.description ? { description: input.description } : {}),
      })
    }

    publishAction({
      runtime,
      sessionId,
      action: input.action,
      skillId: input.skillId,
      skillTitle: title,
      label: actionLabel(input.action),
      ...(input.description ? { description: input.description } : {}),
    })

    return {
      ok: true,
      message: `已在对话流中给出「${actionLabel(input.action)}」入口，用户点击后平台才会开始处理。请用文本说明当前情况（缺什么、为什么不能直接做）。`,
    }
  }

  /**
   * 发布修复脚本的动作卡片（v17 G2 / G2b / G4）。
   *
   * 三处约束在这里落地：
   *   1. **必须带 reportRunId**（G2a 的输入要求）——没有它，「修复」就退化成
   *      一次普通的重新生成；
   *   2. **G2b 的告知**：当前生成链路没有局部修补能力，修复在实现上等同整体
   *      重生成，因此卡片的 description 必须写明这一点（**在发起前**）；
   *   3. **G4 的计数**：同一 `(skillId, reportRunId)` 上 Agent 主动提议达 2 次
   *      后不再给出卡片——用户仍可自己说「再修一次」。
   *
   * @param runtime - 承载该会话的运行时。
   * @param rootDir - 工作区根目录。
   * @param sessionId - 会话 ID。
   * @param input - 目标、失败运行与可选补充说明。
   * @returns 发布结果。
   * @throws 不抛出异常。
   */
  async function requestRepairAction (
    runtime: IAgentWorkRuntime,
    rootDir: string,
    sessionId: string,
    input: {
      skillId: string
      skillTitle: string
      reportRunId: string
      description?: string
    },
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    if (input.reportRunId.length === 0) {
      return {
        ok: false,
        message:
          '修复脚本需要失败所在运行的编号。请从执行历史或报告卡片上取到运行编号（形如 20261009-143012）后重试；若该次执行没有生成报告，说明失败发生在启动阶段，应改用 update-playwright-script。',
      }
    }

    // 报告必须确实存在（模型可能凭记忆给了编号）。
    const resolved = await resolveSkill(
      { rootDir } satisfies ISkillStorageOptions,
      input.skillId,
    )
    const runs = await listTestReportRuns(resolved.skillRoot)
    if (!runs.includes(input.reportRunId)) {
      return {
        ok: false,
        message: `报告 ${input.reportRunId} 在该用例的报告目录里不存在。请用 read_run_history 确认实际有哪些运行，再重试。`,
      }
    }

    // G4：达上限后不再自动给出修复卡片（如实说明并给出替代方向）。
    const counterKey = `${input.skillId}:${input.reportRunId}`
    const suggested = repairSuggestions.get(counterKey) ?? 0
    if (suggested >= REPAIR_SUGGESTION_LIMIT) {
      return {
        ok: false,
        message: `这次失败的修复已经建议过 ${suggested} 次。请如实说明「修复未能解决该问题」，建议人工检查，并给出「在开发页打开脚本」与「查看报告」两个方向；不要再主动建议修复（用户明确要求时才可以再发起）。`,
      }
    }
    repairSuggestions.set(counterKey, suggested + 1)

    // G2b：发起前告知「将重新生成整份脚本」。文案与 GEN-10 的覆盖确认
    // **合并到同一次**（不得连弹两次）——具体是否叠加覆盖语义由 executeAction
    // 在点击时判定，这里只把两个事实都写进说明。
    const manuallyEdited = await isScriptManuallyEdited(rootDir, input.skillId)
    const description = manuallyEdited
      ? '将基于失败信息重新生成**整份**脚本（当前生成能力不支持局部修补）；该脚本已被手工修改，重新生成会覆盖这些改动。'
      : '将基于失败信息重新生成**整份**脚本（当前生成能力不支持局部修补）。'

    publishAction({
      runtime,
      sessionId,
      action: 'repair-script',
      skillId: input.skillId,
      skillTitle: input.skillTitle,
      label: actionLabel('repair-script'),
      description: input.description
        ? `${description} ${input.description}`
        : description,
      reportRunId: input.reportRunId,
    })

    return {
      ok: true,
      message: `已在对话流中给出「修复脚本」入口（基于失败运行 ${input.reportRunId}）。请用文本说明将要做什么、以及脚本可能被整体重新生成；用户点击后平台才会开始。`,
    }
  }

  /**
   * 执行一个已点击的动作。
   *
   * @param runtime - 承载该会话的运行时（卡片与编排落点）。
   * @param rootDir - 工作区根目录。
   * @param record - 动作记录。
   * @param confirmOverwrite - 覆盖确认（GEN-10）。
   * @returns 处理结果。
   * @throws 不抛出异常——失败归一为 `{ ok: false, message }`。
   */
  async function executeAction (
    runtime: IAgentWorkRuntime,
    rootDir: string,
    record: IActionRecord,
    confirmOverwrite: boolean,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    // 创建动作不在服务端执行：点击后由前端打开创建弹窗（LOG-3 的唯一跳转例外）。
    if (record.action === 'create-skill') {
      settleAction(runtime, record, 'consumed')
      return { ok: true, message: '已打开创建入口。' }
    }

    const skillId = record.skillId
    if (!skillId) {
      return { ok: false, message: '该动作缺少目标用例。' }
    }

    if (record.action === 'execute-test') {
      const result = await startExecution(
        runtime,
        rootDir,
        record.sessionId,
        skillId,
      )
      if (!result.ok) {
        // 就绪失败：卡片保持可点（用户修复后可再点一次），并回报全部问题。
        return {
          ok: false,
          message: result.issues.map((issue) => issue.message).join('\n'),
        }
      }
      settleAction(runtime, record, 'consumed')
      return { ok: true, message: '已发起执行。' }
    }

    // 生成类动作（GEN-1 / GEN-5 / GEN-10）。
    const generationAction = toGenerationAction(record.action)
    if (!generationAction) {
      return { ok: false, message: '该动作暂不支持。' }
    }

    // GEN-10：重新生成脚本前，脚本被手工编辑过时必须先取得确认。
    //
    // v17 G2b：修复动作的文案已把「将重新生成整份脚本」与「脚本已被手工修改」
    // **合并进同一次确认**（见 requestRepairAction）——因此这里对 repair-script
    // 不再单独弹一次确认（不得连续弹两次）。判据是：修复卡片的说明里已经写明
    // 覆盖后果时，用户点它就构成了一次完整的确认。
    if (generationAction === 'update-playwright-script' && !confirmOverwrite) {
      const edited = await isScriptManuallyEdited(rootDir, skillId)
      if (edited) {
        publishAction({
          runtime,
          sessionId: record.sessionId,
          action: 'update-playwright-script',
          skillId,
          ...(record.skillTitle ? { skillTitle: record.skillTitle } : {}),
          label: '确认覆盖并重新生成',
          description:
            '当前 test.spec.ts 已被手工修改，重新生成会覆盖这些改动。确认后平台才会开始生成。',
          requiresConfirm: true,
        })
        return {
          ok: false,
          message:
            '该脚本已被手工修改，请先确认覆盖（对话流中已给出确认入口）。',
        }
      }
    }

    // v17 G2：修复动作先读出失败摘要（**已脱敏、不含 env 值**），
    // 再作为生成上下文交给生成链路。
    let repairContext: IRepairContext | undefined
    if (record.action === 'repair-script') {
      const built = await buildRepairContext(
        rootDir,
        skillId,
        record.reportRunId,
      )
      if (!built.ok) {
        return { ok: false, message: built.message }
      }
      repairContext = built.context
    }

    settleAction(runtime, record, 'consumed')

    const outcome: TGenerationOutcome = await generation.run({
      runtime,
      rootDir,
      sessionId: record.sessionId,
      skillId,
      skillTitle: record.skillTitle ?? skillId,
      action: generationAction,
      ...(repairContext ? { repairContext } : {}),
    })

    // 生成结束后按产物完备性链式给出下一步（ID-7：缺什么补什么，齐备才给执行）。
    await proposeNextStep(runtime, rootDir, record.sessionId, skillId, outcome)

    return outcome.ok
      ? { ok: true, message: outcome.message }
      : { ok: false, message: outcome.message }
  }

  /**
   * 生成结束后的下一步引导（ID-7 / GEN-11）。
   *
   * @param runtime - 承载该会话的运行时（引导卡片的发布落点）。
   * @param rootDir - 工作区根目录。
   * @param sessionId - 目标会话。
   * @param skillId - 目标用例。
   * @param outcome - 生成结果。
   * @returns 引导完成后兑现。
   * @throws 不抛出异常（引导失败不影响生成结果的呈现）。
   */
  async function proposeNextStep (
    runtime: IAgentWorkRuntime,
    rootDir: string,
    sessionId: string,
    skillId: string,
    outcome: TGenerationOutcome,
  ): Promise<void> {
    try {
      if (!outcome.ok) {
        // GEN-8：失败给重试入口，不静默、不呈现为已完成。
        publishAction({
          runtime,
          sessionId,
          action: 'retry',
          skillId,
          ...(outcome.skillTitle ? { skillTitle: outcome.skillTitle } : {}),
          label: '重试',
          description: outcome.message.slice(0, 300),
        })
        return
      }

      const state = await readArtifactState(rootDir, skillId)
      if (!state.hasSkillDocument) {
        publishAction({
          runtime,
          sessionId,
          action: 'generate-skill-document',
          skillId,
          ...(outcome.skillTitle ? { skillTitle: outcome.skillTitle } : {}),
          label: '生成 SKILL.md',
        })
        return
      }
      if (!state.hasPlaywrightScript) {
        publishAction({
          runtime,
          sessionId,
          action: 'generate-playwright-script',
          skillId,
          ...(outcome.skillTitle ? { skillTitle: outcome.skillTitle } : {}),
          label: '生成 Playwright 脚本',
        })
        return
      }
      publishAction({
        runtime,
        sessionId,
        action: 'execute-test',
        skillId,
        ...(outcome.skillTitle ? { skillTitle: outcome.skillTitle } : {}),
        label: '执行测试',
      })
    } catch {
      // 引导失败不影响生成结果本身：用户仍能看到产物卡片与 Agent 的文本结论。
    }
  }
}

/**
 * 读取用例的产物完备性（判定下一步动作的唯一依据）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 文档与脚本的存在性。
 * @throws 不抛出异常——读取失败按「不存在」处理（引导用户补齐产物是安全方向）。
 */
async function readArtifactState (
  rootDir: string,
  skillId: string,
): Promise<{ hasSkillDocument: boolean; hasPlaywrightScript: boolean }> {
  const catalog = createSkillCatalog()
  const candidates = await catalog.listCandidates(rootDir)
  const candidate = candidates.find((item) => item.id === skillId)
  return {
    hasSkillDocument: candidate?.hasSkillDocument ?? false,
    hasPlaywrightScript: candidate?.hasPlaywrightScript ?? false,
  }
}

/**
 * 判定「动作是否与产物缺口相符」（ID-7 / GEN-11 的服务端兜底）。
 *
 * 为什么要在服务端再判一次：提示词已经约束了 Agent，但卡片一旦发布，
 * 用户点下去就会真的跑生成——给出一个必然失败的入口比不给更糟。
 *
 * @param action - 待校验的动作。
 * @param state - 用例当前产物状态。
 * @returns 不相符时的说明；相符时返回 undefined。
 * @throws 不抛出异常。
 */
function describeActionMismatch (
  action: TAgentWorkbenchAction,
  state: { hasSkillDocument: boolean; hasPlaywrightScript: boolean },
): string | undefined {
  if (action === 'generate-playwright-script' && !state.hasSkillDocument) {
    return '该用例还没有 SKILL.md，脚本生成要求文档零缺陷——请先生成 SKILL.md，再生成脚本。'
  }
  if (action === 'update-playwright-script' && !state.hasPlaywrightScript) {
    return '该用例还没有 test.spec.ts，不存在「重新生成」的场景——请使用「生成 Playwright 脚本」。'
  }
  if (action === 'execute-test') {
    if (!state.hasSkillDocument || !state.hasPlaywrightScript) {
      return '该用例的产物不完整（需要同时具备 SKILL.md 与 test.spec.ts），不能发起执行——请先补齐缺失的产物。'
    }
  }
  return undefined
}

/** 动作的中文按钮文案。 */
function actionLabel (action: TAgentWorkbenchAction): string {
  switch (action) {
    case 'create-skill':
      return '创建 e2e SKILL'
    case 'generate-skill-document':
      return '生成 SKILL.md'
    case 'generate-playwright-script':
      return '生成 Playwright 脚本'
    case 'update-playwright-script':
      return '更新 Playwright 脚本'
    case 'execute-test':
      return '执行测试'
    case 'retry':
      return '重试'
    case 'repair-script':
      return '修复脚本'
  }
}

/**
 * 把动作映射为生成编排的动作（非生成类返回 undefined）。
 *
 * @param action - 工作台动作。
 * @returns 生成动作；非生成类返回 undefined。
 * @throws 不抛出异常。
 */
function toGenerationAction (
  action: TAgentWorkbenchAction,
): TGenerationAction | undefined {
  if (
    action === 'generate-skill-document' ||
    action === 'generate-playwright-script' ||
    action === 'update-playwright-script' ||
    action === 'retry'
  ) {
    return action
  }
  return undefined
}

/**
 * 组装修复上下文（v17 G2a）：读失败摘要 + 用例版本。
 *
 * 三者都已在平台侧（报告在 `test_report/`、脚本在 Skill 根、用例在
 * `e2e_schema.json`），由本函数读出**摘要**交给生成子会话——
 * Agent 全程不碰这些文件（G2a 的输入约束）。
 *
 * 净化（§8）：`errorMessage` 先经脱敏器处理再进 prompt。脱敏器用的秘密集合
 * 取自当前 env.json 的值——那正是唯一可能泄漏进错误文本的敏感来源。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @param reportRunId - 失败所在运行的编号（缺省为不合法）。
 * @returns 修复上下文；读不到摘要时返回失败并说明。
 * @throws 不抛出异常——所有失败都归一为 `{ ok: false }`。
 */
async function buildRepairContext (
  rootDir: string,
  skillId: string,
  reportRunId: string | undefined,
): Promise<
  { ok: true; context: IRepairContext } | { ok: false; message: string }
> {
  if (!reportRunId) {
    return {
      ok: false,
      message:
        '该修复卡片缺少失败运行的编号，无法读取失败信息。请重新发起修复（带上运行编号）。',
    }
  }

  try {
    const storage: ISkillStorageOptions = { rootDir }
    const resolved = await resolveSkill(storage, skillId)
    const summary = await readTestReportSummary(resolved.skillRoot, reportRunId)
    if (!summary) {
      return {
        ok: false,
        message: `读不到运行 ${reportRunId} 的失败摘要（该次可能没有生成报告）。请改用「更新脚本」入口。`,
      }
    }

    const document = await new FileE2ETestCaseRepository(storage).findBySkillId(
      skillId,
    )

    // 脱敏：env 值只在读取这一刻接触，随即丢弃，绝不进 prompt 或事件。
    const secrets = await readEnvSecretValues(storage, skillId)
    const redactor = new DefaultSensitiveDataRedactor({ secrets })

    return {
      ok: true,
      context: {
        reportRunId,
        failures: (summary.failures ?? []).map((failure) => ({
          title: failure.title,
          ...(failure.stepId ? { stepId: failure.stepId } : {}),
          ...(failure.errorMessage
            ? { errorMessage: redactor.redact(failure.errorMessage) }
            : {}),
        })),
        testCaseVersion: document.version,
      },
    }
  } catch (error) {
    return {
      ok: false,
      message: `读取失败信息出错：${error instanceof Error ? error.message : String(error)
        }`,
    }
  }
}

/**
 * 读取 env.json 的值集合（仅用于脱敏，不返回给任何消费方）。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns 值列表；文件缺失或非法时为空数组。
 * @throws 不抛出异常。
 */
async function readEnvSecretValues (
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<string[]> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    const snapshot = await readFixedUtf8File(
      resolved.skillRoot,
      SKILL_ENV_FILE_NAME,
    )
    if (!snapshot) return []
    const parsed = parseEnvFileContent(snapshot.content)
    return parsed.data ? Object.values(parsed.data) : []
  } catch {
    return []
  }
}

/**
 * 判断脚本是否已被手工编辑（PRD GEN-10）。
 *
 * 判据：磁盘文件的修改时间与 manifest 记录的 `generatedAt` 是否一致
 * ——保存链路把写入后的 mtime 同时写进元数据，因此两者不等即说明
 * 文件在平台写入之后被改过（用户手工编辑、外部工具改写）。
 *
 * 保守方向：**无法判定时按「已编辑」处理**——宁可不必要地多要一次确认，
 * 也不能静默覆盖用户的手工改动。无生成元数据时同理（脚本不是平台产出的）。
 *
 * @param rootDir - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 已编辑或无法判定时返回 true；脚本不存在时返回 false。
 * @throws 不抛出异常——读取失败按「已编辑」处理（保守）。
 */
async function isScriptManuallyEdited (
  rootDir: string,
  skillId: string,
): Promise<boolean> {
  try {
    const storage: ISkillStorageOptions = { rootDir }
    const resolved = await resolveSkill(storage, skillId)
    const snapshot = await readFixedUtf8File(
      resolved.skillRoot,
      PLAYWRIGHT_SCRIPT_FILE_NAME,
    )

    // 没有脚本：不存在「覆盖手工改动」的问题。
    if (!snapshot) return false

    const metadata = resolved.manifest.generatedScript
    // 无生成记录：脚本不是平台产出的（用户自建），覆盖同样需要确认。
    if (!metadata) return true

    return snapshot.updatedAt !== metadata.generatedAt
  } catch {
    return true
  }
}

/** 就绪问题归一（保持 v11 的问题码与文案不变）。 */
function toExecutionIssues (
  issues: ReadonlyArray<{ code: string; message: string }>,
): IExecuteTestIssue[] {
  return issues.map((issue) => ({ code: issue.code, message: issue.message }))
}

/**
 * 是否为执行终态（无摘要时的兜底判据）。
 *
 * 写成类型谓词而不是单纯返回 boolean：调用方在 setTimeout 回调里使用该状态，
 * 若守卫不收窄类型，`'running'` 会留在联合里导致编译失败——而 `running`
 * 根本不该出现在这条路径上（它是过程态，不是终态）。
 *
 * @param status - 执行事件携带的状态。
 * @returns 是终态时返回 true，并把类型收窄为终态联合。
 * @throws 不抛出异常。
 */
/**
 * 判断会话当前是否有**进行中的对话轮次**。
 *
 * 依据是会话概要的状态：轮次开始置 running、结束回落 idle
 * （见 `work-block-store` 的 turn 分支）。执行卡片据此决定要不要等 turn end：
 *   - 有进行中的轮次（用户在对话里说「跑一下」）→ 等，让卡片排到 Agent 说明之后；
 *   - 没有（用户点动作卡片发起）→ 立即发布，否则永远等不到 turn end。
 *
 * @param runtime - 承载该会话的运行时。
 * @param sessionId - 会话 ID。
 * @returns 存在进行中的轮次时返回 true。
 * @throws 不抛出异常——读取失败按「没有进行中的轮次」处理（立即发布更安全：
 *   宁可卡片早出现，也不要它永远不出现）。
 */
function hasOpenTurn (runtime: IAgentWorkRuntime, sessionId: string): boolean {
  try {
    const summary = runtime
      .listSessions()
      .find((item) => item.sessionId === sessionId)
    return summary?.status === 'running'
  } catch {
    return false
  }
}

function isTerminalExecutionStatus (
  status: string,
): status is 'completed' | 'failed' | 'interrupted' {
  return (
    status === 'completed' || status === 'failed' || status === 'interrupted'
  )
}

/** 由执行汇总生成一句给模型看的结论（只含统计，不含任何 env 值）。 */
function describeSummary (summary: {
  status: string
  total: number
  passed: number
  failed: number
  interrupted: number
  skipped: number
  runId: string
  results: ReadonlyArray<{
    title: string
    status: string
    failedStepId?: string
  }>
}): string {
  if (summary.status === 'interrupted') {
    return `执行已中断：共 ${summary.total} 条，通过 ${summary.passed} 条，失败 ${summary.failed} 条。报告已尽力生成（运行 ${summary.runId}）。`
  }

  const head = `执行完成：共 ${summary.total} 条，通过 ${summary.passed} 条，失败 ${summary.failed} 条${summary.skipped > 0 ? `，跳过 ${summary.skipped} 条` : ''}。运行 ${summary.runId}。`
  const failures = summary.results.filter(
    (result) => result.status === 'failed' || result.status === 'timedOut',
  )
  if (failures.length === 0) {
    return head
  }

  const failureLines = failures
    .slice(0, 5)
    .map(
      (result) =>
        `- 「${result.title}」失败${result.failedStepId ? `（失败步骤：${result.failedStepId}）` : ''}`,
    )
  return [head, '失败用例：', ...failureLines].join('\n')
}

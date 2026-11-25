/**
 * 测试执行 store（v11，技术方案 §7.2）。
 *
 * 按 skillId 维护当前执行的展示状态：状态、日志行（上限 800，自动丢旧）、
 * 步骤进度、测试结果、summary 与就绪摘要问题；负责 SSE 消费（断线指数退避
 * 重连 + afterSeq 续传）与执行发起/停止编排。
 *
 * 为什么上收为 store：执行入口在文件树（SkillExplorer）与 Chat（Agent 工具），
 * 承载组件在全局侧边栏（GlobalChatDrawer），三者是兄弟关系——沿既有的跨组件
 * 共享手段（agent-work、generation-flow 均为 store）。
 *
 * 非持久化：执行状态在内存中；刷新后经 `restore()` 用服务端快照重建（X16），
 * 服务重启则按「执行记录不存在」降级（R7）。
 */
import { reactive, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type {
  IExecutionPrecheckIssue,
  IExecutionSnapshot,
  IExecutionSummary,
  IExecutionTestCaseResult,
  TExecutionEvent,
  TExecutionStage,
  TExecutionStageStatus,
  TExecutionStatus,
} from '@charlie_deng/e2e-assistant-types'
import {
  fetchExecutionSnapshot,
  fetchLatestExecutionSnapshot,
  startExecution as startExecutionApi,
  stopExecution as stopExecutionApi,
  streamExecutionEvents,
} from '../services/execution-api'
import { ApiClientError } from '../services/http-client'

/** 单条日志展示上限（与服务端环形缓冲的 log 容量一致）。 */
const MAX_LOG_LINES = 800

/** 断线重连的退避节奏（毫秒）。 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const

/** 单条步骤的展示状态。 */
export interface IExecutionStepView {
  stepId: string
  testTitle: string
  /** null = 进行中。 */
  ok: boolean | null
}

/** 单条阶段过程项（「执行过程」清单的展示模型）。 */
export interface IExecutionStageView {
  stage: TExecutionStage
  status: TExecutionStageStatus
  label: string
}

/** 单个 Skill 的执行展示状态。 */
export interface IExecutionRecordState {
  executionId: string
  /** 目标 Skill 标题（区块头展示；旧快照可能缺省）。 */
  skillTitle?: string
  status: TExecutionStatus
  /** 开始时刻（毫秒时间戳，供耗时计数的基准）。 */
  startedAtMs: number
  /** 终态时长（结束后展示 summary.durationMs）。 */
  durationMs?: number
  /** 日志行（已脱敏，环形上限）。 */
  logs: string[]
  /** 执行过程阶段（按阶段首次出现顺序）。 */
  stages: IExecutionStageView[]
  /** 已结束的测试结果（按结束顺序）。 */
  tests: IExecutionTestCaseResult[]
  /** 步骤进度（按开始顺序）。 */
  steps: IExecutionStepView[]
  /** 结果汇总（结束后提供）。 */
  summary?: IExecutionSummary
  /** 就绪摘要问题（422 时填充）。 */
  issues: IExecutionPrecheckIssue[]
}

/** 执行结果的全局通知（V2：含「查看报告」入口所需数据）。 */
export interface IExecutionNotification {
  skillId: string
  /**
   * 本次执行的执行 ID（v13）。
   *
   * 通知的去重键与「查看报告」的定位都需要它：同一 Skill 可能先后跑多次，
   * 只用 `skillId` 会让第二次执行结束被误判为「已提示过」。
   */
  executionId: string
  /** 目标 Skill 标题（v13：完成提示里要说明是哪个用例，PRD N-6）。 */
  skillTitle?: string
  kind: 'success' | 'error' | 'warning'
  message: string
  /** 报告相对路径（生成成功时携带，通知据此提供查看入口）。 */
  reportRelativePath?: string
}

export const useExecutionStore = defineStore('test-execution', () => {
  /** Skill ID → 展示状态。 */
  const records = reactive<Record<string, IExecutionRecordState>>({})
  /** 全局通知队列（组件消费后调 dismiss）。 */
  const lastNotification = shallowRef<IExecutionNotification | null>(null)
  /** SSE 连接状态（键同 records）。 */
  const streamStates = reactive<
    Record<string, 'idle' | 'connecting' | 'open' | 'closed'>
  >({})

  /** 文件树刷新回调（由 SkillDevPage 注入，内部已带防抖）。 */
  let treeRefresher: (() => void) | null = null
  /** 每条 SSE 流的中止控制器。 */
  const streamControllers = new Map<string, AbortController>()

  /** 判断指定 Skill 是否存在可展示的执行内容。 */
  function hasContent (skillId: string): boolean {
    return Boolean(records[skillId])
  }

  /** 判断指定 Skill 是否有运行中的执行。 */
  function isRunning (skillId: string): boolean {
    const record = records[skillId]
    return Boolean(
      record &&
      (record.status === 'prechecking' || record.status === 'running'),
    )
  }

  /** 注入文件树刷新回调。 */
  function setTreeRefresher (refresh: (() => void) | null): void {
    treeRefresher = refresh
  }

  /** 清除当前通知（组件展示后调用）。 */
  function dismissNotification (): void {
    lastNotification.value = null
  }

  /**
   * 发起执行（前提：调用方已完成 J3 的保存前置，见技术方案 §7.5）。
   *
   * @param skillId - 目标 Skill。
   * @returns 发起成功（进入运行）返回 true；就绪校验失败返回 false（问题已写入
   *          records[skillId].issues 供就绪摘要渲染）。
   * @throws 网络错误向上抛出（由调用方提示）。
   */
  async function startExecution (skillId: string): Promise<boolean> {
    // 新一轮发起总是覆盖旧状态（PRD：卡片保留直至下一次执行）。
    delete records[skillId]

    try {
      const { executionId, skillTitle } = await startExecutionApi(skillId)
      records[skillId] = {
        executionId,
        ...(skillTitle ? { skillTitle } : {}),
        status: 'prechecking',
        startedAtMs: Date.now(),
        logs: [],
        stages: [],
        tests: [],
        steps: [],
        issues: [],
      }
      void openStream(skillId, executionId, undefined)
      return true
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 422) {
        records[skillId] = {
          executionId: '',
          status: 'prechecking',
          startedAtMs: Date.now(),
          logs: [],
          stages: [],
          tests: [],
          steps: [],
          issues: toPrecheckIssues(error.issues).length
            ? toPrecheckIssues(error.issues)
            : [{ code: 'EXECUTION_PRECHECK_FAILED', message: error.message }],
        }
        return false
      }
      throw error
    }
  }

  /**
   * 恢复指定 Skill 的最近执行（进入页面时调用，X16）。
   *
   * 服务端无记录（重启/清理）时静默忽略。
   *
   * @param skillId - 目标 Skill。
   * @returns 恢复完成后兑现。
   */
  async function restore (skillId: string): Promise<void> {
    if (records[skillId] && isRunning(skillId)) {
      return
    }

    try {
      const snapshot = await fetchLatestExecutionSnapshot(skillId)
      if (!snapshot) return
      adoptSnapshot(skillId, snapshot)
    } catch {
      // 快照恢复失败不阻断页面：侧边栏无执行区块即可。
    }
  }

  /**
   * 认领一次**由别处发起**的执行（v16：/agent 工作台的执行卡片）。
   *
   * 与 `startExecution` / `restore` 的分工：那两个入口各自负责「我要发起」与
   * 「我进页面时恢复最近一次」；工作台的执行由服务端发起，前端只拿到
   * executionId，因此需要单独一条「按已知执行 ID 接管展示」的路径——
   * 复用同一份快照接口与 SSE 订阅，因此过程展示与 Skill 开发页逐条等同（R2）。
   *
   * @param skillId - 目标 Skill。
   * @param executionId - 服务端已发起的执行 ID。
   * @returns 接管完成后兑现。
   * @throws 不抛出异常——快照不可用时静默降级（卡片仍有服务端摘要）。
   */
  async function adopt (skillId: string, executionId: string): Promise<void> {
    // 已有记录且就是这一次：不重复接管（重复调用是组件的常态）。
    if (records[skillId]?.executionId === executionId) return

    try {
      const snapshot = await fetchExecutionSnapshot(skillId, executionId)
      adoptSnapshot(skillId, snapshot)
    } catch {
      // 快照不可用（服务重启/已被清理）：卡片仍展示服务端下发的终态摘要，
      // 只是没有逐条日志——这是可接受的降级，不阻断对话流。
    }
  }

  /** 停止执行（X10）。 */
  async function stop (skillId: string): Promise<void> {
    const record = records[skillId]
    if (!record || !record.executionId) return

    try {
      await stopExecutionApi(skillId, record.executionId)
    } catch (error) {
      if (!(error instanceof ApiClientError && error.kind === 'aborted')) {
        // 停止失败不阻断界面：执行自身的终态事件仍会到达。
      }
    }
  }

  /**
   * 打开 SSE 流并负责断线重连（指数退避 + afterSeq 续传）。
   *
   * @param skillId - Skill ID。
   * @param executionId - 执行 ID。
   * @param afterSeq - 补发起点。
   */
  async function openStream (
    skillId: string,
    executionId: string,
    afterSeq?: number,
  ): Promise<void> {
    // 同一执行只允许一条流。
    streamControllers.get(skillId)?.abort()
    const controller = new AbortController()
    streamControllers.set(skillId, controller)

    let reconnectIndex = 0
    let lastSeq = afterSeq

    while (!controller.signal.aborted) {
      streamStates[skillId] = reconnectIndex === 0 ? 'connecting' : 'open'
      try {
        await streamExecutionEvents({
          skillId,
          executionId,
          ...(lastSeq !== undefined ? { afterSeq: lastSeq } : {}),
          signal: controller.signal,
          onEvent: (frame) => {
            streamStates[skillId] = 'open'
            try {
              const event = JSON.parse(frame.data) as TExecutionEvent
              applyEvent(skillId, event)
              lastSeq = event.seq
            } catch {
              // 无法解析的帧忽略（服务端不会发送，防御性容错）。
            }
          },
        })
        // 服务端正常关闭：执行已结束则退出，否则按断线处理。
        const record = records[skillId]
        if (
          !record ||
          record.executionId !== executionId ||
          isTerminalStatus(record.status)
        ) {
          break
        }
      } catch (error) {
        if (controller.signal.aborted) break
        if (error instanceof ApiClientError && error.kind === 'aborted') break
        // 执行记录不存在（服务重启）：降级为无流，状态由快照兜底。
        if (error instanceof ApiClientError && error.status === 404) {
          streamStates[skillId] = 'closed'
          break
        }
      }

      // 断线退避重连。
      const delay =
        RECONNECT_DELAYS_MS[
        Math.min(reconnectIndex, RECONNECT_DELAYS_MS.length - 1)
        ]
      reconnectIndex += 1
      streamStates[skillId] = 'connecting'
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    if (streamControllers.get(skillId) === controller) {
      streamControllers.delete(skillId)
    }
  }

  /** 用服务端快照重建展示状态（X16），并按需续连 SSE。 */
  function adoptSnapshot (skillId: string, snapshot: IExecutionSnapshot): void {
    if (records[skillId]?.executionId === snapshot.executionId) {
      return
    }

    const record: IExecutionRecordState = {
      executionId: snapshot.executionId,
      ...(snapshot.skillTitle ? { skillTitle: snapshot.skillTitle } : {}),
      status: snapshot.status,
      startedAtMs: Date.parse(snapshot.summary?.startedAt ?? '') || Date.now(),
      logs: [],
      stages: [],
      tests: [],
      steps: [],
      issues: toPrecheckIssues(snapshot.issues),
      ...(snapshot.summary
        ? { summary: snapshot.summary, durationMs: snapshot.summary.durationMs }
        : {}),
    }
    records[skillId] = record

    for (const event of snapshot.events) {
      applyEvent(skillId, event)
    }

    if (!isTerminalStatus(snapshot.status)) {
      void openStream(skillId, snapshot.executionId, snapshot.currentSeq)
    }
  }

  /** 应用一条执行事件到展示状态。 */
  function applyEvent (skillId: string, event: TExecutionEvent): void {
    const record = records[skillId]
    if (!record || event.seq < 0) return

    switch (event.type) {
      case 'status':
        record.status = event.status
        break
      case 'log':
        record.logs.push(event.line)
        if (record.logs.length > MAX_LOG_LINES) {
          record.logs.splice(0, record.logs.length - MAX_LOG_LINES)
        }
        break
      case 'stage': {
        // 阶段清单按首次出现顺序排列；同阶段后发事件覆盖状态与文案。
        const existing = record.stages.findIndex(
          (item) => item.stage === event.stage,
        )
        const view: IExecutionStageView = {
          stage: event.stage,
          status: event.status,
          label: event.label,
        }
        if (existing >= 0) record.stages.splice(existing, 1, view)
        else record.stages.push(view)
        break
      }
      case 'test-start':
        // 测试开始仅用于日志语境；结果列表以 test-end 为准。
        break
      case 'test-end': {
        const existing = record.tests.findIndex(
          (item) => item.title === event.result.title,
        )
        if (existing >= 0) record.tests.splice(existing, 1)
        record.tests.push(event.result)
        break
      }
      case 'step-start': {
        const existing = record.steps.findIndex(
          (item) => item.stepId === event.stepId,
        )
        if (existing >= 0) record.steps.splice(existing, 1)
        record.steps.push({
          stepId: event.stepId,
          testTitle: event.testTitle,
          ok: null,
        })
        break
      }
      case 'step-end': {
        const step = record.steps.find((item) => item.stepId === event.stepId)
        if (step) step.ok = event.ok
        break
      }
      case 'files-changed':
        // X17：执行产生的目录/文件实时刷新文件树（回调已由页面注入并防抖）。
        treeRefresher?.()
        break
      case 'summary': {
        record.summary = event.summary
        record.status = event.summary.status
        record.durationMs = event.summary.durationMs
        publishNotification(skillId, record, event.summary)
        // 终态后关闭 SSE 流。
        streamControllers.get(skillId)?.abort()
        break
      }
    }
  }

  /**
   * 由 summary 派生全局通知（PRD 第 9 章的状态语义与文案）。
   *
   * @param skillId - 目标 Skill。
   * @param record - 该 Skill 的展示状态（取执行 ID 与标题，供去重与文案使用）。
   * @param summary - 服务端下发的执行汇总。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function publishNotification (
    skillId: string,
    record: IExecutionRecordState,
    summary: IExecutionSummary,
  ): void {
    const failed = summary.failed

    let kind: IExecutionNotification['kind'] = 'success'
    let message = `执行完成：${summary.total} 条全部通过`

    if (summary.status === 'interrupted') {
      kind = 'warning'
      message = '执行已中断'
    } else if (failed > 0) {
      kind = 'error'
      message = `执行完成：通过 ${summary.passed} 条，失败 ${failed} 条`
    }

    lastNotification.value = {
      skillId,
      executionId: record.executionId,
      ...(record.skillTitle ? { skillTitle: record.skillTitle } : {}),
      kind,
      message,
      ...(summary.reportRelativePath
        ? { reportRelativePath: summary.reportRelativePath }
        : {}),
    }
  }

  return {
    records,
    streamStates,
    lastNotification,
    hasContent,
    isRunning,
    startExecution,
    restore,
    adopt,
    stop,
    setTreeRefresher,
    dismissNotification,
  }
})

/** 判断执行状态是否为终态。 */
function isTerminalStatus (status: TExecutionStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'interrupted'
  )
}

/**
 * 把 HTTP 错误信封的问题明细收敛为就绪摘要类型。
 *
 * `ApiClientError.issues` 的 target 是宽松 string（兼容旧负载），
 * 此处收敛为就绪摘要认定的两个跳转目标，其余目标不携带。
 *
 * @param issues - 错误信封携带的问题明细。
 * @returns 就绪摘要可渲染的问题列表。
 */
function toPrecheckIssues (
  issues?: Array<{ code: string; message: string; target?: string }>,
): IExecutionPrecheckIssue[] {
  return (issues ?? []).map((issue) => ({
    code: issue.code,
    message: issue.message,
    ...(issue.target === 'env-file' || issue.target === 'test-case'
      ? { target: issue.target }
      : {}),
  }))
}

/**
 * 连续执行编排（v17 §6.4，PRD R4）。会话内串行执行多个用例。
 *
 * ## 边界（PRD §2.2 第 1 条）
 *
 * 这**不是平台级批量执行**——不新增任务种类到执行服务、不产生批次报告、
 * 不新增批次互斥维度。每个条目都走 `ITestExecutionService.start()`，
 * 与手工单跑完全同一条链路（同一套就绪校验、快照、报告、互斥判定）。
 *
 * ## 三态
 *
 *   awaiting-confirmation → running → completed / interrupted
 *                        ↘ cancelled（用户取消）
 *
 * `awaiting-confirmation` 必须先于 running 存在，且**不占用执行通道**
 *（尚未开始跑任何东西）。
 *
 * ## 两个时序坑（技术方案 §6.4 明确点出）
 *
 *   1. **停止的顺序不能反**：`stop()` 先调执行服务的 stop 停止当前条目，
 *      再置批次停止标志。反了则循环可能在标志生效前又启动下一个条目。
 *   2. **就绪预判 vs 就绪校验**：待确认态展示的是预判（只读判定，不创建目录），
 *      执行时仍要真校验（每次 `start()` 内部会再走一遍）——预判只是展示，
 *      不是放行依据。两者同源，只是预判不做有副作用的项。
 */

import { randomUUID } from 'node:crypto'
import { ApiError } from '../../shared/errors/api-error'
import type { IAgentWorkRuntime } from '../../agent-runtime/agent-work-runtime'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import type { ITestExecutionService } from '../test-execution/execution-service'
import type { IExecutionEventBus } from '../test-execution/execution-event-bus'
import type { ISkillStorageOptions } from '@authine-e2e-agent/skill-manager'
import { resolveSkill } from '@authine-e2e-agent/skill-manager'
import type { IBatchItem, TBatchStatus } from '@authine-e2e-agent/types'
import type { IReadinessService } from './execution-readiness'

/**
 * 单批条目上限（R4b）。
 *
 * 取值理由：一次跑 10 个用例约 20–40 分钟（含等待），已接近用户的注意力上限；
 * 超过上限要求按条件缩小范围，比静默截断诚实。
 */
export const BATCH_MAX_ITEMS = 10

/** 批次在内存中的登记。 */
interface IBatchRecord {
  batchId: string
  sessionId: string
  skillIds: string[]
  items: IBatchItem[]
  status: TBatchStatus
  startedAt: number
  /** 用户请求停止的标记（循环在每条目开始前检查）。 */
  stopRequested: boolean
  /** 当前条目的执行 ID（stop 的落点）。 */
  currentExecutionId?: string
  currentSkillId?: string
  /** 当前条目终态的解除等待句柄。 */
  unsubscribe?: () => void
}

/** 批次服务的依赖。 */
export interface IBatchExecutionServiceDependencies {
  /** 执行服务（每个条目都走它的 start——与手工单跑同一条链路）。 */
  testExecutionService: ITestExecutionService
  /** 执行事件总线（订阅条目终态）。 */
  executionEventBus: IExecutionEventBus
  /** 任务注册表（条目的就绪预判与执行互斥判定来源）。 */
  taskRegistry: IGenerationTaskRegistry
  /** 体检服务（待确认态的逐条就绪预判；**只读判定**，不创建目录）。 */
  readiness: IReadinessService
}

/** 连续执行的创建输入。 */
export interface ICreateBatchInput {
  rootDir: string
  sessionId: string
  runtime: IAgentWorkRuntime
  skillIds: string[]
}

/** 批次服务接口。 */
export interface IBatchExecutionService {
  /**
   * 创建一批连续执行（待确认态）。**不启动任何执行**。
   *
   * @param input - 工作区、会话、运行时与目标用例清单（顺序即执行顺序）。
   * @returns 批次 ID；超上限或目标不合法时返回失败并说明原因（R4b：不截断）。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  create(
    input: ICreateBatchInput,
  ): Promise<
    | { ok: true; batchId: string; message: string }
    | { ok: false; message: string }
  >

  /**
   * 用户确认 → 开始串行执行（R4a → R4c）。
   *
   * @param input - 工作区与批次标识。
   * @returns 启动结果。
   * @throws ApiError 批次不存在或状态不符时抛出。
   */
  confirm(input: {
    rootDir: string
    sessionId: string
    batchId: string
    runtime: IAgentWorkRuntime
  }): Promise<{ ok: true } | { ok: false; message: string }>

  /**
   * 用户取消（待确认态，R4a）：不做任何事、不产生执行记录。
   *
   * @param input - 会话、批次与运行时（卡片更新落点）。
   * @returns 取消完成时兑现。
   * @throws ApiError 批次不存在时抛出。
   */
  cancel(input: {
    sessionId: string
    batchId: string
    runtime: IAgentWorkRuntime
  }): { ok: true }

  /**
   * 停止：停止当前条目并终止整个批次，剩余标记「未执行」（R4e）。
   *
   * @param input - 会话、批次与运行时。
   * @returns 停止请求的受理结果。
   * @throws ApiError 批次不存在时抛出。
   */
  stop(input: {
    sessionId: string
    batchId: string
    runtime: IAgentWorkRuntime
  }): { ok: true }
}

/**
 * 创建连续执行服务。
 *
 * @param dependencies - 执行服务、事件总线、任务注册表与体检服务。
 * @returns 批次服务实例。
 * @throws 不抛出异常。
 */
export function createBatchExecutionService(
  dependencies: IBatchExecutionServiceDependencies,
): IBatchExecutionService {
  /** 批次登记表（batchId → 记录）。 */
  const batches = new Map<string, IBatchRecord>()

  return {
    async create(input) {
      return createBatch(dependencies, batches, input)
    },

    async confirm(input) {
      const record = requireBatch(batches, input.sessionId, input.batchId)
      if (record.status !== 'awaiting-confirmation') {
        return {
          ok: false,
          message: '该批次已经开始或已结束，无法再次确认。',
        }
      }

      record.status = 'running'
      publishBatch(input.runtime, record)

      // 非阻塞：串行循环在后台推进，卡片承载进度（与单次执行同构）。
      void runBatch(dependencies, batches, record, input.runtime, input.rootDir)

      return { ok: true }
    },

    cancel(input) {
      const record = requireBatch(batches, input.sessionId, input.batchId)
      if (record.status === 'awaiting-confirmation') {
        record.status = 'cancelled'
        publishBatch(input.runtime, record)
      }
      return { ok: true }
    },

    stop(input) {
      const record = requireBatch(batches, input.sessionId, input.batchId)
      if (record.status !== 'running') {
        return { ok: true }
      }

      // 时序（§6.4 第 2 点）：先停当前条目，再置停止标志——**顺序不能反**。
      // 反了则循环可能在标志生效前又启动下一个条目。
      if (record.currentSkillId) {
        dependencies.testExecutionService.stop({
          skillId: record.currentSkillId,
        })
      }
      record.stopRequested = true

      return { ok: true }
    },
  }
}

/**
 * 创建一批连续执行（待确认态）。
 *
 * @param dependencies - 服务依赖。
 * @param batches - 批次登记表。
 * @param input - 创建输入。
 * @returns 创建结果。
 * @throws 不抛出异常。
 */
async function createBatch(
  dependencies: IBatchExecutionServiceDependencies,
  batches: Map<string, IBatchRecord>,
  input: ICreateBatchInput,
): Promise<
  | { ok: true; batchId: string; message: string }
  | { ok: false; message: string }
> {
  const skillIds = [...new Set(input.skillIds)]

  // 上限（R4b）：**不截断**——悄悄只跑前 10 个是最坏的一种失败
  //（用户以为全跑了）。
  if (skillIds.length > BATCH_MAX_ITEMS) {
    return {
      ok: false,
      message: `单批最多 ${BATCH_MAX_ITEMS} 个用例，本次给了 ${skillIds.length} 个。请如实说明上限，并请用户按标签 / 关键词 / 状态缩小范围——不要自行截断。`,
    }
  }

  const storage: ISkillStorageOptions = { rootDir: input.rootDir }
  const items: IBatchItem[] = []

  for (const skillId of skillIds) {
    let skillTitle = skillId
    try {
      skillTitle = (await resolveSkill(storage, skillId)).detail.title
    } catch {
      return {
        ok: false,
        message: `工作区内不存在 ID 为 ${skillId} 的用例。请先用 list_skills 确认候选，再重新发起。`,
      }
    }

    // 待确认态的逐条就绪**预判**（R4a）：只读判定，不创建目录。
    // 预判不是放行依据——执行时每次 start() 内部会再走一遍真校验。
    const readiness = await dependencies.readiness.check(input.rootDir, skillId)
    const readyCheck = readiness.ok
      ? { ok: readiness.readiness.ok }
      : { ok: false, reason: readiness.message }

    items.push({
      skillId,
      skillTitle,
      status: 'pending',
      readyCheck: readyCheck.ok
        ? { ok: true }
        : {
            ok: false,
            ...(readyCheck.reason ? { reason: readyCheck.reason } : {}),
          },
    })
  }

  const record: IBatchRecord = {
    batchId: randomUUID(),
    sessionId: input.sessionId,
    skillIds,
    items,
    status: 'awaiting-confirmation',
    startedAt: Date.now(),
    stopRequested: false,
  }
  batches.set(record.batchId, record)
  publishBatch(input.runtime, record)

  const notReady = items.filter((item) => !item.readyCheck?.ok).length
  return {
    ok: true,
    batchId: record.batchId,
    message: `连续执行卡（待确认）已在对话流中给出：共 ${items.length} 个用例${
      notReady > 0 ? `，其中 ${notReady} 个当前不就绪（执行时会被跳过）` : ''
    }。请说明**停止会终止整个批次**（剩余标「未执行」），等用户在卡片上确认后才会开始。`,
  }
}

/**
 * 串行执行循环（R4c）：按顺序跑，逐个更新卡片。
 *
 * 单个条目失败**不中断**批次（R4d）；未就绪的条目跳过并注明原因（R4c）；
 * 批次被停止时当前条目按中断处理、剩余标「未执行」（R4e）。
 *
 * @param dependencies - 服务依赖。
 * @param batches - 批次登记表。
 * @param record - 批次记录（就地更新）。
 * @param runtime - 承载该会话的运行时（卡片落点）。
 * @param rootDir - 工作区根目录。
 * @returns 批次跑完时兑现。
 * @throws 不抛出异常——任何异常都归为条目失败，不冒泡。
 */
async function runBatch(
  dependencies: IBatchExecutionServiceDependencies,
  batches: Map<string, IBatchRecord>,
  record: IBatchRecord,
  runtime: IAgentWorkRuntime,
  rootDir: string,
): Promise<void> {
  try {
    for (const item of record.items) {
      // 被停止：该条与余下全部置 not-executed，跳出（R4e）。
      if (record.stopRequested) {
        item.status = 'not-executed'
        continue
      }

      // 就绪**真校验**：start() 内部会走一遍 J1–J8；这里先做一次预判是为了
      // 「不通过就别启动」——跳过并注明原因，不阻断其余（R4c）。
      const readiness = await dependencies.readiness.check(
        rootDir,
        item.skillId,
      )
      if (readiness.ok && !readiness.readiness.ok) {
        item.status = 'skipped'
        item.skippedReason =
          readiness.readiness.checks
            .filter((check) => !check.ok)
            .map((check) => check.label)
            .join('、') || '就绪校验未通过'
        publishBatch(runtime, record)
        continue
      }

      item.status = 'running'
      record.currentSkillId = item.skillId
      publishBatch(runtime, record)

      const outcome = await runSingleItem(dependencies, record, rootDir, item)
      item.status = outcome
      record.currentSkillId = undefined
      record.currentExecutionId = undefined
      publishBatch(runtime, record)
    }

    // 批次终态：被停止 → interrupted；否则 completed（含跳过，R4f）。
    record.status = record.stopRequested ? 'interrupted' : 'completed'
    publishBatch(runtime, record)

    // 汇总交给 Agent 解读（与单次执行同构的服务注入消息）。
    injectBatchSummary(runtime, record)
  } catch {
    // 循环本身异常：按中断处理（不假装完成，C5）。
    record.status = 'interrupted'
    publishBatch(runtime, record)
  } finally {
    // 登记保留一小段时间供重复点击的幂等判定；这里不主动清理
    //（批次数量有限，服务重启即清空）。
    void batches
  }
}

/**
 * 执行单个条目并等待其终态（R4c）。
 *
 * @param dependencies - 服务依赖。
 * @param record - 批次记录（写入 currentExecutionId）。
 * @param rootDir - 工作区根目录。
 * @param item - 当前条目（就地更新 executionId / runId / summary / skippedReason）。
 * @returns 该条目的终态（skipped 表示真校验没过而跳过）。
 * @throws 不抛出异常——启动失败归为 failed，真校验未过归为 skipped。
 */
async function runSingleItem(
  dependencies: IBatchExecutionServiceDependencies,
  record: IBatchRecord,
  rootDir: string,
  item: IBatchItem,
): Promise<'passed' | 'failed' | 'interrupted' | 'skipped'> {
  let started
  try {
    started = await dependencies.testExecutionService.start({
      rootDir,
      skillId: item.skillId,
    })
  } catch {
    // 启动异常（互斥被抢占等）：按失败处理，不中断批次（R4d）。
    return 'failed'
  }

  if (!started.ok) {
    // 真校验没过（与预判不同步的情形）：按跳过处理——不阻断其余（R4c）。
    item.skippedReason = started.issues.map((issue) => issue.message).join('；')
    return 'skipped'
  }

  const executionId = started.executionId
  record.currentExecutionId = executionId
  item.executionId = executionId

  return waitForExecutionTerminal(dependencies, executionId, item)
}

/**
 * 等待一次执行的终态（订阅执行总线直至 summary 或终态 status）。
 *
 * @param dependencies - 服务依赖。
 * @param executionId - 执行 ID。
 * @param item - 当前条目（写入 runId / summary）。
 * @returns 条目的终态（passed / failed / interrupted）。
 * @throws 不抛出异常。
 */
async function waitForExecutionTerminal(
  dependencies: IBatchExecutionServiceDependencies,
  executionId: string,
  item: IBatchItem,
): Promise<'passed' | 'failed' | 'interrupted'> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    let settled = false

    const finish = (status: 'passed' | 'failed' | 'interrupted'): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      resolve(status)
    }

    unsubscribe = dependencies.executionEventBus.subscribe(
      executionId,
      undefined,
      (event) => {
        if (event.type === 'summary') {
          item.runId = event.summary.runId
          item.summary = {
            total: event.summary.total,
            passed: event.summary.passed,
            failed: event.summary.failed,
            interrupted: event.summary.interrupted,
            skipped: event.summary.skipped,
            durationMs: event.summary.durationMs,
          }
          if (event.summary.status === 'interrupted') {
            finish('interrupted')
          } else {
            // `IExecutionSummary.failed` 已含超时（execution-service 的统计口径），
            // 因此只判它即可——再加一次 timedOut 会把它算两遍。
            finish(event.summary.failed > 0 ? 'failed' : 'passed')
          }
          return
        }

        // 无摘要的终态（浏览器/环境未能启动）：按终态直接判定。
        if (
          event.type === 'status' &&
          (event.status === 'failed' || event.status === 'interrupted')
        ) {
          finish(event.status === 'interrupted' ? 'interrupted' : 'failed')
        }
      },
    )
  })
}

/**
 * 批次终态的汇总消息（注入给 Agent，与单次执行的解读轮次同构）。
 *
 * @param runtime - 承载该会话的运行时。
 * @param record - 批次记录。
 * @returns 无返回值。
 * @throws 不抛出异常（失败不影响卡片终态）。
 */
function injectBatchSummary(
  runtime: IAgentWorkRuntime,
  record: IBatchRecord,
): void {
  try {
    const counts = {
      passed: record.items.filter((item) => item.status === 'passed').length,
      failed: record.items.filter((item) => item.status === 'failed').length,
      skipped: record.items.filter((item) => item.status === 'skipped').length,
      interrupted: record.items.filter((item) => item.status === 'interrupted')
        .length,
      notExecuted: record.items.filter((item) => item.status === 'not-executed')
        .length,
    }

    const lines = [
      '【平台通知】连续执行已结束。',
      `汇总：通过 ${counts.passed}、失败 ${counts.failed}、跳过 ${counts.skipped}${
        counts.interrupted > 0 ? `、中断 ${counts.interrupted}` : ''
      }${counts.notExecuted > 0 ? `、未执行 ${counts.notExecuted}` : ''}。`,
      '逐条结果与报告入口已由对话流中的连续执行卡承载，**不要再用表格复述**。',
      '请只给出：一句话结论；有失败时逐条说明失败的用例与可能的修复方向。',
      counts.failed > 0
        ? '存在失败：可以用 propose_action 给出「修复脚本」入口（带上对应运行的编号），不要自行修改脚本。'
        : '',
    ]

    runtime.sendMessage({
      sessionId: record.sessionId,
      message: lines.filter((line) => line.length > 0).join('\n'),
    })
  } catch {
    // 汇总失败不影响卡片终态。
  }
}

/**
 * 发布 / 更新批次卡片（同一 blockId 原位更新）。
 *
 * @param runtime - 承载该会话的运行时。
 * @param record - 批次记录。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function publishBatch(runtime: IAgentWorkRuntime, record: IBatchRecord): void {
  runtime.publishTaskCard({
    sessionId: record.sessionId,
    taskId: record.batchId,
    taskKind: 'batch',
    // batch 卡是跨用例的：用首条条目的用例作展示目标（卡片正文列全部条目）。
    skillId: record.items[0]?.skillId ?? '',
    skillTitle: record.items[0]?.skillTitle ?? '连续执行',
    status:
      record.status === 'running'
        ? 'running'
        : record.status === 'completed'
          ? 'completed'
          : record.status === 'interrupted'
            ? 'interrupted'
            : // awaiting-confirmation / cancelled 在卡片上表现为「未开始」
              //（running 是过程态；用 completed 会让用户误以为跑完了）。
              'interrupted',
    startedAt: record.startedAt,
    batchStatus: record.status,
    items: record.items,
    batchLimit: BATCH_MAX_ITEMS,
  })
}

/**
 * 取出一批属于该会话的批次（不存在或归属不符时抛 404）。
 *
 * @param batches - 批次登记表。
 * @param sessionId - 会话 ID。
 * @param batchId - 批次 ID。
 * @returns 批次记录。
 * @throws ApiError（INVALID_REQUEST / 404）批次不存在或归属不符。
 */
function requireBatch(
  batches: Map<string, IBatchRecord>,
  sessionId: string,
  batchId: string,
): IBatchRecord {
  const record = batches.get(batchId)
  if (!record || record.sessionId !== sessionId) {
    throw new ApiError({
      code: 'INVALID_REQUEST',
      status: 404,
      message: '该批次不存在或已失效。',
    })
  }
  return record
}

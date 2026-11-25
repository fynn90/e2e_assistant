/**
 * 执行编排服务（v11，技术方案 §5.1）。
 *
 * 单一职责：编排一次执行任务的完整生命周期——
 *   start(skillId) → 就绪校验（J1–J8）→ 租约（J6 互斥）→ 组装 env（唯一接触值的位置）
 *   → 调用 engine testRunner.run（子进程执行）→ 渲染报告 → 写盘 → 发事件。
 *
 * 状态机：prechecking → running → completed | failed | interrupted；
 * 就绪失败不进入状态机、不产生执行记录（PRD P1 / 5.2）。
 *
 * 安全落点（结构性隔离，技术方案 §5.3）：
 *   env.json 的值只在 readEnvValues → request.env 一条路径上流动，
 *   事件、快照、汇总、报告元数据的类型中均没有 value 字段；
 *   引擎出口的日志行统一经过「把 env 值列为秘密」的脱敏器（A5）。
 *
 * 服务重启即丢运行状态（内存表），属 PRD 已知边界，不做补偿。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  IChromiumInstaller,
  IPlaywrightJsonReport,
  ITestRunResult,
  ITestRunner,
  TEngineRunEvent,
} from '@charlie_deng/e2e-assistant-playwright-engine'
import {
  DefaultSensitiveDataRedactor,
  parseTestReportData,
  renderTestReportHtml,
} from '@charlie_deng/e2e-assistant-playwright-engine'
import {
  FileE2ETestCaseRepository,
  ensureUserWorkSpace,
  readSkillFile,
  resolveSkill,
  SKILL_ENV_FILE_NAME,
  USER_WORKSPACE_DIRECTORY_NAME,
  writeTestReport,
  writeTestReportAttachment,
  writeTestReportSummary,
} from '@charlie_deng/e2e-assistant-skill-manager'
import {
  parseEnvFileContent,
  type IExecutionPrecheckIssue,
  type IExecutionRunSummary,
  type IExecutionSnapshot,
  type IExecutionSummary,
  type TExecutionEvent,
  type TExecutionStatus,
} from '@charlie_deng/e2e-assistant-types'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import type { ISkillStorageOptions } from '@charlie_deng/e2e-assistant-skill-manager'
import {
  checkBaseUrlConfigured,
  checkEnvReferencesForExecution,
  checkExecutionMutex,
  checkScriptHasTests,
  checkTestReportDirectoryWritable,
  type TExecutionEnvFileState,
} from './execution-precheck'
import {
  createExecutionEventBus,
  type IExecutionEventBus,
} from './execution-event-bus'

/** 单条测试默认超时（PRD X11，评审点②）。 */
export const EXECUTION_TEST_TIMEOUT_MS = 120_000
/** 整次执行默认总时长上限（PRD X11）。 */
export const EXECUTION_OVERALL_TIMEOUT_MS = 600_000

/** 每个 Skill 保留的最近执行记录数（供快照恢复；服务重启即清零）。 */
const MAX_EXECUTION_HISTORY_PER_SKILL = 5

/** `abortAllAndWait` 等待在跑任务收敛的默认上限（v19 §4.2 第 1 步）。 */
export const DEFAULT_ABORT_WAIT_MS = 5000

/** 运行记录：一次执行任务在内存中的全部状态。 */
interface IExecutionTaskRecord {
  executionId: string
  skillId: string
  skillTitle: string
  skillRoot: string
  runId: string
  /** 执行开始时间（ISO）。 */
  startedAt: string
  status: TExecutionStatus
  /** 中止控制器：stop() 的落点。 */
  abortController: AbortController
  /** 运行中持有的互斥租约。 */
  lease: { release (): void }
  /** 结果汇总（结束后填充）。 */
  summary?: IExecutionSummary
  /** 本次执行读取到的目标 URL（v17：写进摘要供历史卡展示，值的形态与 SEC-4 同源）。 */
  baseUrl?: string
}

/** 执行服务的可替换依赖（组合根注入）。 */
export interface IExecutionServiceDependencies {
  /** 生成任务注册表（与生成任务共用同一实例，D7 互斥）。 */
  taskRegistry: IGenerationTaskRegistry
  /** Chromium 检测与安装（J7）。 */
  chromium: IChromiumInstaller
  /** 测试执行器（engine）。 */
  testRunner: ITestRunner
  /** 事件总线；缺省内部创建（测试可注入）。 */
  eventBus?: IExecutionEventBus
}

/** 执行服务接口。 */
export interface ITestExecutionService {
  /**
   * 发起一次执行（按钮与 Chat 共用链路）。
   *
   * @param options - 存储根目录与 Skill ID。
   * @returns 就绪失败时返回问题列表（HTTP 422）；发起成功返回执行 ID。
   * @throws ApiError（CHAT_CONCURRENCY_LIMITED）当校验通过后租约被并发抢占时抛出。
   */
  start (options: {
    rootDir: string
    skillId: string
  }): Promise<
    | { ok: true; executionId: string }
    | { ok: false; issues: IExecutionPrecheckIssue[] }
  >
  /**
   * 停止执行（PRD X10）。
   *
   * @param options - Skill ID（以 Skill 定位当前执行；入口只在当前 Skill 页）。
   * @returns 是否找到并请求了停止。
   */
  stop (options: { skillId: string }): boolean
  /**
   * 查询执行快照（X16 恢复）。
   *
   * @param executionId - 执行 ID。
   * @returns 快照；不存在（服务重启/被清理）时为 undefined。
   */
  snapshot (executionId: string): IExecutionSnapshot | undefined
  /**
   * 查询指定 Skill 的最近一次执行（进入页面时的恢复入口）。
   *
   * @param skillId - Skill ID。
   * @returns 快照；无记录时为 undefined。
   */
  current (skillId: string): IExecutionSnapshot | undefined
  /**
   * 中止全部在跑的执行任务并等待其收敛（服务关闭序列的第一步，v19 §4.2）。
   *
   * 等待是必要的：`driveExecution` 需要时间按 v11 的「已中断」语义尽力生成报告。
   * 超时（`waitMs`）后不阻塞关闭——关闭不能被一个卡住的任务无限拖住。
   *
   * @param options - `waitMs`：等待收敛的上限，缺省 5000 毫秒。
   * @returns 全部在跑任务已收敛或等待超时后兑现。
   * @throws 不抛出异常——单个任务收敛失败不影响其余，也不阻断关闭。
   */
  abortAllAndWait (options?: { waitMs?: number }): Promise<void>
}

/** 创建执行编排服务。 */
export function createTestExecutionService (
  dependencies: IExecutionServiceDependencies,
): ITestExecutionService {
  const bus = dependencies.eventBus ?? createExecutionEventBus()
  /** Skill ID → 最近执行记录（含历史，最新在尾部）。 */
  const historyBySkill = new Map<string, IExecutionTaskRecord[]>()
  /** 执行 ID → 记录（含历史）。 */
  const recordsById = new Map<string, IExecutionTaskRecord>()
  /**
   * 在跑的驱动承诺集合；关闭序列需要等它们收敛（v19 §4.2）。
   *
   * 只登记、不改变控制流——`driveExecution` 的失败仍由它自身的终态处理吸收。
   */
  const runningDrivers = new Set<Promise<void>>()

  return {
    async start (options) {
      const storageOptions: ISkillStorageOptions = { rootDir: options.rootDir }

      // —— Skill 解析（目录与 manifest 的合法性由 skill-manager 统一把关） ——
      const resolvedSkill = await resolveSkill(storageOptions, options.skillId)
      const skillRoot = resolvedSkill.skillRoot

      // —— 就绪校验：逐项收集，一次性列出全部问题（PRD 5.1） ——
      const issues: IExecutionPrecheckIssue[] = []
      /** 校验通过后用于注入的 env 值（唯一接触值的位置）。 */
      let envValues: Record<string, string> | undefined

      // J6：互斥查询（acquire 在校验全部通过后再做，避免竞态窗口内重复报错）。
      issues.push(
        ...checkExecutionMutex(
          dependencies.taskRegistry.currentSessionId(options.skillId),
        ),
      )

      // J1 + 读取脚本内容（J2/J4 的输入）。
      let specContent: string | undefined
      try {
        const specFile = await readSkillFile(
          storageOptions,
          options.skillId,
          'test.spec.ts',
        )
        specContent = specFile.content
      } catch {
        issues.push({
          code: 'EXECUTION_SPEC_MISSING',
          message: 'test.spec.ts 不存在，无法执行。',
        })
      }

      if (specContent !== undefined) {
        // J2：至少一条测试。
        issues.push(...checkScriptHasTests(specContent))

        // J4：env.json 引用校验（读取值并在通过后用于注入——唯一接触值的位置）。
        const envFile = await readEnvValues(storageOptions, options.skillId)
        issues.push(...checkEnvReferencesForExecution(specContent, envFile))
        if (envFile.status === 'ok') {
          envValues = envFile.values
        }
      }

      // J5：目标 URL（用例是唯一业务数据源；同时取步骤描述供 X8 步骤名映射）。
      let baseUrl: string | undefined
      let stepTitles: Record<string, string> | undefined
      try {
        const testCaseDocument = await new FileE2ETestCaseRepository(
          storageOptions,
        ).findBySkillId(options.skillId)
        baseUrl = testCaseDocument.testCase.baseUrl
        stepTitles = Object.fromEntries(
          testCaseDocument.testCase.steps.map((step) => [
            step.id,
            step.description,
          ]),
        )
      } catch {
        issues.push(...checkBaseUrlConfigured(undefined))
      }
      issues.push(...checkBaseUrlConfigured(baseUrl))

      // J8：报告目录可建（校验阶段创建目录本身即覆盖「可建/可写」语义）。
      issues.push(...(await checkTestReportDirectoryWritable(skillRoot)))

      // v14（W11）：userWorkSpace precheck——不可用（被占用/创建失败/不可写）时
      // 执行任务明确失败。strict 模式的 SkillManagerError 转为就绪问题返回。
      try {
        await ensureUserWorkSpace(storageOptions, options.skillId, 'strict')
      } catch (error) {
        return {
          ok: false,
          issues: [
            {
              code: 'EXECUTION_PRECHECK_FAILED',
              message:
                error instanceof Error
                  ? `当前 Skill 的 userWorkSpace 不可用，无法执行：${error.message}`
                  : '当前 Skill 的 userWorkSpace 不可用，无法执行。',
            },
          ],
        }
      }

      if (issues.length > 0) {
        return { ok: false, issues }
      }

      // J7：Chromium 可用（缺失自动安装，失败阻断）。安装可能耗时，放在其余校验之后；
      // 此时尚无执行记录，安装过程日志不进入任何事件流。
      const chromiumReady = await ensureChromium(
        dependencies.chromium,
        () => undefined,
      )
      if (!chromiumReady.ok) {
        return {
          ok: false,
          issues: [
            {
              code: 'EXECUTION_CHROMIUM_UNAVAILABLE',
              message:
                chromiumReady.message ??
                '本机缺少 Playwright Chromium 且自动安装失败，可手动执行 npx playwright install chromium 后重试。',
            },
          ],
        }
      }

      // —— 校验全部通过：占用互斥租约（与生成任务同源，D7）。 ——
      const executionId = randomUUID()
      const lease = dependencies.taskRegistry.acquire(
        options.skillId,
        executionId,
      )

      // —— 建立执行记录并进入状态机。 ——
      const record: IExecutionTaskRecord = {
        executionId,
        skillId: options.skillId,
        skillTitle: resolvedSkill.detail.title,
        skillRoot,
        runId: formatRunId(new Date()),
        startedAt: new Date().toISOString(),
        status: 'prechecking',
        abortController: new AbortController(),
        lease,
      }
      recordsById.set(executionId, record)
      appendHistory(
        historyBySkill,
        recordsById,
        bus,
        options.skillId,
        record,
        MAX_EXECUTION_HISTORY_PER_SKILL,
      )

      bus.publish(executionId, { type: 'status', status: 'prechecking' })

      // —— 补发前置阶段事件：就绪校验发生在 executionId 创建之前，
      //    按真实发生顺序补发，让「执行过程」清单完整可回放（v11 阶段事件）。 ——
      bus.publish(executionId, {
        type: 'stage',
        stage: 'precheck',
        status: 'done',
        label:
          '就绪校验通过（脚本 / env.json / 目标 URL / 互斥 / Chromium / 报告目录）',
      })
      bus.publish(executionId, {
        type: 'log',
        line: '就绪校验通过，开始组装执行环境。',
      })
      if (envValues) {
        // 只播报 key 数量，值永不进入事件流（A3/A5）。
        bus.publish(executionId, {
          type: 'stage',
          stage: 'env',
          status: 'done',
          label: `env.json 注入完成（${Object.keys(envValues).length} 个环境变量）`,
        })
        bus.publish(executionId, {
          type: 'log',
          line: `env.json 注入完成（${Object.keys(envValues).length} 个环境变量）。`,
        })
      }
      bus.publish(executionId, {
        type: 'stage',
        stage: 'chromium',
        status: 'done',
        label: 'Chromium 就绪（有头模式）',
      })
      bus.publish(executionId, {
        type: 'stage',
        stage: 'launch',
        status: 'start',
        label: '启动有头 Chromium 窗口',
      })
      bus.publish(executionId, {
        type: 'log',
        line: '启动有头 Chromium 窗口执行 test.spec.ts。',
      })

      record.status = 'running'
      bus.publish(executionId, { type: 'status', status: 'running' })

      // —— 异步驱动执行主流程；start 立即返回（非阻塞，D9）。 ——
      const driver = driveExecution({
        record,
        testRunner: dependencies.testRunner,
        bus,
        baseUrl: baseUrl ?? '',
        envValues: envValues ?? {},
        stepTitles,
      }).finally(() => {
        record.lease.release()
        runningDrivers.delete(driver)
      })
      runningDrivers.add(driver)

      return { ok: true, executionId, skillTitle: resolvedSkill.detail.title }
    },

    stop ({ skillId }) {
      const latest = latestRecord(historyBySkill.get(skillId))
      if (!latest || isTerminal(latest.status)) {
        return false
      }

      latest.abortController.abort()
      return true
    },

    snapshot (executionId) {
      const record = recordsById.get(executionId)
      if (!record) return undefined
      return buildSnapshot(record, bus)
    },

    current (skillId) {
      const latest = latestRecord(historyBySkill.get(skillId))
      if (!latest) return undefined
      return buildSnapshot(latest, bus)
    },

    async abortAllAndWait (options) {
      const waitMs = options?.waitMs ?? DEFAULT_ABORT_WAIT_MS

      // 只中止非终态记录：终态任务的 lease 已释放，再 abort 没有意义。
      for (const record of recordsById.values()) {
        if (!isTerminal(record.status)) {
          record.abortController.abort()
        }
      }

      if (runningDrivers.size === 0) {
        return
      }

      // 等待收敛，但不超过 waitMs——关闭不能被一个卡住的任务无限拖住。
      // 全部兑现后驱动承诺会自行从集合移除，因此此处只做等待。
      const convergence = Promise.allSettled([...runningDrivers]).then(
        () => undefined,
      )
      await Promise.race([convergence, delay(waitMs)])
    },
  }
}

/** 可清理的延时：超时未用到时清掉定时器，避免它把进程或测试多留 waitMs。 */
function delay (durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs)
    timer.unref?.()
  })
}

// ---------------------------------------------------------------------------
// 执行主流程。
// ---------------------------------------------------------------------------

/** 执行主流程的输入。 */
interface IDriveExecutionOptions {
  record: IExecutionTaskRecord
  testRunner: ITestRunner
  bus: IExecutionEventBus
  baseUrl: string
  /** 已通过 J4 校验的 env 值（唯一进入子进程的路径）。 */
  envValues: Record<string, string>
  /** 用例步骤 id → 描述（X8 步骤名映射）。 */
  stepTitles?: Record<string, string>
}

/**
 * 驱动一次执行的运行、报告生成与终态广播。
 *
 * 引擎事件直接映射为执行事件；结束后按 P1 语义尽力生成报告
 * （启动失败的运行不生成报告），终态发布 summary 事件。
 *
 * @param options - 记录、执行器、总线与注入数据。
 * @returns 执行收尾完成后兑现。
 * @throws 不抛出异常——所有失败都转换为 failed/interrupted 终态。
 */
async function driveExecution (options: IDriveExecutionOptions): Promise<void> {
  const { record, testRunner, bus, baseUrl, envValues, stepTitles } = options
  const { executionId } = record

  /** 平台事件 + 引擎事件 → 执行事件流。 */
  const onEngineEvent = (event: TEngineRunEvent): void => {
    switch (event.type) {
      case 'log':
        bus.publish(executionId, { type: 'log', line: event.line })
        return
      case 'test-start':
        bus.publish(executionId, { type: 'test-start', title: event.title })
        return
      case 'test-end':
        bus.publish(executionId, {
          type: 'test-end',
          result: {
            title: event.title,
            status: event.status,
            durationMs: event.durationMs,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          },
        })
        return
      case 'step-start':
        bus.publish(executionId, {
          type: 'step-start',
          testTitle: event.testTitle,
          stepId: event.stepId,
        })
        return
      case 'step-end':
        bus.publish(executionId, {
          type: 'step-end',
          stepId: event.stepId,
          ok: event.ok,
        })
        return
    }
  }

  let runResult: ITestRunResult | undefined

  try {
    // v14（B11/W38）：视觉快照根与 userWorkSpace 注入——snapshotRoot 写入
    // snapshotPathTemplate（脚本 toMatchSnapshot 分段在其下解析），
    // userWorkspacePath 经 runner 注入子进程环境变量 SKILL_USER_WORKSPACE。
    const userWorkspacePath = path.join(
      record.skillRoot,
      USER_WORKSPACE_DIRECTORY_NAME,
    )
    const result = await testRunner.run({
      runId: record.runId,
      skillRoot: record.skillRoot,
      specRelativePath: 'test.spec.ts',
      baseUrl,
      snapshotRoot: userWorkspacePath,
      userWorkspacePath,
      env: envValues,
      timeouts: {
        testMs: EXECUTION_TEST_TIMEOUT_MS,
        overallMs: EXECUTION_OVERALL_TIMEOUT_MS,
      },
      signal: record.abortController.signal,
      onEvent: onEngineEvent,
    })
    runResult = result

    const reportData = parseTestReportData(result.jsonReport)

    // 阶段事件：浏览器会话结束 + 测试执行结果（v11 执行过程清单）。
    bus.publish(executionId, {
      type: 'stage',
      stage: 'launch',
      status: 'done',
      label: '有头浏览器会话结束',
    })
    bus.publish(executionId, {
      type: 'stage',
      stage: 'run',
      status: result.status === 'interrupted' ? 'fail' : 'done',
      label:
        result.status === 'interrupted'
          ? '测试执行被中断'
          : `测试执行完成（通过 ${reportData.stats.passed}，失败 ${reportData.stats.failed + reportData.stats.timedOut}，跳过 ${reportData.stats.skipped}）`,
    })

    // P1：浏览器启动失败（零测试 + 非 0 退出 + 无中断）→ 环境错误，不生成报告。
    const ranAnyTest = reportData.stats.total > 0
    const environmentFailure =
      result.status === 'failed' &&
      !ranAnyTest &&
      !record.abortController.signal.aborted

    if (environmentFailure) {
      bus.publish(executionId, {
        type: 'stage',
        stage: 'launch',
        status: 'fail',
        label: '浏览器或运行环境未能启动',
      })
      finalize(record, bus, {
        status: 'failed',
        summary: undefined,
        logLine: '执行失败：浏览器或运行环境未能启动，本次不生成报告。',
      })
      return
    }

    // 尽力生成报告（P1：凡启动了浏览器运行的执行，结束必生成报告）。
    const reportRelativePath = await writeReportArtifacts({
      record,
      jsonReport: result.jsonReport,
      reportData,
      baseUrl,
      stepTitles,
      // v17：摘要与报告同一次写入、同一份统计来源；`envValues` 用于脱敏
      // 失败摘要中的敏感值（§8 净化要求：与日志同一条链路）。
      ...(envValues ? { envValues } : {}),
      interrupted: result.status === 'interrupted',
      onFilesChanged: (relativePaths) =>
        bus.publish(executionId, { type: 'files-changed', relativePaths }),
      onLog: (line) => bus.publish(executionId, { type: 'log', line }),
    })

    const summaryStatus: IExecutionSummary['status'] =
      result.status === 'interrupted' ? 'interrupted' : 'completed'

    // 阶段事件：报告生成结果。
    bus.publish(executionId, {
      type: 'stage',
      stage: 'report',
      status: reportRelativePath ? 'done' : 'fail',
      label: reportRelativePath
        ? `测试报告已生成（test_report/${record.runId}/report.html）`
        : '测试报告写入失败',
    })

    finalize(record, bus, {
      status: summaryStatus,
      summary: {
        executionId,
        runId: record.runId,
        status: summaryStatus,
        startedAt: record.startedAt,
        durationMs: result.durationMs,
        total: reportData.stats.total,
        passed: reportData.stats.passed,
        failed: reportData.stats.failed + reportData.stats.timedOut,
        interrupted: reportData.stats.interrupted,
        skipped: reportData.stats.skipped,
        results: reportData.entries.map((entry) => entry.result),
        ...(reportRelativePath ? { reportRelativePath } : {}),
        // 目标 URL 已通过 J5 校验，此处带出供摘要展示（PRD v16 RPT-2）。
        ...(baseUrl ? { baseUrl } : {}),
      },
      logLine:
        summaryStatus === 'interrupted'
          ? '执行已中断。'
          : `执行完成：通过 ${reportData.stats.passed} 条，失败 ${reportData.stats.failed + reportData.stats.timedOut} 条。`,
    })
  } catch (error) {
    finalize(record, bus, {
      status: record.abortController.signal.aborted ? 'interrupted' : 'failed',
      summary: undefined,
      logLine: `执行异常终止：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    // 工作区在报告与附件消费完成后由引擎句柄清理（带占用重试，P10：Skill 目录零残留）。
    await runResult?.workspace.cleanup()
  }
}

/** 终态广播：状态事件 + 日志 + summary 事件。 */
function finalize (
  record: IExecutionTaskRecord,
  bus: IExecutionEventBus,
  outcome: {
    status: TExecutionStatus
    summary?: IExecutionSummary
    logLine: string
  },
): void {
  record.status = outcome.status
  bus.publish(record.executionId, { type: 'status', status: outcome.status })
  bus.publish(record.executionId, { type: 'log', line: outcome.logLine })

  if (outcome.summary) {
    record.summary = outcome.summary
    bus.publish(record.executionId, {
      type: 'summary',
      summary: outcome.summary,
    })
  }
}

/** 写入报告 HTML 与失败截图附件，返回报告相对路径（失败时返回 undefined，不掩盖执行结果）。 */
async function writeReportArtifacts (options: {
  record: IExecutionTaskRecord
  jsonReport: IPlaywrightJsonReport
  reportData: ReturnType<typeof parseTestReportData>
  baseUrl: string
  stepTitles?: Record<string, string>
  /** 本次执行注入的 env 值（v17：摘要脱敏用；不写入任何产物）。 */
  envValues?: Record<string, string>
  /** 本次运行是否被用户中断（v17：摘要的 outcome 判定用）。 */
  interrupted?: boolean
  onFilesChanged: (relativePaths: string[]) => void
  onLog: (line: string) => void
}): Promise<string | undefined> {
  const {
    record,
    jsonReport,
    reportData,
    baseUrl,
    stepTitles,
    envValues,
    interrupted,
    onFilesChanged,
    onLog,
  } = options

  try {
    const html = await renderTestReportHtml(jsonReport, {
      skillTitle: record.skillTitle,
      skillId: record.skillId,
      runId: record.runId,
      startedAt: record.startedAt,
      baseUrl,
      headed: true,
      ...(stepTitles ? { stepTitles } : {}),
    })

    const reportRelativePath = await writeTestReport(
      record.skillRoot,
      record.runId,
      html,
    )

    // 失败截图同时作为附件文件留存（PRD AC-11：附件在文件树可见，V5 点击提示）。
    const changedPaths = [reportRelativePath]
    for (const file of await collectAttachmentFiles(jsonReport)) {
      try {
        const attachmentRelativePath = await writeTestReportAttachment(
          record.skillRoot,
          record.runId,
          file.fileName,
          file.content,
        )
        changedPaths.push(attachmentRelativePath)
      } catch {
        onLog(`附件 ${file.fileName} 写入失败，已在报告中内嵌展示。`)
      }
    }

    // v17：摘要紧随报告写入（§4.4）。失败**不阻断**执行结果——与 HTML 写入
    // 失败的既有处置一致（记日志、报告缺失但结果仍可见）；此时该次执行不进
    // 历史卡，属可接受降级。
    await writeRunSummary({
      record,
      reportData,
      baseUrl,
      ...(envValues ? { envValues } : {}),
      interrupted: interrupted === true,
      onLog,
    })

    onFilesChanged(changedPaths)
    onLog(`测试报告已写入 test_report/${record.runId}/。`)
    return reportRelativePath
  } catch (error) {
    // 磁盘写入报告失败（权限、空间）：全局通知失败原因，日志与结果仍可见（PRD 第 11 章）。
    onLog(
      `测试报告写入失败：${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/**
 * 写入本次执行的机器可读摘要（v17 §4.4）。
 *
 * 统计与 `reportData.stats` **同源**——历史卡与报告卡片显示的数字因此必然一致。
 * `failures[].errorMessage` 必须经脱敏（§8）：错误文本来自 Playwright，可能与
 * 页面文本或 env 值相关，直接落盘会把敏感值带进一个新文件。
 *
 * @param options - 记录、报告数据、目标 URL、env 值、中断标志与日志出口。
 * @returns 写入完成时兑现；失败时记日志并返回（不抛出）。
 * @throws 不抛出异常。
 */
async function writeRunSummary (options: {
  record: IExecutionTaskRecord
  reportData: ReturnType<typeof parseTestReportData>
  baseUrl: string
  envValues?: Record<string, string>
  interrupted?: boolean
  onLog: (line: string) => void
}): Promise<void> {
  const { record, reportData, baseUrl, envValues, interrupted, onLog } = options

  const redactor = new DefaultSensitiveDataRedactor({
    secrets: Object.values(envValues ?? {}),
    maxLength: 2_000,
  })

  // 中断标志由调用方传入而非读 `record.status`：本函数在 `finalize` **之前**
  // 执行，此刻记录仍是 running——读它会把每次执行都判成 interrupted。
  const outcome: IExecutionRunSummary['outcome'] =
    interrupted === true
      ? 'interrupted'
      : reportData.stats.failed > 0 ||
        reportData.stats.timedOut > 0 ||
        reportData.stats.interrupted > 0
        ? 'failed'
        : 'passed'

  // 失败定位（Q8）：只收失败 / 超时条目，最多 20 条——摘要是给 Agent 解读用的，
  // 不是报告的替代品，超量时报告里仍能看全。
  const failures = reportData.entries
    .filter(
      (entry) =>
        entry.result.status === 'failed' ||
        entry.result.status === 'timedOut' ||
        entry.result.status === 'interrupted',
    )
    .slice(0, 20)
    .map((entry) => ({
      title: entry.result.title,
      ...(entry.result.failedStepId
        ? { stepId: entry.result.failedStepId }
        : {}),
      ...(entry.result.errorMessage
        ? { errorMessage: redactor.redact(entry.result.errorMessage) }
        : {}),
      hasScreenshot: entry.screenshots.length > 0,
    }))

  const summary: IExecutionRunSummary = {
    schemaVersion: 1,
    skillId: record.skillId,
    skillTitle: record.skillTitle,
    runId: record.runId,
    startedAt: record.startedAt,
    baseUrl,
    stats: {
      total: reportData.stats.total,
      passed: reportData.stats.passed,
      failed: reportData.stats.failed,
      timedOut: reportData.stats.timedOut,
      interrupted: reportData.stats.interrupted,
      skipped: reportData.stats.skipped,
      durationMs: reportData.stats.durationMs,
    },
    outcome,
    ...(failures.length > 0 ? { failures } : {}),
    reportFile: true,
  }

  try {
    await writeTestReportSummary(record.skillRoot, record.runId, summary)
  } catch (error) {
    onLog(
      `测试报告摘要写入失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * 从 JSON 报告收集 PNG 失败截图：读取运行工作区内的附件文件，供落盘留存。
 *
 * @param jsonReport - 已解析的 JSON 报告。
 * @returns 附件文件名（已消重）与二进制内容；读取失败的附件跳过。
 * @throws 不抛出异常。
 */
async function collectAttachmentFiles (
  jsonReport: IPlaywrightJsonReport,
): Promise<Array<{ fileName: string; content: Buffer }>> {
  const pendingReads: Array<{ path: string; index: number }> = []
  let sequence = 0

  /** 深度优先登记全部 PNG 附件的工作区路径。 */
  const walkSuites = (suites: IPlaywrightJsonReport['suites']): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const testCase of spec.tests ?? []) {
          for (const result of testCase.results ?? []) {
            for (const attachment of result.attachments ?? []) {
              if (attachment.contentType !== 'image/png' || !attachment.path) {
                continue
              }
              sequence += 1
              pendingReads.push({ path: attachment.path, index: sequence })
            }
          }
        }
      }
      walkSuites(suite.suites)
    }
  }

  walkSuites(jsonReport.suites)

  const files: Array<{ fileName: string; content: Buffer }> = []
  for (const pending of pendingReads) {
    try {
      const content = await readFile(pending.path)
      files.push({ fileName: `attachment-${pending.index}.png`, content })
    } catch {
      // 附件已被清理或不可读：跳过，不影响报告主文件（报告中仍有内嵌版本）。
    }
  }

  return files
}

// ---------------------------------------------------------------------------
// 读取与校验辅助。
// ---------------------------------------------------------------------------

/**
 * 读取 env.json 并解析为「key 集合 + 值表」（唯一接触值的位置，§5.3）。
 *
 * @param storageOptions - Skill 存储根目录。
 * @param skillId - Skill ID。
 * @returns env 文件状态；非法/缺失时无值。
 * @throws 不抛出异常——读取失败按缺失处理。
 */
async function readEnvValues (
  storageOptions: ISkillStorageOptions,
  skillId: string,
): Promise<TExecutionEnvFileState> {
  try {
    const file = await readSkillFile(
      storageOptions,
      skillId,
      SKILL_ENV_FILE_NAME,
    )
    const parsed = parseEnvFileContent(file.content)

    if (parsed.issues.length > 0 || parsed.data === null) {
      return { status: 'invalid' }
    }

    return {
      status: 'ok',
      keys: new Set(Object.keys(parsed.data)),
      values: parsed.data,
    }
  } catch {
    return { status: 'missing' }
  }
}

/**
 * J7：确保 Chromium 可用；缺失时自动安装。
 *
 * @param chromium - Chromium 检测与安装器。
 * @param onLog - 安装过程日志回调。
 * @returns 就绪结果；失败时携带用户提示。
 * @throws 不抛出异常——安装失败转换为阻断结果。
 */
async function ensureChromium (
  chromium: IChromiumInstaller,
  onLog: (line: string) => void,
): Promise<{ ok: true } | { ok: false; message?: string }> {
  try {
    const status = await chromium.detect()

    if (status.installed) {
      return { ok: true }
    }

    onLog('本机缺少 Playwright Chromium，开始自动安装（复用平台安装机制）……')
    await chromium.install()
    onLog('Playwright Chromium 安装完成。')
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `本机缺少 Playwright Chromium 且自动安装失败，可手动执行 npx playwright install chromium 后重试。（${error instanceof Error ? error.message : String(error)}）`,
    }
  }
}

/** 构建执行快照（X16：状态 + summary + 环形缓冲事件）。 */
function buildSnapshot (
  record: IExecutionTaskRecord,
  bus: IExecutionEventBus,
): IExecutionSnapshot {
  return {
    executionId: record.executionId,
    skillTitle: record.skillTitle,
    status: record.status,
    currentSeq: bus.currentSeq(record.executionId),
    ...(record.summary ? { summary: record.summary } : {}),
    events: snapshotEvents(bus, record.executionId),
  }
}

/** 读取缓冲内全部事件（subscribe 的无监听变体，避免额外接口）。 */
function snapshotEvents (
  bus: IExecutionEventBus,
  executionId: string,
): TExecutionEvent[] {
  const events: TExecutionEvent[] = []
  bus.subscribe(executionId, undefined, (event) => events.push(event))()
  return events
}

/** 记录历史（按 Skill 封顶淘汰最旧，逐出项同步清回收据与事件通道）。 */
function appendHistory (
  historyBySkill: Map<string, IExecutionTaskRecord[]>,
  recordsById: Map<string, IExecutionTaskRecord>,
  bus: IExecutionEventBus,
  skillId: string,
  record: IExecutionTaskRecord,
  capacity: number,
): void {
  const history = historyBySkill.get(skillId) ?? []
  history.push(record)

  while (history.length > capacity) {
    const evicted = history.shift()
    if (evicted) {
      recordsById.delete(evicted.executionId)
      bus.dispose(evicted.executionId)
    }
  }

  historyBySkill.set(skillId, history)
}

/** 取最新记录。 */
function latestRecord (
  history: IExecutionTaskRecord[] | undefined,
): IExecutionTaskRecord | undefined {
  return history?.[history.length - 1]
}

/** 判断状态是否为终态。 */
function isTerminal (status: TExecutionStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'interrupted'
  )
}

/** 本地时间戳 yyyyMMdd-HHmmss（PRD P2；同 Skill 串行保证不冲突）。 */
function formatRunId (date: Date): string {
  const pad = (value: number, length = 2): string =>
    String(value).padStart(length, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

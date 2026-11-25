/**
 * 真实测试执行器（v11，技术方案 §3 / PRD 第 6 章）。
 *
 * 职责：以独立子进程运行 Playwright 官方 test CLI（`playwright test`），
 * 执行 Skill 根目录的 `test.spec.ts`（固定有头模式），并在执行过程中向宿主回传：
 *   - 脱敏后的 stdout/stderr 日志行；
 *   - 由自定义 NDJSON reporter 产出的结构化事件（测试开始/结束、步骤开始/结束）；
 *   - 执行结束后的 Playwright JSON 报告解析结果。
 *
 * 隔离边界（PRD P10 / X1）：
 *   - 运行工作区位于 OS 临时目录（`os.tmpdir()/e2e-agent-runs/<runId>/`），
 *     脚本以「复制」方式进入工作区——执行内容即启动前一刻的磁盘快照；
 *   - Skill 目录内不会产生任何文件；工作区的清理由调用方在任务终态显式触发
 *     （附件等产物消费完成后再删除，见 IRunWorkspaceHandle）。
 *
 * 依赖解析（技术方案 D2）：Skill 目录没有 `@playwright/test` 依赖，而 Playwright
 * 的 transform 不重映射该导入，因此在运行工作区内合成一个与官方别名逐字一致的
 * `@playwright/test` 包（其内容仅是 `playwright/test` 的再导出），并把 `playwright`
 * 以 junction 链接到本包依赖树内的真实安装——保证脚本 import 与运行的 CLI 严格同版本。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DefaultSensitiveDataRedactor } from './observability/redaction'
import type { ISensitiveDataRedactor } from './contracts/observability'
import { PlaywrightEngineError } from './contracts/errors'
import {
  buildConfigContent,
  EVENTS_FILE_NAME,
  JSON_REPORT_FILE_NAME,
} from './runner-config-builder'

/** 运行工作区的根目录名（位于 OS 临时目录下，技术方案 D3）。 */
const RUN_WORKSPACE_ROOT_NAME = 'e2e-agent-runs'

/** 事件文件的低频轮询间隔（毫秒，技术方案 D5）。 */
const TAIL_INTERVAL_MS = 100

/** 子进程退出后等待 reporter 刷盘的时间（毫秒）。 */
const FLUSH_GRACE_MS = 500

/** 工作区清理重试节奏：应对 Windows 下浏览器进程释放文件的滞后（与 temp-workspace 同节奏）。 */
const CLEANUP_RETRY_DELAYS_MS = [50, 150, 400, 1000] as const

/** 单条测试结果状态（引擎视角，与 Playwright 结果状态对齐）。 */
export type TEngineTestStatus =
  'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped'

/** 执行过程中回传给宿主的事件（日志行已脱敏）。 */
export type TEngineRunEvent =
  | { type: 'log'; line: string }
  | { type: 'test-start'; title: string }
  | {
      type: 'test-end'
      title: string
      status: TEngineTestStatus
      durationMs: number
      errorMessage?: string
    }
  /** stepId 即脚本内 test.step 的第一参数（v7 约定为用例步骤 id）。 */
  | { type: 'step-start'; testTitle: string; stepId: string; stepTitle: string }
  | { type: 'step-end'; stepId: string; ok: boolean }

/** 一次测试执行的请求（技术方案 §3.1）。 */
export interface ITestRunRequest {
  /** 运行 ID（yyyyMMdd-HHmmss）；同时用作运行工作区目录名。 */
  runId: string
  /** Skill 目录绝对路径（只读来源：复制 test.spec.ts）。 */
  skillRoot: string
  /** 待执行脚本的 Skill 内相对路径，恒为 'test.spec.ts'。 */
  specRelativePath: string
  /** 注入为 baseURL 的目标地址（PRD X4）。 */
  baseUrl: string
  /**
   * 视觉快照根目录的绝对路径（v14 B11，更名自 visualBaselineRoot）。
   *
   * 提供时写入 `snapshotPathTemplate`，使 `toMatchSnapshot` 的基线落在该目录
   * （v14 起为 `<skillRoot>/userWorkSpace`，脚本内分段在该根下解析）。
   * 缺省时不写入该字段——脚本会因找不到基线而明确失败，而不是静默写到
   * 工作区默认目录。
   */
  snapshotRoot?: string
  /**
   * userWorkSpace 绝对路径（v14 W38）：提供时注入子进程环境变量 SKILL_USER_WORKSPACE，
   * 供脚本的 Node 文件操作派生产物路径。
   */
  userWorkspacePath?: string
  /** 注入子进程环境变量的键值（调用方读取 env.json 后传入；只经此处进入子进程，A3）。 */
  env: Readonly<Record<string, string>>
  /** 超时：单条测试 / 整次执行（毫秒，PRD X11 默认 120_000 / 600_000）。 */
  timeouts: { testMs: number; overallMs: number }
  /** 中止信号：触发进程树终止，本次运行按中断处理（PRD X10）。 */
  signal?: AbortSignal
  /** 结构化事件与脱敏日志行回调。 */
  onEvent?: (event: TEngineRunEvent) => void
}

/** 运行工作区句柄：调用方在消费完附件等产物后显式清理。 */
export interface IRunWorkspaceHandle {
  /** 工作区绝对路径。 */
  path: string
  /**
   * 删除整个运行工作区（目录不存在时幂等成功）。
   *
   * @returns 清理完成；清理失败不抛出——记录一条日志事件后返回，
   *          避免覆盖任务的真实结果（技术方案 §3.4）。
   * @throws 不抛出异常。
   */
  cleanup(): Promise<void>
}

/** 测试执行结果（技术方案 §3.1）。 */
export interface ITestRunResult {
  /** 总体结果：passed / failed / interrupted。 */
  status: 'passed' | 'failed' | 'interrupted'
  /** 执行总耗时（毫秒）。 */
  durationMs: number
  /** 子进程退出码；被信号终止时可能为 null。 */
  exitCode: number | null
  /** Playwright JSON 报告解析结果（供报告渲染与汇总）；文件缺失时为空报告。 */
  jsonReport: IPlaywrightJsonReport
  /** 运行工作区句柄（失败截图等附件在工作区内，消费完成后调用 cleanup）。 */
  workspace: IRunWorkspaceHandle
}

/** 测试执行器契约（engine 门面能力之一）。 */
export interface ITestRunner {
  /**
   * 执行一次测试运行。
   *
   * @param request - 运行请求（运行 ID、Skill 目录、env 注入、超时与事件回调）。
   * @returns 运行结果；调用方必须在结果消费完成后调用 result.workspace.cleanup()。
   * @throws PlaywrightEngineError 当工作区准备失败或子进程无法启动时抛出。
   */
  run(request: ITestRunRequest): Promise<ITestRunResult>
}

// ---------------------------------------------------------------------------
// Playwright JSON 报告的宽松结构类型（只声明渲染所需字段，容忍多余内容）。
// ---------------------------------------------------------------------------

/** JSON 报告中的统计区。 */
export interface IPlaywrightJsonReportStats {
  startTime?: number
  duration?: number
  expected?: number
  skipped?: number
  unexpected?: number
  flaky?: number
}

/** JSON 报告中的附件（失败截图等）。 */
export interface IPlaywrightJsonAttachment {
  name?: string
  contentType?: string
  /** 附件在工作区内的绝对路径（stderr 截图等落盘附件）。 */
  path?: string
  /** 直接内联的内容（base64）。 */
  body?: string
}

/** JSON 报告中的步骤节点（可无限嵌套）。 */
export interface IPlaywrightJsonStep {
  title?: string
  category?: string
  duration?: number
  error?: { message?: string; stack?: string }
  steps?: IPlaywrightJsonStep[]
}

/** JSON 报告中单次执行结果（retry=0 时仅一条）。 */
export interface IPlaywrightJsonTestResult {
  status?: string
  duration?: number
  error?: { message?: string; stack?: string }
  steps?: IPlaywrightJsonStep[]
  attachments?: IPlaywrightJsonAttachment[]
}

/** JSON 报告中的用例（同 spec 的一次执行声明）。 */
export interface IPlaywrightJsonTestCase {
  status?: string
  results?: IPlaywrightJsonTestResult[]
}

/** JSON 报告中的 spec（一条 test() 声明）。 */
export interface IPlaywrightJsonSpec {
  title?: string
  ok?: boolean
  tests?: IPlaywrightJsonTestCase[]
}

/** JSON 报告中的 suite 节点（项目 / 文件 / describe 层级）。 */
export interface IPlaywrightJsonSuite {
  title?: string
  file?: string
  suites?: IPlaywrightJsonSuite[]
  specs?: IPlaywrightJsonSpec[]
}

/** Playwright JSON 报告（解析后的宽松结构）。 */
export interface IPlaywrightJsonReport {
  stats?: IPlaywrightJsonReportStats
  suites?: IPlaywrightJsonSuite[]
  errors?: unknown[]
}

// ---------------------------------------------------------------------------
// 测试执行器实现。
// ---------------------------------------------------------------------------

/**
 * 创建默认测试执行器。
 *
 * @param options - 可注入项：工作区根目录（测试用临时目录替换）与轮询间隔。
 * @returns 测试执行器实例。
 * @throws 不抛出异常；运行时错误通过 run 的 Promise 拒绝暴露。
 */
export function createPlaywrightTestRunner(
  options: {
    /** 运行工作区根目录；缺省 `os.tmpdir()/e2e-agent-runs`。 */
    workspaceRoot?: string
    /** 事件文件轮询间隔（毫秒）；缺省 100，测试可注入更小值。 */
    tailIntervalMs?: number
  } = {},
): ITestRunner {
  return new PlaywrightTestRunner(options)
}

/** 默认测试执行器实现。 */
class PlaywrightTestRunner implements ITestRunner {
  private readonly workspaceRoot: string
  private readonly tailIntervalMs: number

  constructor(
    options: { workspaceRoot?: string; tailIntervalMs?: number } = {},
  ) {
    this.workspaceRoot =
      options.workspaceRoot ?? path.join(os.tmpdir(), RUN_WORKSPACE_ROOT_NAME)
    this.tailIntervalMs = options.tailIntervalMs ?? TAIL_INTERVAL_MS
  }

  /** @inheritdoc */
  async run(request: ITestRunRequest): Promise<ITestRunResult> {
    const workspacePath = path.join(this.workspaceRoot, request.runId)
    const redactor = createLogRedactor(request.env)

    // 1. 准备运行工作区（复制脚本 + 合成依赖链接 + 生成配置与 reporter）。
    const startedAt = Date.now()
    await prepareWorkspace(workspacePath, request)

    // 2. 启动子进程并采集输出。
    const child = this.spawnTestProcess(workspacePath, request)
    emitEvent(request, {
      type: 'log',
      line: `测试进程已启动（pid ${child.pid ?? 'unknown'}）。`,
    })

    const stdoutPump = pumpStreamLines(child.stdout, (line) =>
      emitEvent(request, { type: 'log', line: redactor.redact(line) }),
    )
    const stderrPump = pumpStreamLines(child.stderr, (line) =>
      emitEvent(request, { type: 'log', line: redactor.redact(line) }),
    )

    // 3. 低频轮询事件文件，把 NDJSON 行转为结构化事件。
    const tail = startEventsTail(
      workspacePath,
      redactor,
      request,
      this.tailIntervalMs,
    )

    // 4. 中止信号 → 终止进程树（先优雅、后强制）。
    const abortListener = (): void => {
      void terminateProcessTree(child.pid)
    }
    request.signal?.addEventListener('abort', abortListener, { once: true })

    // 子进程启动失败（error）时也要停掉轮询与流泵，避免泄漏。
    let exit: { code: number | null; signal: NodeJS.Signals | null }
    try {
      exit = await new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, exitSignal) =>
          resolve({ code, signal: exitSignal ?? null }),
        )
      })
    } catch (error) {
      tail.stop()
      request.signal?.removeEventListener('abort', abortListener)
      throw new PlaywrightEngineError(
        'BROWSER_SESSION_START_FAILED',
        '测试进程启动失败（无法运行 playwright test CLI）。',
        {
          component: 'workspace',
          retryable: true,
          reason: describeError(error),
        },
      )
    }

    request.signal?.removeEventListener('abort', abortListener)
    await stdoutPump
    await stderrPump

    // 5. 等待 reporter 刷盘后做最后一次补读，再解析 JSON 报告。
    await delay(FLUSH_GRACE_MS)
    await tail.drain().catch(() => undefined)
    tail.stop()

    const jsonReport = await readJsonReport(workspacePath)
    const durationMs = Date.now() - startedAt

    // 6. 结果归类：用户中止 / 浏览器窗口被关闭（报告含 interrupted）→ interrupted（X10/X12）。
    const hasInterruptedTest =
      collectTestStatuses(jsonReport).includes('interrupted')
    const status: ITestRunResult['status'] =
      request.signal?.aborted || hasInterruptedTest
        ? 'interrupted'
        : exit.code === 0
          ? 'passed'
          : 'failed'

    emitEvent(request, {
      type: 'log',
      line: `测试进程已退出（exitCode=${exit.code ?? 'null'}），结果：${status}。`,
    })

    return {
      status,
      durationMs,
      exitCode: exit.code,
      jsonReport,
      workspace: createWorkspaceHandle(workspacePath, request),
    }
  }

  /**
   * 启动 `playwright test` 子进程。
   *
   * @param workspacePath - 运行工作区（子进程 cwd）。
   * @param request - 运行请求（env 注入与超时已体现在配置文件中）。
   * @returns 已启动的子进程。
   * @throws PlaywrightEngineError 当 Playwright 安装不可解析或进程无法启动时抛出。
   */
  private spawnTestProcess(
    workspacePath: string,
    request: ITestRunRequest,
  ): ReturnType<typeof spawn> {
    const playwrightRoot = resolvePlaywrightPackageRoot()
    const cliPath = path.join(playwrightRoot, 'cli.js')

    // POSIX 用 detached 进程组便于整组终止；Windows 依赖 taskkill /T。
    const child = spawn(
      process.execPath,
      [cliPath, 'test', '--config=playwright.config.cjs'],
      {
        cwd: workspacePath,
        env: {
          ...process.env,
          ...request.env,
          // v14（W38）：平台内置变量最后写入——即使 env.json 意外同名也以平台注入为准
          // （双保险：types 的 env 解析已在源头拒绝业务占用 SKILL_USER_WORKSPACE）。
          // 它不进入 request.env，因此不会被日志脱敏器当作敏感值（路径不是秘密）。
          ...(request.userWorkspacePath
            ? { SKILL_USER_WORKSPACE: request.userWorkspacePath }
            : {}),
          // 关闭子进程输出的 ANSI 颜色，保证日志行在侧边栏可读。
          FORCE_COLOR: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? {} : { detached: true }),
      },
    )

    child.on('error', (error) => {
      emitEvent(request, {
        type: 'log',
        line: `测试进程启动失败：${error.message}`,
      })
    })

    return child
  }
}

// ---------------------------------------------------------------------------
// 工作区准备（技术方案 §3.2 / §3.3 / §3.5）。
// ---------------------------------------------------------------------------

/**
 * 准备运行工作区：清场 → 复制脚本 → 依赖链接 → 生成配置与 reporter。
 *
 * @param workspacePath - 运行工作区绝对路径。
 * @param request - 运行请求（skillRoot 与 specRelativePath 指向快照来源）。
 * @returns 准备完成后兑现。
 * @throws PlaywrightEngineError 当脚本不存在、复制失败或依赖解析失败时抛出。
 */
async function prepareWorkspace(
  workspacePath: string,
  request: ITestRunRequest,
): Promise<void> {
  // 先清场：runId 冲突（同秒重跑）时保证工作区干净。
  await rm(workspacePath, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })

  // 复制脚本：执行内容即启动前一刻的磁盘快照（PRD X1）。
  const specSource = path.join(request.skillRoot, request.specRelativePath)
  const specTarget = path.join(workspacePath, 'test.spec.ts')

  try {
    await copyFile(specSource, specTarget)
  } catch (error) {
    throw new PlaywrightEngineError(
      'TEMP_WORKSPACE_ERROR',
      '复制 test.spec.ts 到运行工作区失败，脚本可能已被删除。',
      {
        component: 'workspace',
        retryable: false,
        reason: describeError(error),
      },
    )
  }

  try {
    await linkPlaywrightDependencies(workspacePath)
  } catch (error) {
    throw new PlaywrightEngineError(
      'ENGINE_CONFIGURATION_INVALID',
      '无法在运行工作区内链接 Playwright 依赖。',
      { component: 'workspace', retryable: true, reason: describeError(error) },
    )
  }

  await writeFile(
    path.join(workspacePath, 'playwright.config.cjs'),
    buildConfigContent(request),
    'utf8',
  )
  await writeFile(
    path.join(workspacePath, 'reporter.cjs'),
    REPORTER_SOURCE,
    'utf8',
  )
}

/**
 * 在运行工作区内合成 `@playwright/test` 别名包并链接 `playwright`。
 *
 * `@playwright/test` 官方包只是 `playwright/test` 的再导出（内容逐字一致）；
 * 本包依赖树内的 `playwright` 与工作区内合成的别名严格同版本，
 * 避免 Skill 目录（无 node_modules）导致的标准 Node 解析失败。
 *
 * @param workspacePath - 运行工作区绝对路径。
 * @returns 链接完成后兑现。
 * @throws 当 Playwright 包不可解析或链接创建失败时抛出。
 */
async function linkPlaywrightDependencies(
  workspacePath: string,
): Promise<void> {
  const playwrightRoot = resolvePlaywrightPackageRoot()

  // 1. workspace/node_modules/playwright → 真实安装（junction / dir 符号链接）。
  const nodeModules = path.join(workspacePath, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  await createDirectoryLink(
    path.join(nodeModules, 'playwright'),
    playwrightRoot,
  )

  // 2. workspace/node_modules/@playwright/test → 合成别名包（真实目录，内含再导出）。
  const aliasDirectory = path.join(nodeModules, '@playwright', 'test')
  await mkdir(aliasDirectory, { recursive: true })
  await writeFile(
    path.join(aliasDirectory, 'package.json'),
    JSON.stringify({
      name: '@playwright/test',
      version: readPlaywrightVersion(playwrightRoot),
      description:
        'Workspace-local alias re-exporting playwright/test for test.spec.ts execution.',
      exports: {
        '.': {
          types: './index.d.ts',
          import: './index.mjs',
          require: './index.js',
          default: './index.js',
        },
      },
    }),
    'utf8',
  )
  await writeFile(
    path.join(aliasDirectory, 'index.js'),
    "module.exports = require('playwright/test');\n",
    'utf8',
  )
  await writeFile(
    path.join(aliasDirectory, 'index.mjs'),
    "export * from 'playwright/test';\nexport { default } from 'playwright/test';\n",
    'utf8',
  )
}

/**
 * 解析本包依赖树内的 Playwright 安装根目录。
 *
 * 经 `playwright/package.json`（exports 白名单内的子路径）解析，
 * 再取 realpath，保证 junction 指向 pnpm 真实安装目录、其内部依赖可解析。
 *
 * @returns Playwright 包根目录绝对路径。
 * @throws PlaywrightEngineError 当 Playwright 不可解析时抛出。
 */
function resolvePlaywrightPackageRoot(): string {
  const requireFromEngine = createRequire(import.meta.url)

  try {
    const packageJsonPath = requireFromEngine.resolve('playwright/package.json')
    return realPathSyncSafe(path.dirname(packageJsonPath))
  } catch (error) {
    throw new PlaywrightEngineError(
      'ENGINE_CONFIGURATION_INVALID',
      '无法解析 playwright 包（playwright CLI 不可用）。',
      {
        component: 'workspace',
        retryable: false,
        reason: describeError(error),
      },
    )
  }
}

/**
 * 读取 Playwright 包版本（合成别名的版本号仅用于展示）。
 *
 * @param playwrightRoot - Playwright 包根目录。
 * @returns 版本文本；解析失败时返回 'unknown'。
 * @throws 不抛出异常。
 */
function readPlaywrightVersion(playwrightRoot: string): string {
  try {
    // createRequire 同步读取；失败不影响执行，仅影响别名包的版本元数据。
    const requireFromEngine = createRequire(import.meta.url)
    const pkg = requireFromEngine(
      path.join(playwrightRoot, 'package.json'),
    ) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 自定义 NDJSON reporter 源码（写入运行工作区 reporter.cjs，技术方案 §3.5）。
 *
 * 在 onBegin / onTestBegin / onStepBegin / onStepEnd / onTestEnd / onEnd
 * 向 events.ndjson 追加单行 JSON；stepId 取 test.step 标题
 * （v7 生成规则：第一参数即用例步骤 id）。只输出 test.step 类别的步骤，
 * 避免钩子与 expect 的内部步骤污染前端进度展示。
 */
const REPORTER_SOURCE = `// 由执行器自动生成的平台事件 reporter：向 events.ndjson 追加单行 JSON。
const fs = require('fs');
const path = require('path');

class PlatformEventsReporter {
  constructor(options) {
    this.outputFile = path.resolve(__dirname, (options && options.outputFile) || 'events.ndjson');
    this.stream = fs.createWriteStream(this.outputFile, { flags: 'a' });
  }

  logLine(object) {
    if (this.stream) this.stream.write(JSON.stringify(object) + '\\n');
  }

  onBegin() {
    this.logLine({ event: 'begin', timestamp: Date.now() });
  }

  onTestBegin(test) {
    this.logLine({ event: 'test-start', title: test.title, timestamp: Date.now() });
  }

  onStepBegin(test, result, step) {
    if (!step || step.category !== 'test.step') return;
    this.logLine({
      event: 'step-start',
      testTitle: test.title,
      stepId: step.title,
      stepTitle: step.title,
      timestamp: Date.now(),
    });
  }

  onStepEnd(test, result, step) {
    if (!step || step.category !== 'test.step') return;
    this.logLine({
      event: 'step-end',
      stepId: step.title,
      ok: !step.error,
      timestamp: Date.now(),
    });
  }

  onTestEnd(test, result) {
    const message = (result.error && result.error.message)
      || (result.errors && result.errors[0] && result.errors[0].message)
      || undefined;
    this.logLine({
      event: 'test-end',
      title: test.title,
      status: result.status,
      durationMs: result.duration || 0,
      errorMessage: message ? String(message) : undefined,
      timestamp: Date.now(),
    });
  }

  onEnd() {
    const stream = this.stream;
    this.stream = null;
    if (stream) stream.end();
  }
}

module.exports = PlatformEventsReporter;
`

// ---------------------------------------------------------------------------
// 事件文件轮询（技术方案 D5）。
// ---------------------------------------------------------------------------

/** 事件轮询句柄。 */
interface IEventsTail {
  /** 立即补读一次新增内容。 */
  drain(): Promise<void>
  /** 停止轮询。 */
  stop(): void
}

/**
 * 启动事件文件轮询：每 tick 读取新增字节，逐行解析为事件回调宿主。
 *
 * @param workspacePath - 运行工作区。
 * @param redactor - 日志脱敏器（错误消息同样经过脱敏，A5）。
 * @param request - 运行请求（onEvent 回调目标）。
 * @param intervalMs - 轮询间隔。
 * @returns 轮询句柄。
 * @throws 不抛出异常；文件暂未生成时静默等待。
 */
function startEventsTail(
  workspacePath: string,
  redactor: ISensitiveDataRedactor,
  request: ITestRunRequest,
  intervalMs: number,
): IEventsTail {
  const eventsPath = path.join(workspacePath, EVENTS_FILE_NAME)
  let offset = 0
  let remainder = ''
  let stopped = false

  const timer = setInterval(() => {
    void drain().catch(() => {
      // 文件尚未创建或被并发截断：下一个 tick 重试。
    })
  }, intervalMs)

  timer.unref?.()

  /** 读取自 offset 起的新增内容并解析为事件。 */
  async function drain(): Promise<void> {
    if (stopped) return

    const fileStat = await stat(eventsPath).catch(() => undefined)
    if (!fileStat || fileStat.size <= offset) return

    const handle = await open(eventsPath, 'r')
    try {
      const length = fileStat.size - offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, offset)
      offset = fileStat.size
      remainder += buffer.toString('utf8')
    } finally {
      await handle.close()
    }

    const lines = remainder.split('\n')
    remainder = lines.pop() ?? ''

    for (const line of lines) {
      emitEngineNdjsonLine(line, redactor, request)
    }
  }

  return {
    drain,
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}

/**
 * 解析一行 NDJSON 并回调宿主；无法解析的行降级为日志行。
 *
 * @param line - 原始行文本（不含换行符）。
 * @param redactor - 脱敏器。
 * @param request - 运行请求。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function emitEngineNdjsonLine(
  line: string,
  redactor: ISensitiveDataRedactor,
  request: ITestRunRequest,
): void {
  const trimmed = line.trim()
  if (!trimmed) return

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    emitEvent(request, { type: 'log', line: redactor.redact(trimmed) })
    return
  }

  switch (parsed.event) {
    case 'test-start':
      emitEvent(request, {
        type: 'test-start',
        title: String(parsed.title ?? ''),
      })
      return
    case 'test-end': {
      const status = normalizeEngineStatus(parsed.status)
      emitEvent(request, {
        type: 'test-end',
        title: String(parsed.title ?? ''),
        status,
        durationMs: Number(parsed.durationMs ?? 0),
        ...(typeof parsed.errorMessage === 'string' && parsed.errorMessage
          ? { errorMessage: redactor.redact(parsed.errorMessage) }
          : {}),
      })
      return
    }
    case 'step-start':
      emitEvent(request, {
        type: 'step-start',
        testTitle: String(parsed.testTitle ?? ''),
        stepId: String(parsed.stepId ?? ''),
        stepTitle: String(parsed.stepTitle ?? parsed.stepId ?? ''),
      })
      return
    case 'step-end':
      emitEvent(request, {
        type: 'step-end',
        stepId: String(parsed.stepId ?? ''),
        ok: parsed.ok === true,
      })
      return
    default:
      // begin 等平台侧事件无需上抛；未知事件按日志降级。
      return
  }
}

/** 把 Playwright 状态文本归一为引擎测试状态。 */
function normalizeEngineStatus(status: unknown): TEngineTestStatus {
  switch (status) {
    case 'passed':
    case 'expected':
      return 'passed'
    case 'timedOut':
      return 'timedOut'
    case 'skipped':
      return 'skipped'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'failed'
  }
}

// ---------------------------------------------------------------------------
// 终止、清理与工具函数。
// ---------------------------------------------------------------------------

/**
 * 终止测试进程树：POSIX 向进程组发 SIGKILL；Windows 用 taskkill /T /F（技术方案 D8）。
 *
 * @param pid - 子进程 PID。
 * @returns 终止动作完成（不保证进程已退出，只保证请求已发出）。
 * @throws 不抛出异常；终止失败仅记录 debug 级信息（进程可能已自行退出）。
 */
async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return

  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        // taskkill 是控制台程序：无控制台宿主下会新建黑窗，显式隐藏。
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        killer.once('close', () => resolve())
        killer.once('error', () => resolve())
      })
      return
    }

    // detached 子进程自成进程组：负值 PID 向整组发送信号（含浏览器子进程）。
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // 进程可能已经退出：忽略。
  }
}

/** 创建运行工作区句柄：终态清理入口（技术方案 §3.4）。 */
function createWorkspaceHandle(
  workspacePath: string,
  request: ITestRunRequest,
): IRunWorkspaceHandle {
  return {
    path: workspacePath,
    async cleanup(): Promise<void> {
      for (
        let attempt = 0;
        attempt <= CLEANUP_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        try {
          await rm(workspacePath, { recursive: true, force: true })
          return
        } catch {
          const retryDelay = CLEANUP_RETRY_DELAYS_MS[attempt]
          if (retryDelay !== undefined) {
            await delay(retryDelay)
          }
        }
      }

      emitEvent(request, {
        type: 'log',
        line: `运行工作区清理失败（可能仍被占用）：${workspacePath}`,
      })
    },
  }
}

/**
 * 创建目录符号链接：Windows 用 junction（无需管理员权限），POSIX 用 dir 链接。
 *
 * @param linkPath - 链接路径。
 * @param targetPath - 目标目录（真实路径）。
 * @returns 创建完成；已存在时幂等成功。
 * @throws 文件系统错误透传。
 */
async function createDirectoryLink(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await symlink(
      targetPath,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    if (isAlreadyExistsError(error)) return
    throw error
  }
}

/**
 * realpath 的安全封装：失败时返回原路径。
 *
 * @param targetPath - 输入路径。
 * @returns 真实路径；解析失败时为输入路径。
 * @throws 不抛出异常。
 */
function realPathSyncSafe(targetPath: string): string {
  try {
    const requireFromEngine = createRequire(import.meta.url)
    const fs = requireFromEngine('node:fs') as typeof import('node:fs')
    return fs.realpathSync(targetPath)
  } catch {
    return targetPath
  }
}

/** 读取运行工作区内的 JSON 报告；缺失或损坏时返回空报告。 */
async function readJsonReport(
  workspacePath: string,
): Promise<IPlaywrightJsonReport> {
  try {
    const content = await readFile(
      path.join(workspacePath, JSON_REPORT_FILE_NAME),
      'utf8',
    )
    const parsed = JSON.parse(content) as Partial<IPlaywrightJsonReport>
    return {
      ...(parsed.stats ? { stats: parsed.stats } : {}),
      ...(Array.isArray(parsed.suites) ? { suites: parsed.suites } : {}),
      ...(Array.isArray(parsed.errors) ? { errors: parsed.errors } : {}),
    }
  } catch {
    return {}
  }
}

/** 从报告中收集全部测试状态（判定 interrupted 用，D8）。 */
function collectTestStatuses(report: IPlaywrightJsonReport): string[] {
  const statuses: string[] = []

  const walkSuites = (suites: IPlaywrightJsonSuite[] | undefined): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const testCase of spec.tests ?? []) {
          const lastResult = testCase.results?.[testCase.results.length - 1]
          statuses.push(String(lastResult?.status ?? testCase.status ?? ''))
        }
      }
      walkSuites(suite.suites)
    }
  }

  walkSuites(report.suites)
  return statuses
}

/** 回调宿主的空安全封装。 */
function emitEvent(request: ITestRunRequest, event: TEngineRunEvent): void {
  request.onEvent?.(event)
}

/**
 * 把流按行拆分并逐行回调。
 *
 * @param stream - 可读流。
 * @param onLine - 每个完整行的回调（不含换行符）。
 * @returns 流消费完成后的 Promise。
 * @throws 不抛出异常；流错误视为流结束。
 */
async function pumpStreamLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return

  let remainder = ''
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = remainder.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) onLine(line)
      }
    }
  } catch {
    // 子进程被强制终止时流可能以错误收尾：按流结束处理。
  }

  if (remainder.trim()) onLine(remainder)
}

/** 创建把 env 值列为秘密的脱敏器（A5：值不出现在任何日志行）。 */
function createLogRedactor(
  env: Readonly<Record<string, string>>,
): ISensitiveDataRedactor {
  return new DefaultSensitiveDataRedactor({ secrets: Object.values(env) })
}

/** 判断错误是否为「已存在」类（幂等创建）。 */
function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EEXIST' || code === 'EALREADY'
}

/** 等待指定毫秒。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 提取未知错误的可读描述。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

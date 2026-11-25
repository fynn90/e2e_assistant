/**
 * 后台服务启动器（v19 §3.2）：探测 → 复用或派生 → 等待就绪 → 报告。
 *
 * 它是纯编排：文件与进程的底层操作在 infrastructure 层（log-file.ts 等），
 * 这里只决定「什么时候做什么」以及失败时告诉用户什么。
 *
 * 关键设计（§1.2）：**服务进程不需要知道自己是后台**——子进程的 stdout/stderr
 * 由本模块重定向到日志文件，服务层因此没有任何「写日志文件」的代码。
 *
 * v21（Windows 控制台黑窗）：Windows 上改用 wscript + VBS 的「隐藏控制台」方式派生
 * （见 infrastructure/process/hidden-console-launch.ts）。否则没有控制台的服务会让每一个
 * 控制台子系统子进程（node 测试进程、chrome-headless-shell 等）弹出一个可见黑窗。
 * 代价是派生壳（wscript）的 PID 与服务进程 PID 不再相同——就绪判据因此改为
 * 「本次启动之后新写入的运行态记录」，并在派生前清掉陈旧记录。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import { openSync, closeSync } from 'node:fs'
import {
  getServiceLogPath,
  readServiceLogTail,
  rotateServiceLogIfNeeded,
} from '../infrastructure/log/log-file'
import { SERVICE_MODE_ENV_VAR } from '../infrastructure/service-mode'
import {
  clearPlatformRuntimeState,
  inspectPlatformRuntimeState,
  isPlatformProcessAlive,
  type IPlatformRuntimeState,
} from '../infrastructure/config/runtime-store'
import { ensurePlatformConfigStorage } from './platform-config-storage'
import {
  resolveServiceState,
  type TServiceResolution,
} from './service-identity'
import { probeLocalService } from '../infrastructure/http/service-probe'
import { probeBashShell, type TBashShellProbe } from './bash-shell-check'
import {
  ensureSecureDirectory,
  ensureSecureFile,
} from '../infrastructure/config/secure-file'
import {
  buildHiddenLaunchInvocation,
  ensureHiddenLaunchScript,
  getHiddenLaunchScriptPath,
} from '../infrastructure/process/hidden-console-launch'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@charlie_deng/e2e-assistant-types'

/** 等待后台服务就绪的总时长上限（§4.2 第 4 步）。 */
const READY_TIMEOUT_MS = 30_000
/** 就绪轮询间隔。 */
const READY_POLL_INTERVAL_MS = 250
/** 失败报告中附带的日志尾部行数。 */
const FAILURE_LOG_TAIL_LINES = 30
/**
 * 运行态记录的新鲜度容差（毫秒）。
 *
 * 记录由服务进程在监听成功后写入，理论上不早于启动时刻；容差只用于吸收
 * 毫秒级时间戳与写入顺序的偏差。
 */
const RECORD_FRESHNESS_TOLERANCE_MS = 1000

export interface ILaunchBackgroundServiceOptions {
  port: number
  strictPort?: boolean
  shouldOpen: boolean
}

/**
 * 后台启动结果。
 *
 * - `reused`：已确认同版本服务在运行，直接复用，未派生新进程、未轮转日志；
 * - `started`：已派生子进程并确认就绪。
 */
export interface ILaunchBackgroundServiceResult {
  outcome: 'reused' | 'started'
  port: number
  serverUrl: string
  /** 后台服务的日志文件路径（供命令输出）。 */
  logPath: string
  /** 服务进程号（供命令输出）；复用分支取自运行态记录。 */
  pid: number
  /** 服务启动时刻，ISO 8601（供命令输出）；复用分支取自运行态记录。 */
  startedAt: string
  /**
   * bash 探测结果（供命令输出）。
   *
   * 由**启动器所在进程**探测，而非派生的服务子进程：后者的 stdout 已被
   * 重定向到日志文件，在那里打印的提示用户根本看不到——而「bash 是否可用」
   * 恰恰是启动时就要告诉用户的事（不可用意味着 Agent 跑不了测试命令）。
   * 代价是父子各探测一次；探测只做文件存在性与 where 查询，开销可忽略。
   */
  shellProbe: TBashShellProbe
  /**
   * 日志轮转失败的原因；未失败时不带该字段。
   *
   * 不阻断启动，但要如实告诉用户「日志可能不是连续的」——静默失败会让人
   * 以为日志完整，而实际已被覆盖。
   */
  logRotationFailureReason?: string
}

/**
 * 启动器的可注入依赖；生产环境用默认实现，测试注入替身以避免真实进程。
 */
export interface IBackgroundLauncherDependencies {
  ensurePlatformConfigStorage: typeof ensurePlatformConfigStorage
  inspectPlatformRuntimeState: typeof inspectPlatformRuntimeState
  isPlatformProcessAlive: typeof isPlatformProcessAlive
  probeLocalService: typeof probeLocalService
  ensureSecureDirectory: typeof ensureSecureDirectory
  /** 收敛已存在文件的权限（openSync 的 mode 只对新建文件生效）。 */
  ensureSecureFile: typeof ensureSecureFile
  /** 日志轮转；返回结果而不再自行打印（说明由命令层呈现）。 */
  rotateServiceLogIfNeeded: typeof rotateServiceLogIfNeeded
  readServiceLogTail: typeof readServiceLogTail
  getServiceLogPath: typeof getServiceLogPath
  /** bash 探测；在启动器进程内执行，结果随启动结果一并返回。 */
  probeBashShell: typeof probeBashShell
  /** 确保 Windows「隐藏控制台」启动脚本就绪；其他平台为空实现。 */
  ensureHiddenLaunchScript: typeof ensureHiddenLaunchScript
  /** 清理陈旧运行态记录：保证随后出现的记录必定属于本次派生。 */
  clearPlatformRuntimeState: typeof clearPlatformRuntimeState
  /** 派生后台服务进程；返回子进程句柄与解绑后的清理函数。 */
  spawnBackgroundServiceProcess: (options: {
    port: number
    strictPort?: boolean
    logPath: string
  }) => ISpawnedServiceProcess
  /** 结束未就绪的子进程（等待就绪超时/失败时使用）。 */
  terminateProcess: (pid: number) => boolean
  readyTimeoutMs: number
  readyPollIntervalMs: number
  /** 等待进程退出的轮询间隔（复用给「子进程先退出」的观察）。 */
  sleep: (durationMs: number) => Promise<void>
}

export interface ISpawnedServiceProcess {
  pid: number
  /**
   * 等待子进程退出。
   *
   * @returns 退出码；被信号终止时为 null。
   */
  waitForExit: () => Promise<number | null>
}

/**
 * 构造生产环境的默认依赖集合。
 *
 * @param overrides - 需要覆盖的依赖项。
 * @returns 合并后的依赖集合。
 * @throws 不抛出异常。
 */
export function createBackgroundLauncherDependencies (
  overrides: Partial<IBackgroundLauncherDependencies> = {},
): IBackgroundLauncherDependencies {
  return {
    ensurePlatformConfigStorage,
    inspectPlatformRuntimeState,
    isPlatformProcessAlive,
    probeLocalService,
    ensureSecureDirectory,
    ensureSecureFile,
    rotateServiceLogIfNeeded,
    readServiceLogTail,
    getServiceLogPath,
    probeBashShell,
    ensureHiddenLaunchScript,
    clearPlatformRuntimeState,
    spawnBackgroundServiceProcess,
    terminateProcess: terminateProcessBySignal,
    readyTimeoutMs: READY_TIMEOUT_MS,
    readyPollIntervalMs: READY_POLL_INTERVAL_MS,
    sleep,
    ...overrides,
  }
}

/**
 * 启动后台服务（或复用已在运行的）。
 *
 * @param options - 端口、严格模式与是否打开浏览器。
 * @param overrides - 可选的依赖覆盖项，用于测试。
 * @returns 启动或复用结果。
 * @throws 当状态无法确认、版本不符、端口冲突、日志文件不可写或等待就绪失败时抛出。
 */
export async function launchBackgroundService (
  options: ILaunchBackgroundServiceOptions,
  overrides: Partial<IBackgroundLauncherDependencies> = {},
): Promise<ILaunchBackgroundServiceResult> {
  const dependencies = createBackgroundLauncherDependencies(overrides)
  const logPath = dependencies.getServiceLogPath()

  await dependencies.ensurePlatformConfigStorage()

  // 先探测：复用分支不派生、不轮转日志（§3.2）。
  const resolution = await resolveBackgroundState({ dependencies })
  const reusedResult = buildReusedResult({ resolution, options, logPath })

  if (reusedResult) {
    return reusedResult
  }

  assertStateAllowsLaunch(resolution)

  // 日志目录与文件必须可写：失败要明确报出，不静默降级为「不落盘」（PRD 异常表）。
  await ensureLogDirectoryWritable({ dependencies, logPath })
  // 轮转失败不阻断启动，但把原因带给命令层呈现——静默会让用户以为日志是连续的。
  const rotationResult = await dependencies.rotateServiceLogIfNeeded()

  // 在派生之前于**本进程**探测 bash：子进程的 stdout 已重定向到日志文件，
  // 探测结果只有在这里取得才能呈现给用户（见 ILaunchBackgroundServiceResult）。
  const shellProbe = dependencies.probeBashShell()
  // 隐藏控制台启动脚本（仅 Windows 使用）：写失败必须当启动失败报出来，
  // 否则会静默退化成旧行为、继续弹控制台黑窗。
  await dependencies.ensureHiddenLaunchScript()
  // 派生前清掉陈旧记录：就绪判据不再比对「派生子进程 PID」（Windows 上是 wscript 的
  // PID，与服务 PID 不同），改为「本次启动之后新写入的记录」，因此必须先清干净。
  await dependencies.clearPlatformRuntimeState()
  /** 本次启动时刻：早于它写入的记录一律按陈旧处理。 */
  const launchedAfterMs = Date.now()
  const child = dependencies.spawnBackgroundServiceProcess({
    port: options.port,
    ...(options.strictPort ? { strictPort: options.strictPort } : {}),
    logPath,
  })

  return await waitForServiceReady({
    dependencies,
    child,
    logPath,
    shellProbe,
    launchedAfterMs,
    logRotationFailureReason: rotationResult.failureReason,
  })
}

interface IResolveBackgroundStateOptions {
  dependencies: IBackgroundLauncherDependencies
}

/**
 * 读取并判定当前服务状态（复用既有三态判定）。
 *
 * @param options - 依赖集合。
 * @returns 服务状态判定结果。
 * @throws 不抛出异常；读取失败按「无记录」处理，由后续启动接管。
 */
async function resolveBackgroundState (
  options: IResolveBackgroundStateOptions,
): Promise<TServiceResolution> {
  const { dependencies } = options
  const inspection = await dependencies.inspectPlatformRuntimeState()

  return await resolveServiceState({
    runtimeState: inspection.runtimeState,
    isRecordInvalid: inspection.state === 'invalid',
    probe: dependencies.probeLocalService,
  })
}

interface IBuildReusedResultOptions {
  resolution: TServiceResolution
  options: ILaunchBackgroundServiceOptions
  logPath: string
}

/**
 * 服务已确认为 active 时构造复用结果。
 *
 * @param options - 判定结果、启动参数与日志路径。
 * @returns 复用结果；服务未在运行时返回 null。
 * @throws 当版本不符或严格模式要求端口一致时抛出（文案与前台链路同源）。
 */
function buildReusedResult (
  options: IBuildReusedResultOptions,
): ILaunchBackgroundServiceResult | null {
  const { resolution, options: launchOptions, logPath } = options

  if (resolution.state !== 'active') {
    return null
  }

  const activePort = resolution.runtimeState.port

  if (resolution.version !== LOCAL_SERVICE_PROTOCOL_VERSION) {
    throw new Error(
      `检测到端口 ${activePort} 上运行着协议版本 v${resolution.version} 的 CLI 服务，当前版本要求 v${LOCAL_SERVICE_PROTOCOL_VERSION}。请执行 e2e_assistant stop 后重新启动。`,
    )
  }

  if (launchOptions.strictPort && activePort !== launchOptions.port) {
    throw new Error(
      `检测到 CLI 服务已运行在端口 ${activePort}，当前开发配置要求端口 ${launchOptions.port}。请执行 e2e_assistant stop，或设置 AUTHINE_CLI_PORT=${activePort} 后重试。`,
    )
  }

  return {
    outcome: 'reused',
    port: activePort,
    serverUrl: resolution.runtimeState.serverUrl,
    logPath,
    pid: resolution.runtimeState.pid,
    startedAt: resolution.runtimeState.startedAt,
    // 复用分支不重新探测 bash：被复用的服务早在它自己启动时就探测过了，
    // 这里再探一次属于重复开销，也让复用输出多一行无关信息。
    shellProbe: { outcome: 'not-applicable' },
  }
}

/**
 * 无法确认服务状态时拒绝派生（与前台链路的 `assertServiceStateAllowsStart` 同源）。
 *
 * @param resolution - 服务状态判定结果。
 * @returns 允许派生时无返回值。
 * @throws 当状态无法确认时抛出带有处理建议的异常。
 */
function assertStateAllowsLaunch (resolution: TServiceResolution): void {
  if (resolution.state === 'unknown') {
    throw new Error(
      `${resolution.detail} 请先确认该端口上的服务，必要时手动结束它后再重试。`,
    )
  }
}

interface IEnsureLogDirectoryWritableOptions {
  dependencies: IBackgroundLauncherDependencies
  logPath: string
}

/**
 * 确保日志目录与日志文件存在且可写；不可写时直接失败并说明路径与原因。
 *
 * 不静默降级为「不落盘」：后台服务的日志是它唯一的可观测面，静默丢失
 * 会让「服务起不来」变成一个没有任何线索的问题。
 *
 * 目录用 0700、日志文件用 0600（与 runtime.json 同一保密级别）：日志可能含
 * 工作区路径与接口调用记录。复用 `ensureSecureFile` 而非只靠 openSync 的 mode——
 * 它同时处理**已存在**文件的权限收敛（openSync 的 mode 只对新建文件生效）。
 *
 * @param options - 依赖集合与日志路径。
 * @returns 目录与文件就绪时无返回值。
 * @throws Error 当目录或文件不可创建时抛出，携带路径与原因。
 */
async function ensureLogDirectoryWritable (
  options: IEnsureLogDirectoryWritableOptions,
): Promise<void> {
  const { dependencies, logPath } = options

  try {
    await dependencies.ensureSecureDirectory(path.dirname(logPath))
    await dependencies.ensureSecureFile(logPath)
  } catch (error) {
    throw new Error(
      `无法创建后台服务日志目录或文件 ${logPath}：${formatErrorMessage(error)}。请检查磁盘权限后重试。`,
    )
  }
}

interface IWaitForServiceReadyOptions {
  dependencies: IBackgroundLauncherDependencies
  child: ISpawnedServiceProcess
  logPath: string
  /** 启动器进程内的 bash 探测结果，随就绪结果一并返回。 */
  shellProbe: TBashShellProbe
  /** 本次启动时刻：早于它写入的记录视为陈旧。 */
  launchedAfterMs: number
  /** 日志轮转失败的原因；未失败时为 null。不阻断启动，由命令层提示。 */
  logRotationFailureReason: string | null
}

interface IInspectReadyStateOptions {
  dependencies: IBackgroundLauncherDependencies
  /** 本次启动时刻：早于它写入的记录属于上一轮，必须忽略。 */
  launchedAfterMs: number
}

/**
 * 等待新服务就绪；失败时结束未就绪的子进程并报告原因与日志尾部（§3.4）。
 *
 * 就绪判据（§3.2；v21 起）：记录存在、mode 为 background、**写入时刻晚于本次启动**、
 * 记录中的 pid 仍存活、健康探测确认身份且 pid 一致。派生前已清理陈旧记录，
 * 新鲜度校验是第二道防线（并发启动或清理失败时仍不会误认上一轮的服务）。
 *
 * @param options - 依赖集合、子进程句柄与日志路径。
 * @returns 就绪结果。
 * @throws Error 当子进程先退出或等待超时时抛出，携带日志尾部。
 */
async function waitForServiceReady (
  options: IWaitForServiceReadyOptions,
): Promise<ILaunchBackgroundServiceResult> {
  const {
    dependencies,
    child,
    logPath,
    shellProbe,
    launchedAfterMs,
    logRotationFailureReason,
  } = options
  const deadline = Date.now() + dependencies.readyTimeoutMs
  /** 子进程的退出状态；用于区分「先退出」与「超时」。 */
  let childExitCode: number | null | undefined

  void child.waitForExit().then((exitCode) => {
    childExitCode = exitCode
  })

  while (Date.now() <= deadline) {
    if (childExitCode !== undefined) {
      throw new Error(
        await buildChildExitFailureMessage({
          dependencies,
          exitCode: childExitCode,
          logPath,
        }),
      )
    }

    const readyState = await inspectReadyState({
      dependencies,
      launchedAfterMs,
    })

    if (readyState) {
      return {
        outcome: 'started',
        port: readyState.port,
        serverUrl: readyState.serverUrl,
        logPath,
        pid: readyState.pid,
        startedAt: readyState.startedAt,
        shellProbe,
        ...(logRotationFailureReason ? { logRotationFailureReason } : {}),
      }
    }

    await dependencies.sleep(dependencies.readyPollIntervalMs)
  }

  // 超时：不留半死的后台进程。Windows 的派生壳（wscript）与服务进程不是同一个 PID，
  // 因此先按本次启动写入的记录结束服务，再结束派生壳。
  const pendingRecord = await loadFreshBackgroundRecord({
    dependencies,
    launchedAfterMs,
  })

  if (pendingRecord) {
    dependencies.terminateProcess(pendingRecord.pid)
  }

  dependencies.terminateProcess(child.pid)

  throw new Error(await buildReadyTimeoutMessage({ dependencies, logPath }))
}

/**
 * 检查一次就绪判据（四条全中才算就绪）。
 *
 * @param options - 依赖集合与本次派生的子进程号。
 * @returns 就绪时的地址、端口、进程号与启动时刻；未就绪返回 null。
 * @throws 不抛出异常。
 */
async function inspectReadyState (options: IInspectReadyStateOptions): Promise<{
  port: number
  serverUrl: string
  pid: number
  startedAt: string
} | null> {
  const { dependencies } = options
  const runtimeState = await loadFreshBackgroundRecord({
    dependencies,
    launchedAfterMs: options.launchedAfterMs,
  })

  if (!runtimeState) {
    return null
  }

  if (!dependencies.isPlatformProcessAlive(runtimeState.pid)) {
    return null
  }

  const probeResult = await dependencies.probeLocalService({
    serverUrl: runtimeState.serverUrl,
  })

  // 端口上应答的必须是记录里那个进程：否则是另一个实例，不能据此宣布就绪。
  if (
    probeResult.outcome !== 'confirmed' ||
    (probeResult.pid !== null && probeResult.pid !== runtimeState.pid)
  ) {
    return null
  }

  return {
    port: runtimeState.port,
    serverUrl: runtimeState.serverUrl,
    pid: runtimeState.pid,
    startedAt: runtimeState.startedAt,
  }
}

/**
 * 读取「本次启动之后写入」的后台运行态记录。
 *
 * 记录由服务进程自己写入，因此 pid 就是服务进程号——Windows 的隐藏控制台派生下，
 * 它与启动器派生的壳进程 PID 不同，不能再用来判断「是不是我派生的那个」。
 * 改为以写入时刻为准：派生前已清掉陈旧记录，这里再把早于本次启动的记录挡掉，
 * 防止并发启动或清理失败时把上一轮的服务误报成本次结果。
 *
 * @param options - 依赖集合与本次启动时刻。
 * @returns 新鲜的后台记录；不存在、模式不符或已过时返回 null。
 * @throws 不抛出异常；读取失败按「没有记录」处理。
 */
async function loadFreshBackgroundRecord (options: {
  dependencies: IBackgroundLauncherDependencies
  launchedAfterMs: number
}): Promise<IPlatformRuntimeState | null> {
  const inspection = await options.dependencies.inspectPlatformRuntimeState()

  if (
    inspection.state !== 'present' ||
    inspection.runtimeState.mode !== 'background'
  ) {
    return null
  }

  const startedAtMs = Date.parse(inspection.runtimeState.startedAt)

  // 记录缺失时间戳或早于本次启动：一律按陈旧处理（旧记录可能被并发启动复用）。
  if (
    !Number.isFinite(startedAtMs) ||
    startedAtMs < options.launchedAfterMs - RECORD_FRESHNESS_TOLERANCE_MS
  ) {
    return null
  }

  return inspection.runtimeState
}

interface IBuildFailureMessageOptions {
  dependencies: IBackgroundLauncherDependencies
  logPath: string
}

interface IBuildChildExitFailureMessageOptions extends IBuildFailureMessageOptions {
  exitCode: number | null
}

/**
 * 构造「子进程启动即退出」的失败文案（含日志尾部）。
 *
 * @param options - 依赖集合、子进程与退出码。
 * @returns 面向用户的失败原因全文。
 * @throws 不抛出异常。
 */
async function buildChildExitFailureMessage (
  options: IBuildChildExitFailureMessageOptions,
): Promise<string> {
  const exitDescription =
    options.exitCode === null ? '被信号终止' : `退出码 ${options.exitCode}`
  return [
    `后台服务进程启动后立即退出（${exitDescription}）。`,
    await readLogTailSection(options),
  ].join('\n')
}

interface IBuildReadyTimeoutMessageOptions extends IBuildFailureMessageOptions { }

/**
 * 构造「等待就绪超时」的失败文案（含日志尾部与建议）。
 *
 * @param options - 依赖集合、子进程与日志路径。
 * @returns 面向用户的失败原因全文。
 * @throws 不抛出异常。
 */
async function buildReadyTimeoutMessage (
  options: IBuildReadyTimeoutMessageOptions,
): Promise<string> {
  return [
    `等待后台服务就绪超时（${Math.round(options.dependencies.readyTimeoutMs / 1000)} 秒），已结束未就绪的服务进程。`,
    '请检查端口是否被占用，或查看日志文件了解原因。',
    await readLogTailSection(options),
  ].join('\n')
}

/**
 * 读取日志尾部并格式化为报告段落。
 *
 * @param options - 依赖集合与日志路径。
 * @returns 日志尾部段落；没有日志时返回提示行。
 * @throws 不抛出异常。
 */
async function readLogTailSection (
  options: IBuildFailureMessageOptions,
): Promise<string> {
  const logTail = await options.dependencies.readServiceLogTail({
    maxLines: FAILURE_LOG_TAIL_LINES,
  })

  return logTail
    ? `—— 日志最后 ${FAILURE_LOG_TAIL_LINES} 行（${options.logPath}）——\n${logTail}`
    : `—— 暂无日志内容（${options.logPath}）——`
}

// ---------------------------------------------------------------------------
// 生产实现：派生与解绑。
// ---------------------------------------------------------------------------

/**
 * 派生真正的后台服务子进程。
 *
 * 形态依据（技术方案 §3.3 与 M1/M4）：
 *   - `detached: true` + `unref()`：脱离父进程，父进程退出后依然存活；
 *   - `stdio[1]/stdio[2]` 指向日志文件 fd：POSIX 上这就是「日志落盘」的实现；
 *     Windows 上再套一层 wscript（隐藏控制台，见 hidden-console-launch.ts），
 *     子进程输出由脚本内的 cmd 重定向追写到同一日志文件；
 *   - `process.execArgv` 原样透传：dev（tsx）下携带 loader，生产下为空；
 *   - 子进程命令行固定为 `start --no-open --foreground [-p <port>] [--strict-port]`，
 *     其中 `--foreground` 的含义是「别再去派生孙子进程」，浏览器由启动器打开。
 *
 * @param options - 端口、严格模式与日志路径。
 * @returns 子进程句柄与等待退出的函数。
 * @throws Error 当入口脚本路径不可得（极端环境）或日志文件无法打开时抛出。
 */
function spawnBackgroundServiceProcess (options: {
  port: number
  strictPort?: boolean
  logPath: string
}): ISpawnedServiceProcess {
  const entryScriptPath = process.argv[1]

  if (!entryScriptPath) {
    // 不静默降级到「前台」：那会让用户以为服务在后台，实际占着终端。
    throw new Error(
      '无法确定 CLI 入口脚本路径，后台模式不可用。请改用 e2e_assistant start --foreground。',
    )
  }

  const childArguments = [
    ...process.execArgv,
    path.resolve(entryScriptPath),
    'start',
    '--no-open',
    '--foreground',
    '-p',
    String(options.port),
    ...(options.strictPort ? ['--strict-port'] : []),
  ]
  const child = spawnDetachedServiceProcess({
    childArguments,
    logPath: options.logPath,
  })

  const pid = child.pid

  if (!pid) {
    throw new Error(
      '后台服务进程创建失败：未能取得进程号。请改用 e2e_assistant start --foreground。',
    )
  }

  return {
    pid,
    waitForExit: () =>
      new Promise<number | null>((resolve) => {
        child.once('exit', (code) => resolve(code))
      }),
  }
}

interface ISpawnDetachedServiceProcessOptions {
  childArguments: string[]
  logPath: string
}

/**
 * 以脱离终端的方式派生服务子进程（M1/M4 的形态要求集中在此）。
 *
 * @param options - 子进程参数与日志路径。
 * @returns 子进程句柄（已 unref，可让父进程先行退出）。
 * @throws Error 当日志文件无法打开或进程无法创建时抛出。
 */
function spawnDetachedServiceProcess (
  options: ISpawnDetachedServiceProcessOptions,
): ChildProcess {
  // Windows：日志由 VBS 内的 cmd 重定向写入，这里必须**完全不持有**日志文件句柄——
  // 实测：把日志 fd 作为 wscript 的 stdio 传下去后，cmd 的 `>>` 追加打开会被
  // Windows 文件共享规则拒绝，子进程以退出码 1 结束且什么都不写。
  if (process.platform === 'win32') {
    const invocation = buildHiddenLaunchInvocation({
      scriptPath: getHiddenLaunchScriptPath(),
      logPath: options.logPath,
      command: process.execPath,
      args: options.childArguments,
    })
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, [SERVICE_MODE_ENV_VAR]: 'background' },
    })

    // unref：让父进程可以退出而不等待子进程（Windows 上文档化行为）。
    child.unref()
    return child
  }

  // 0600：日志可能含工作区路径与接口调用，与 runtime.json 同一保密级别。
  // 目录已是 0700，这里再收紧一层（POSIX 生效；Windows 由 ACL 处理）。
  const logFileDescriptor = openSync(options.logPath, 'a', 0o600)

  try {
    const child = spawn(process.execPath, options.childArguments, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFileDescriptor, logFileDescriptor],
      env: { ...process.env, [SERVICE_MODE_ENV_VAR]: 'background' },
    })

    // unref：让父进程可以退出而不等待子进程。
    // 与 detached 合起来，POSIX 上还有一层语义：子进程自成一进程组/会话，
    // 终端里的 Ctrl+C（发给前台进程组）不会波及服务——这正是「`log -f` 跟随中
    // Ctrl+C 只结束 log 命令」与「关掉终端后服务仍在」在 macOS/Linux 上的机制。
    child.unref()
    return child
  } finally {
    // 父进程不再需要该 fd：子进程已持有自己的副本。
    closeSync(logFileDescriptor)
  }
}

/**
 * 通过信号结束指定进程。
 *
 * @param pid - 目标进程号。
 * @returns 成功发出结束信号返回 true；进程已不存在或无权限时返回 false。
 * @throws 不抛出异常，失败会被转换为 false。
 */
function terminateProcessBySignal (pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

function sleep (durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function formatErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 处理本地 CLI 服务的启动命令，并在开发模式下保持端口严格一致。
 *
 * v19 起本命令是**分派器**：默认走后台启动器（派生独立服务进程、快速返回），
 * `--foreground` 走与今天完全一致的进程内启动（日志刷终端、Ctrl+C 退出）。
 * `web` 命令继续转调本命令，两者保持等价。
 */
import { startPlatformService } from '../application/service-lifecycle'
import { launchBackgroundService } from '../application/background-service-launcher'
import { openBrowserQuietly } from './shared/open-browser-quietly'
import { renderStartPanel } from '../presentation/console/start-panel'
import { getCliPackageVersion } from '../infrastructure/cli-package-version'

/**
 * 定义启动本地服务所需的命令行参数。
 */
export interface IStartCommandOptions {
  port: string
  open?: boolean
  strictPort?: boolean
  /**
   * 前台模式（`-f` / `--foreground`）：行为与今天的 `start` 完全一致。
   *
   * `cac` 的 `--foreground` 与内部派生用的同名选项共用此字段——两者含义相同
   * （别再去派生孙子进程），区别只在 stdio 与记录中的 mode。
   */
  foreground?: boolean
}

/**
 * 根据命令参数启动本地 CLI 服务，并输出可访问地址。
 * @param options 启动参数，包含端口、是否自动打开浏览器、严格端口模式与前台模式。
 * @returns 服务已启动或复用运行中服务时无返回值。
 * @throws 当端口无效、严格模式下端口冲突、日志目录不可写或服务启动失败时抛出异常。
 */
export async function handleStartCommand(
  options: IStartCommandOptions,
): Promise<void> {
  const port = Number(options.port)
  const shouldOpen = options.open !== false

  if (options.foreground === true) {
    await startForegroundService({ port, options })
    return
  }

  await startBackgroundService({ port, options, shouldOpen })
}

interface IStartForegroundServiceOptions {
  port: number
  options: IStartCommandOptions
}

/**
 * 前台启动：服务跑在当前进程内，日志刷终端、Ctrl+C 退出、不落盘日志。
 *
 * @param input - 端口与原始命令选项。
 * @returns 服务启动或复用后无返回值。
 * @throws 端口冲突、探测无法确认或服务启动失败时抛出。
 */
async function startForegroundService(
  input: IStartForegroundServiceOptions,
): Promise<void> {
  const { port, options } = input
  // 不硬编码 mode：由 startPlatformService 读环境变量判定。用户敲的
  // `--foreground` 与启动器派生子进程用的 `--foreground` 共用本路径——
  // 后者的环境里带着后台标记，mode 因此记为 background（§3.2）。
  const startedService = await startPlatformService({
    port,
    strictPort: options.strictPort,
  })

  // 浏览器打开失败不必阻断启动，也不额外打印：面板已包含可点击的地址字段。
  if (options.open !== false) {
    await openBrowserQuietly(startedService.serverUrl)
  }

  // 后台子进程不打印面向用户的面板。
  //
  // 它走的正是这条路径（启动器派生子进程时命令行带 `--foreground`，含义是
  // 「别再去派生孙子进程」），但它的 stdout 已被重定向到日志文件——在那里输出
  // 「启动成功」「怎么看日志」既不是服务日志，也没人看得见；而真正要看这份
  // 面板的用户由启动器所在进程负责呈现，两者会重复。
  //
  // 判据用 `mode` 而非命令行参数：`mode` 是「本进程是不是后台子进程」的既有
  // 权威来源（由启动器通过环境变量标记，见 service-mode.ts），用户手敲的
  // `--foreground` 读到的仍是 foreground，照常打印。
  if (startedService.mode === 'background') {
    return
  }

  printServiceOutcome({ startedService })
}

interface IStartBackgroundServiceCommandOptions {
  port: number
  options: IStartCommandOptions
  shouldOpen: boolean
}

/**
 * 后台启动：派生独立服务进程并等待就绪，命令自身快速返回。
 *
 * @param input - 端口、原始命令选项与是否打开浏览器。
 * @returns 服务就绪或复用后无返回值。
 * @throws 日志目录不可写、就绪超时或状态无法确认时抛出。
 */
async function startBackgroundService(
  input: IStartBackgroundServiceCommandOptions,
): Promise<void> {
  const { port, options, shouldOpen } = input
  const launchedService = await launchBackgroundService({
    port,
    strictPort: options.strictPort,
    shouldOpen,
  })

  // 浏览器由启动器打开：复用分支也要打开，两条分支共用这里一处。
  if (shouldOpen) {
    await openBrowserQuietly(launchedService.serverUrl)
  }

  printServiceOutcome({
    startedService: {
      outcome: launchedService.outcome,
      port: launchedService.port,
      serverUrl: launchedService.serverUrl,
      pid: launchedService.pid,
      startedAt: launchedService.startedAt,
      mode: 'background',
      logPath: launchedService.logPath,
      shellProbe: launchedService.shellProbe,
      ...(launchedService.logRotationFailureReason
        ? { logRotationFailureReason: launchedService.logRotationFailureReason }
        : {}),
    },
  })
}

interface IPrintServiceOutcomeOptions {
  startedService: Awaited<ReturnType<typeof startPlatformService>> & {
    /** 后台日志路径；仅后台模式提供。 */
    logPath?: string
    /** 日志轮转失败的原因；未失败时不带该字段。 */
    logRotationFailureReason?: string
  }
}

/**
 * 打印启动结果面板（冷启动 / 覆盖陈旧记录 / 复用，前台与后台共用）。
 *
 * 内容装配在 presentation/console/start-panel.ts；本函数只负责把结果翻译成
 * 面板输入并输出。
 *
 * @param input - 服务启动结果。
 * @returns 打印完成后无返回值。
 * @throws 不抛出异常。
 */
function printServiceOutcome(input: IPrintServiceOutcomeOptions): void {
  const { startedService } = input

  process.stdout.write(
    renderStartPanel({
      outcome: startedService.outcome,
      mode: startedService.mode,
      serverUrl: startedService.serverUrl,
      port: startedService.port,
      pid: startedService.pid,
      startedAt: startedService.startedAt,
      cliVersion: getCliPackageVersion(),
      ...(startedService.logPath ? { logPath: startedService.logPath } : {}),
      ...(startedService.shellProbe
        ? { shellProbe: startedService.shellProbe }
        : {}),
      ...(startedService.logRotationFailureReason
        ? {
            logRotationFailureReason: startedService.logRotationFailureReason,
          }
        : {}),
    }),
  )
}

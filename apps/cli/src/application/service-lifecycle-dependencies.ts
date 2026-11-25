/**
 * 服务启停编排的共享契约：结果类型、依赖集合与默认实现。
 *
 * 为什么单独一份：启停两条链路（service-lifecycle / service-stop）都要用这些
 * 定义，而它们**不得互相 import**（会成环）。把共享部分放在这里，
 * 依赖方向就是单一的两条边：启 → 共享，停 → 共享。
 */
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import {
  startLocalServer,
  type TStartLocalServer,
} from '@authine-e2e-agent/service'
import { probeBashShell, resolveBashShellPath } from './bash-shell-check'
import { ensurePlatformConfigStorage } from './platform-config-storage'
import {
  clearPlatformRuntimeState,
  inspectPlatformRuntimeState,
  isPlatformProcessAlive,
  savePlatformRuntimeState,
} from '../infrastructure/config/runtime-store'
import { probeLocalService } from '../infrastructure/http/service-probe'
import type { TServiceMode } from '../infrastructure/service-mode'
import type { TBashShellProbe } from './bash-shell-check'
import { requestServiceShutdown } from './service-shutdown-request'

/** 等待被结束进程退出的默认超时与轮询间隔。 */
export const PROCESS_EXIT_TIMEOUT_MS = 5000
export const PROCESS_EXIT_INTERVAL_MS = 200
/**
 * 优雅关闭路径等待进程退出的上限（§4.4 决策表：10 秒）。
 *
 * 比信号路径长是必须的：服务收到端点请求后要自行走完关闭序列——中止在跑任务
 * （本身最多 5 秒）→ 关浏览器 → 释放运行时，5 秒会在「有任务在跑」时必然超时，
 * 让一次正常的优雅关闭被报成失败。
 */
export const GRACEFUL_EXIT_TIMEOUT_MS = 10_000
/** 关闭端点够不着时，先等服务自行退出的观察窗口（§4.4）。 */
export const SHUTDOWN_SELF_EXIT_WAIT_MS = 3000

/**
 * 服务启动结果。
 *
 * - `reused`：已确认同版本服务在运行，直接复用，未启动新进程；
 * - `started`：正常启动了新服务；
 * - `started-after-stale-record`：启动前发现陈旧记录（服务已消失），已启动新服务并覆盖记录。
 */
export interface IStartPlatformServiceResult {
  outcome: 'reused' | 'started' | 'started-after-stale-record'
  port: number
  serverUrl: string
  /** 服务进程号（供命令层展示）；复用分支取自运行态记录。 */
  pid: number
  /** 服务启动时刻，ISO 8601（供命令层展示）。 */
  startedAt: string
  /** 运行形态；前台模式的日志不落盘，命令层据此决定是否展示日志路径。 */
  mode: TServiceMode
  /**
   * bash 探测结果；仅新启动时有值（复用分支不重新探测）。
   *
   * 命令层据此提示「bash 工具是否可用」——探测本身不打印（见
   * bash-shell-check.ts 的文件头说明）。
   */
  shellProbe?: TBashShellProbe
}

export interface IStopPlatformServiceResult {
  stopped: boolean
  alreadyStopped: boolean
  message: string
  serverUrl: string
  /**
   * 被停止服务的进程号与启动时刻（供命令层展示）。
   *
   * 可选：记录缺失或损坏的分支拿不到这两个值，命令层据此**不渲染**对应行，
   * 而不是补一个占位值——那会让用户以为查到了一条真实记录。
   */
  pid?: number
  startedAt?: string
  port?: number
}

/**
 * 服务生命周期依赖集合。
 *
 * 生产环境使用默认实现；测试通过传入替身覆盖，避免触达真实进程、端口与网络。
 */
export interface IServiceLifecycleDependencies {
  probeLocalService: typeof probeLocalService
  startLocalServer: TStartLocalServer
  inspectPlatformRuntimeState: typeof inspectPlatformRuntimeState
  savePlatformRuntimeState: typeof savePlatformRuntimeState
  clearPlatformRuntimeState: typeof clearPlatformRuntimeState
  isPlatformProcessAlive: typeof isPlatformProcessAlive
  resolveBashShellPath: typeof resolveBashShellPath
  /** bash 探测；返回结构化结果供命令层提示（探测本身不打印）。 */
  probeBashShell: typeof probeBashShell
  ensurePlatformConfigStorage: typeof ensurePlatformConfigStorage
  /** 结束指定进程；返回 false 表示无法结束（进程已不存在或无权限）。 */
  terminateProcess: (pid: number) => boolean
  /**
   * 信号送达后，目标进程能否执行自身的收尾逻辑。
   *
   * Windows 上 `process.kill(pid, 'SIGTERM')` 走 TerminateProcess——目标进程的
   * 信号处理器根本不执行，因此回退信号时不会发生服务侧清理；POSIX 上 SIGTERM
   * 可被捕获，服务会走与关闭端点相同的优雅序列。回退文案必须据此区分（§4.4 S4）。
   */
  canSignalTriggerGracefulShutdown: () => boolean
  /** 生成优雅关闭的一次性凭据；测试注入固定值以便断言。 */
  generateShutdownToken: () => string
  /**
   * 请求服务优雅关闭；测试注入替身以覆盖 stop 的五种决策分支。
   * 缺省为对端点的真实请求（见 service-shutdown-request.ts）。
   */
  requestServiceShutdown: typeof requestServiceShutdown
  /** 注册进程退出清理钩子；测试注入空实现以避免累积 SIGINT/SIGTERM 监听。 */
  registerShutdownHandlers: (options: {
    closeServer: () => Promise<void>
    /** 关闭例行程序；信号处理器调用它（与关闭端点共用同一条序列）。 */
    shutdown: (exitCode: number) => void
  }) => void
  /** 等待进程退出的超时时间（毫秒）；信号路径使用。 */
  processExitTimeoutMs: number
  /** 优雅关闭路径等待进程退出的上限（毫秒）；须覆盖服务侧的完整关闭序列。 */
  gracefulExitTimeoutMs: number
  /** 等待进程退出的轮询间隔（毫秒）。 */
  processExitIntervalMs: number
  /** 关闭端点够不着时，先等服务自行退出的观察窗口（毫秒，§4.4）。 */
  shutdownSelfExitWaitMs: number
  /** 结束当前进程；注入以便测试断言关闭例程真的走到了退出这一步。 */
  exitProcess: (exitCode: number) => void
}

/**
 * 构造生产环境使用的默认依赖集合。
 *
 * @param overrides 需要覆盖的依赖项。
 * @returns 合并后的依赖集合。
 * @throws 不抛出异常。
 */
export function createServiceLifecycleDependencies(
  overrides: Partial<IServiceLifecycleDependencies> = {},
): IServiceLifecycleDependencies {
  return {
    probeLocalService,
    startLocalServer,
    inspectPlatformRuntimeState,
    savePlatformRuntimeState,
    clearPlatformRuntimeState,
    isPlatformProcessAlive,
    resolveBashShellPath,
    probeBashShell,
    ensurePlatformConfigStorage,
    terminateProcess: terminateProcessBySignal,
    canSignalTriggerGracefulShutdown: isSignalGracefulOnCurrentPlatform,
    generateShutdownToken,
    requestServiceShutdown,
    registerShutdownHandlers,
    processExitTimeoutMs: PROCESS_EXIT_TIMEOUT_MS,
    gracefulExitTimeoutMs: GRACEFUL_EXIT_TIMEOUT_MS,
    processExitIntervalMs: PROCESS_EXIT_INTERVAL_MS,
    shutdownSelfExitWaitMs: SHUTDOWN_SELF_EXIT_WAIT_MS,
    exitProcess: (exitCode) => process.exit(exitCode),
    ...overrides,
  }
}

interface IRegisterShutdownHandlersOptions {
  closeServer: () => Promise<void>
  /** 关闭例行程序；由调用方创建，信号处理器与关闭端点共用同一实例。 */
  shutdown: (exitCode: number) => void
}

/**
 * 注册 SIGINT / SIGTERM 处理：走与关闭端点**同一个**关闭例行程序。
 *
 * 语义与今天一致：`closeServer → 清理运行态记录 → process.exit(code)`。
 * `closeServer` 现在是优雅序列（中止任务 → 关浏览器 → 强关连接），
 * 因此 Ctrl+C 有 SSE 连接时也能在数秒内退出（修 F4/F5）。
 */
function registerShutdownHandlers(
  options: IRegisterShutdownHandlersOptions,
): void {
  process.once('SIGINT', () => options.shutdown(0))
  process.once('SIGTERM', () => options.shutdown(0))
}

/**
 * 生成优雅关闭的一次性凭据。
 *
 * 使用密码学随机数：它决定了「谁有权关掉服务」，与运行时记录同处 0600 的
 * 信任边界内，但不能是可预测的值。
 *
 * @returns 随机凭据字符串。
 * @throws 不抛出异常。
 */
function generateShutdownToken(): string {
  return randomUUID()
}

/**
 * 判断当前平台上「发 SIGTERM」能否让目标进程执行自身的收尾逻辑。
 *
 * Windows 不使用 POSIX 信号：Node 的 `process.kill(pid, 'SIGTERM')` 直接调
 * TerminateProcess，目标的信号处理器不会运行（实测 M2）。macOS / Linux 上
 * SIGTERM 可被捕获，服务会走与关闭端点相同的优雅序列。
 *
 * @param platform 平台标识；缺省读 `process.platform`，测试可注入。
 * @returns 信号能触发服务侧清理时返回 true。
 * @throws 不抛出异常。
 */
export function isSignalGracefulOnCurrentPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32'
}

/**
 * 通过信号结束指定进程。
 *
 * @param pid 目标进程号。
 * @returns 成功发出结束信号返回 true；进程已不存在或无权限时返回 false。
 * @throws 不抛出异常，失败会被转换为 false。
 */
function terminateProcessBySignal(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

/**
 * 停止服务时的「动手」决策表（v19 §4.4）。
 *
 * 与 service-lifecycle 的分工：那边负责**判定与安全性质**（三态确认、拒绝结束
 * 自身、无法确认不清理），本模块只在「已确认服务正在运行」之后决定用哪种方式
 * 结束它——优先请求优雅关闭端点，端点不可用时回退信号，并如实告知回退原因。
 *
 * 为什么单独一个文件：「端点 → 信号」是一个完整的小决策表（五种分支），
 * 与启动链路没有共享状态；放在同一文件会让启停两件事混在一起。
 */
import type { IPlatformRuntimeState } from '../infrastructure/config/runtime-store'
import type {
  IServiceLifecycleDependencies,
  IStopPlatformServiceResult,
} from './service-lifecycle-dependencies'

interface IStopActiveServiceOptions {
  dependencies: IServiceLifecycleDependencies
  runtimeState: IPlatformRuntimeState
}

/**
 * 停止已确认身份的服务：优先走优雅关闭端点，端点不可用时回退信号。
 *
 * 决策表逐条对应 PRD §4.4 S2–S4。
 *
 * @param options - 依赖集合与运行态记录。
 * @returns 停止结果。
 * @throws 不抛出异常；回退路径的失败被转换为带说明的结果。
 */
export async function stopActiveService(
  options: IStopActiveServiceOptions,
): Promise<IStopPlatformServiceResult> {
  const { dependencies, runtimeState } = options

  // 记录无凭据（旧版本服务写入的记录）：直接走既有信号路径，文案不变。
  if (!runtimeState.shutdownToken) {
    return await stopBySignalWithFallbackNote({
      dependencies,
      runtimeState,
      fallbackReason: null,
    })
  }

  const outcome = await dependencies.requestServiceShutdown({
    serverUrl: runtimeState.serverUrl,
    token: runtimeState.shutdownToken,
  })

  switch (outcome) {
    case 'accepted':
      return await waitForServiceExit({
        dependencies,
        runtimeState,
        successMessage: 'Authine E2E Agent Platform 服务已优雅停止。',
        // 10 秒上限：要覆盖服务侧「中止在跑任务（≤5s）→ 关浏览器 → 释放」全序列。
        timeoutMs: dependencies.gracefulExitTimeoutMs,
      })

    case 'unsupported':
      return await stopBySignalWithFallbackNote({
        dependencies,
        runtimeState,
        fallbackReason: buildUnsupportedFallbackNote(dependencies),
      })

    case 'rejected':
      return await stopBySignalWithFallbackNote({
        dependencies,
        runtimeState,
        fallbackReason:
          '关闭凭据不匹配（运行态记录可能已被替换），已退回强制结束方式。',
      })

    case 'unreachable':
      // 端点够不着：服务可能已在自行收尾（或根本没在监听）。
      // 先给它一个短暂的观察窗口，未退出再回退信号。
      return await stopAfterUnreachable({ dependencies, runtimeState })
  }
}

interface IStopBySignalOptions {
  dependencies: IServiceLifecycleDependencies
  runtimeState: IPlatformRuntimeState
  /** 回退原因；null 表示「本就走信号路径」（旧记录），无需提示回退。 */
  fallbackReason: string | null
}

/**
 * 以信号方式结束服务并等待退出。
 *
 * @param options - 依赖集合、运行态记录与回退原因。
 * @returns 停止结果；有回退原因时在成功文案中附加说明。
 * @throws 不抛出异常。
 */
async function stopBySignalWithFallbackNote(
  options: IStopBySignalOptions,
): Promise<IStopPlatformServiceResult> {
  const { dependencies, runtimeState, fallbackReason } = options

  if (!dependencies.terminateProcess(runtimeState.pid)) {
    // 进程在探测通过后恰好退出：按已停止处理，记录仍需清理。
    await dependencies.clearPlatformRuntimeState()
    return buildAlreadyStoppedResult(
      runtimeState.serverUrl,
      '服务进程已经结束，已自动清理运行态记录。',
      runtimeState,
    )
  }

  const exitResult = await waitForServiceExit({ dependencies, runtimeState })

  if (!fallbackReason || !exitResult.stopped) {
    return exitResult
  }

  return { ...exitResult, message: `${fallbackReason} ${exitResult.message}` }
}

interface IStopAfterUnreachableOptions {
  dependencies: IServiceLifecycleDependencies
  runtimeState: IPlatformRuntimeState
}

/**
 * 端点够不着时的处置：先等一小段时间看服务是否自行退出，未退出则回退信号。
 *
 * @param options - 依赖集合与运行态记录。
 * @returns 停止结果。
 * @throws 不抛出异常。
 */
async function stopAfterUnreachable(
  options: IStopAfterUnreachableOptions,
): Promise<IStopPlatformServiceResult> {
  const { dependencies, runtimeState } = options
  const hasExitedOnItsOwn = await waitForProcessExit({
    pid: runtimeState.pid,
    timeoutMs: dependencies.shutdownSelfExitWaitMs,
    intervalMs: dependencies.processExitIntervalMs,
    isProcessAlive: dependencies.isPlatformProcessAlive,
  })

  if (hasExitedOnItsOwn) {
    await dependencies.clearPlatformRuntimeState()
    return {
      stopped: true,
      alreadyStopped: false,
      message: '服务已自行退出（未等到端点应答），运行态记录已清理。',
      serverUrl: runtimeState.serverUrl,
      ...extractRuntimeDisplayFields(runtimeState),
    }
  }

  return await stopBySignalWithFallbackNote({
    dependencies,
    runtimeState,
    fallbackReason: buildUnreachableFallbackNote(dependencies),
  })
}

/**
 * 构造「服务不支持优雅关闭」的回退说明。
 *
 * 差异只在平台语义：Windows 上信号是硬杀（不执行服务侧清理），POSIX 上
 * SIGTERM 可被捕获、服务会走同一条优雅序列。说反了会让用户误以为资源已被
 * 释放（或反之以为没释放），因此按平台分别表述。
 *
 * @param dependencies - 依赖集合（提供平台判定）。
 * @returns 面向用户的回退说明。
 * @throws 不抛出异常。
 */
function buildUnsupportedFallbackNote(
  dependencies: IServiceLifecycleDependencies,
): string {
  if (dependencies.canSignalTriggerGracefulShutdown()) {
    return '该服务版本不支持优雅关闭端点，已改用信号请求停止（服务会执行自身的收尾流程）。'
  }

  return '该服务版本不支持优雅关闭，已退回强制结束方式（Windows 上不会执行服务侧清理）。'
}

/**
 * 构造「关闭端点无响应」的回退说明（平台语义同上）。
 *
 * @param dependencies - 依赖集合（提供平台判定）。
 * @returns 面向用户的回退说明。
 * @throws 不抛出异常。
 */
function buildUnreachableFallbackNote(
  dependencies: IServiceLifecycleDependencies,
): string {
  if (dependencies.canSignalTriggerGracefulShutdown()) {
    return '关闭端点无响应，已改用信号请求停止（服务会执行自身的收尾流程）。'
  }

  return '关闭端点无响应，已退回强制结束方式（Windows 上不会执行服务侧清理）。'
}

interface IWaitForServiceExitOptions {
  dependencies: IServiceLifecycleDependencies
  runtimeState: IPlatformRuntimeState
  /** 成功文案；缺省为既有文案（信号路径与端点路径的措辞不同）。 */
  successMessage?: string
  /** 等待上限；缺省用信号路径的 5 秒（端点路径传更长的值覆盖关闭序列）。 */
  timeoutMs?: number
}

/**
 * 等待被结束的服务进程退出，并在确认退出后清理记录。
 *
 * 进程未能退出时保留记录，避免丢失仍可能存活服务的可管理性。
 *
 * @param options 依赖集合与运行态记录。
 * @returns 停止结果。
 * @throws 不抛出异常，超时会被转换为失败结果。
 */
async function waitForServiceExit(
  options: IWaitForServiceExitOptions,
): Promise<IStopPlatformServiceResult> {
  const { dependencies, runtimeState } = options
  const hasExited = await waitForProcessExit({
    pid: runtimeState.pid,
    timeoutMs: options.timeoutMs ?? dependencies.processExitTimeoutMs,
    intervalMs: dependencies.processExitIntervalMs,
    isProcessAlive: dependencies.isPlatformProcessAlive,
  })

  if (!hasExited) {
    return {
      stopped: false,
      alreadyStopped: false,
      message: '停止服务超时，运行态记录已保留，请稍后重试或手动检查进程状态。',
      serverUrl: runtimeState.serverUrl,
      ...extractRuntimeDisplayFields(runtimeState),
    }
  }

  await dependencies.clearPlatformRuntimeState()

  return {
    stopped: true,
    alreadyStopped: false,
    message:
      options.successMessage ?? 'Authine E2E Agent Platform 服务已停止。',
    serverUrl: runtimeState.serverUrl,
    ...extractRuntimeDisplayFields(runtimeState),
  }
}

/**
 * 从运行态记录提取供命令层展示的字段。
 *
 * 单独抽出是为了让各分支的返回对象形状一致：展示字段永远来自同一处，
 * 不因分支不同而漂移。
 *
 * @param runtimeState - 运行态记录。
 * @returns 含进程号、启动时刻与端口的部分结果。
 * @throws 不抛出异常。
 */
function extractRuntimeDisplayFields(runtimeState: IPlatformRuntimeState): {
  pid: number
  startedAt: string
  port: number
} {
  return {
    pid: runtimeState.pid,
    startedAt: runtimeState.startedAt,
    port: runtimeState.port,
  }
}

interface IWaitForProcessExitOptions {
  pid: number
  timeoutMs: number
  intervalMs: number
  isProcessAlive: (pid: number) => boolean
}

/**
 * 轮询等待进程退出。
 *
 * @param options - 目标进程号、超时、轮询间隔与存活判定。
 * @returns 进程已退出返回 true；超时仍在运行返回 false。
 * @throws 不抛出异常。
 */
async function waitForProcessExit(
  options: IWaitForProcessExitOptions,
): Promise<boolean> {
  const deadlineTime = Date.now() + options.timeoutMs

  while (Date.now() <= deadlineTime) {
    if (!options.isProcessAlive(options.pid)) {
      return true
    }

    await sleep(options.intervalMs)
  }

  return !options.isProcessAlive(options.pid)
}

/**
 * 构造「无需停止」的结果。
 *
 * @param serverUrl 记录中的服务地址；无记录时为空字符串。
 * @param message 面向用户的说明文案。
 * @param runtimeState 记录中的运行态；有则一并带出展示字段。
 * @returns 已停止状态的结果对象。
 * @throws 不抛出异常。
 */
function buildAlreadyStoppedResult(
  serverUrl: string,
  message: string,
  runtimeState?: IPlatformRuntimeState,
): IStopPlatformServiceResult {
  return {
    stopped: false,
    alreadyStopped: true,
    message,
    serverUrl,
    ...(runtimeState ? extractRuntimeDisplayFields(runtimeState) : {}),
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

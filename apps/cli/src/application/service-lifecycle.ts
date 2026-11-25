/**
 * 编排本地 CLI 服务的启动与停止。
 *
 * 「服务是否在运行」一律通过健康探测确认身份（见 service-identity.ts），
 * 不再仅凭运行态记录中的 PID 判断——PID 会被操作系统回收给无关进程。
 *
 * 所有副作用都以可注入依赖的形式暴露，便于测试覆盖各条分支而无需真实进程/端口。
 *
 * 文件分工：本文件负责**启动链路**与停止命令的安全判定（三态确认、拒绝结束
 * 自身）；「确认在运行之后怎么结束它」的决策表在 service-stop.ts。
 */
import process from 'node:process'
import { registerWebStaticRoutes } from '@fynn90-e2e_assistant/web-host'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@fynn90-e2e_assistant/types'
import {
  readServiceModeFromEnv,
  type TServiceMode,
} from '../infrastructure/service-mode'
import { requestServiceShutdown } from './service-shutdown-request'
import { createShutdownRoutine } from './shutdown-routine'
import { stopActiveService } from './service-stop'
import {
  resolveServiceState,
  type TServiceResolution,
} from './service-identity'
import {
  createServiceLifecycleDependencies,
  type IServiceLifecycleDependencies,
  type IStartPlatformServiceResult,
  type IStopPlatformServiceResult,
} from './service-lifecycle-dependencies'
import type { IPlatformRuntimeState } from '../infrastructure/config/runtime-store'

// 共享契约从本模块继续对外暴露：既有调用方（命令层、测试）只认这个路径。
export {
  createServiceLifecycleDependencies,
  PROCESS_EXIT_INTERVAL_MS,
  PROCESS_EXIT_TIMEOUT_MS,
  SHUTDOWN_SELF_EXIT_WAIT_MS,
  type IServiceLifecycleDependencies,
  type IStartPlatformServiceResult,
  type IStopPlatformServiceResult,
} from './service-lifecycle-dependencies'

interface IStartPlatformServiceOptions {
  port: number
  strictPort?: boolean
  /**
   * 运行形态（v19）。缺省读环境变量——后台子进程由启动器打标记，
   * 前台启动不设置即前台；测试可直接注入。
   */
  mode?: TServiceMode
}

/**
 * 启动本地服务；若已确认同版本服务在运行则复用。
 *
 * @param options 启动参数，包含目标端口与严格端口模式。
 * @param overrides 可选的依赖覆盖项，用于测试。
 * @returns 启动或复用结果。
 * @throws 当端口被非本服务占用、探测无法确认状态或服务启动失败时抛出异常。
 */
export async function startPlatformService (
  options: IStartPlatformServiceOptions,
  overrides: Partial<IServiceLifecycleDependencies> = {},
): Promise<IStartPlatformServiceResult> {
  const dependencies = createServiceLifecycleDependencies(overrides)

  await dependencies.ensurePlatformConfigStorage()

  const inspection = await dependencies.inspectPlatformRuntimeState()
  const resolution = await resolveServiceState({
    runtimeState: inspection.runtimeState,
    isRecordInvalid: inspection.state === 'invalid',
    probe: dependencies.probeLocalService,
  })

  const reusedResult = buildReusedResult({ resolution, options })

  if (reusedResult) {
    return reusedResult
  }

  assertServiceStateAllowsStart(resolution)

  return await startNewService({
    dependencies,
    options,
    // 记录存在（present 或 invalid）但已判定服务消失时，提示用户忽略了陈旧记录。
    wasStaleRecord:
      resolution.state === 'absent' && inspection.state !== 'missing',
  })
}

interface IBuildReusedResultOptions {
  resolution: TServiceResolution
  options: IStartPlatformServiceOptions
}

/**
 * 在服务已被确认运行时，构造复用结果；否则返回 null 表示需要启动新服务。
 *
 * @param options 服务状态判定结果与启动参数。
 * @returns 复用结果；服务未在运行时返回 null。
 * @throws 当运行中的服务协议版本不匹配，或严格模式要求端口一致但运行中的服务使用了其他端口时抛出异常。
 */
function buildReusedResult (
  options: IBuildReusedResultOptions,
): IStartPlatformServiceResult | null {
  const { resolution, options: startOptions } = options

  if (resolution.state !== 'active') {
    return null
  }

  const activePort = resolution.runtimeState.port

  // 版本不匹配时必须报错而不是复用：复用会让 Web 端在后续请求上撞到协议错误，
  // 表现为与「服务未启动」同样费解的故障。
  if (resolution.version !== LOCAL_SERVICE_PROTOCOL_VERSION) {
    throw new Error(
      `检测到端口 ${activePort} 上运行着协议版本 v${resolution.version} 的 CLI 服务，当前版本要求 v${LOCAL_SERVICE_PROTOCOL_VERSION}。请执行 e2e_assistant stop 后重新启动。`,
    )
  }

  if (startOptions.strictPort && activePort !== startOptions.port) {
    throw new Error(
      `检测到 CLI 服务已运行在端口 ${activePort}，当前开发配置要求端口 ${startOptions.port}。请执行 e2e_assistant stop，或设置 AUTHINE_CLI_PORT=${activePort} 后重试。`,
    )
  }

  return {
    outcome: 'reused',
    port: activePort,
    serverUrl: resolution.runtimeState.serverUrl,
    pid: resolution.runtimeState.pid,
    startedAt: resolution.runtimeState.startedAt,
    mode: resolution.runtimeState.mode,
  }
}

/**
 * 校验当前状态是否允许启动新服务。
 *
 * 无法确认状态的记录绝不被清理，也不允许启动新服务：端口已被占用，
 * 强行启动会让新实例顺延端口并覆盖记录，使仍可能存活的服务失去可管理性。
 *
 * @param resolution 服务状态判定结果。
 * @returns 允许启动时无返回值。
 * @throws 当状态无法确认时抛出带有处理建议的异常。
 */
function assertServiceStateAllowsStart (resolution: TServiceResolution): void {
  if (resolution.state === 'unknown') {
    throw new Error(
      `${resolution.detail} 请先确认该端口上的服务，必要时手动结束它后再重试。`,
    )
  }
}

interface IStartNewServiceOptions {
  dependencies: IServiceLifecycleDependencies
  options: IStartPlatformServiceOptions
  wasStaleRecord: boolean
}

/**
 * 启动新服务并持久化运行态记录。
 *
 * 不在启动前清理陈旧记录：严格端口模式下若端口随后被判定占用而抛错，
 * 预先清理会造成「记录已删但服务未启动」，使 `e2e_assistant stop` 误报没有运行中的服务。
 * 记录的替换交给写入时的原子覆盖完成。
 *
 * @param options 依赖集合、启动参数与是否存在陈旧记录的标记。
 * @returns 启动结果。
 * @throws 当端口不可用或运行态记录写入失败时抛出异常。
 */
async function startNewService (
  options: IStartNewServiceOptions,
): Promise<IStartPlatformServiceResult> {
  const { dependencies, options: startOptions, wasStaleRecord } = options
  const mode = startOptions.mode ?? readServiceModeFromEnv()
  // 启动阶段探测 bash.exe 并作为显式路径注入 agent 运行时：
  // 探测失败只把结果带出去由命令层提示，bash 工具运行期返回不可用错误，
  // 不阻断启动（探测本身不打印，见 bash-shell-check.ts 的文件头说明）。
  const shellProbe = dependencies.probeBashShell()
  const shellPath = shellProbe.outcome === 'found' ? shellProbe.path : undefined
  // 一次性关闭凭据：服务端据此校验关闭请求，随 0600 的记录一起保存。
  const shutdownToken = dependencies.generateShutdownToken()
  const startedServer = await dependencies.startLocalServer({
    port: startOptions.port,
    strictPort: startOptions.strictPort,
    shellPath,
    shutdownToken,
    // 前端资源由 CLI 挂载：服务层保持为纯 API 服务（不依赖任何前端包），
    // 「页面从哪来」是客户端形态的自由。挂载点在全部 API 路由之后。
    extendApp: registerWebStaticRoutes,
  })
  // 记录里的启动时刻同时用于展示，因此先生成再落盘，避免两处取到不同的时间。
  const startedAt = new Date().toISOString()

  try {
    await dependencies.savePlatformRuntimeState({
      pid: process.pid,
      port: startedServer.port,
      serverUrl: startedServer.serverUrl,
      startedAt,
      mode,
      shutdownToken,
    })
  } catch (error) {
    await startedServer.closeServer()
    throw error
  }

  // 关闭例行程序：SIGINT / SIGTERM / 关闭端点共用同一条序列（§1.3）。
  const shutdown = createShutdownRoutine({
    closeServer: startedServer.closeServer,
    clearRuntimeState: dependencies.clearPlatformRuntimeState,
    exitProcess: dependencies.exitProcess,
  })

  dependencies.registerShutdownHandlers({
    closeServer: startedServer.closeServer,
    shutdown,
  })
  // 端点请求关闭：宿主（本进程）执行收尾与退出——服务层只通知，不碰进程（C3）。
  startedServer.registerShutdownRequestHandler(() => shutdown(0))

  return {
    outcome: wasStaleRecord ? 'started-after-stale-record' : 'started',
    port: startedServer.port,
    serverUrl: startedServer.serverUrl,
    pid: process.pid,
    startedAt,
    mode,
    shellProbe,
  }
}

/**
 * 停止本地服务；仅在确认记录对应的服务正在运行时才结束进程。
 *
 * 既有安全性质逐字保留（§4.4 S5）：无法确认身份时不结束进程、不清理记录；
 * 记录指向当前进程时拒绝执行；损坏记录自动清理。「怎么结束」在 service-stop。
 *
 * @returns 停止结果，包含是否已停止与面向用户的说明文案。
 * @throws 当状态无法确认、清理记录失败或结束进程失败时抛出异常。
 */
export async function stopPlatformService (
  overrides: Partial<IServiceLifecycleDependencies> = {},
): Promise<IStopPlatformServiceResult> {
  const dependencies = createServiceLifecycleDependencies(overrides)
  const inspection = await dependencies.inspectPlatformRuntimeState()

  if (inspection.state === 'missing') {
    return buildAlreadyStoppedResult(
      '',
      '当前没有运行中的 Authine E2E Agent Platform 服务。',
    )
  }

  if (inspection.state === 'invalid') {
    await dependencies.clearPlatformRuntimeState()
    return buildAlreadyStoppedResult('', '检测到损坏的运行态记录，已自动清理。')
  }

  const runtimeState = inspection.runtimeState
  const resolution = await resolveServiceState({
    runtimeState,
    isRecordInvalid: false,
    probe: dependencies.probeLocalService,
  })

  // 无法确认状态时绝不结束进程、绝不清理记录：唯一安全的做法是保留现场并让用户处置。
  if (resolution.state === 'unknown') {
    throw new Error(
      `${resolution.detail} 为避免结束无关进程，未执行任何操作。请确认后手动处理。`,
    )
  }

  if (resolution.state === 'active') {
    assertNotSelf(runtimeState)

    return await stopActiveService({ dependencies, runtimeState })
  }

  await dependencies.clearPlatformRuntimeState()

  return buildAlreadyStoppedResult(
    runtimeState.serverUrl,
    '检测到陈旧的运行态记录，但该服务已不再运行，已自动清理，未结束任何进程。',
    runtimeState,
  )
}

/**
 * 构造「无需停止」的结果。
 *
 * @param serverUrl 记录中的服务地址；无记录时为空字符串。
 * @param message 面向用户的说明文案。
 * @param runtimeState 记录中的运行态；有则一并带出端口与进程号供展示。
 * @returns 已停止状态的结果对象。
 * @throws 不抛出异常。
 */
function buildAlreadyStoppedResult (
  serverUrl: string,
  message: string,
  runtimeState?: IPlatformRuntimeState,
): IStopPlatformServiceResult {
  return {
    stopped: false,
    alreadyStopped: true,
    message,
    serverUrl,
    ...(runtimeState
      ? {
        pid: runtimeState.pid,
        startedAt: runtimeState.startedAt,
        port: runtimeState.port,
      }
      : {}),
  }
}

/**
 * 拒绝结束当前进程自身。
 *
 * 记录可能被复制或手工编辑成当前进程号，直接结束会造成 CLI 自杀。
 *
 * @param runtimeState 待停止的运行态记录。
 * @returns 不是自身进程时无返回值。
 * @throws 当记录指向当前进程时抛出异常。
 */
function assertNotSelf (runtimeState: IPlatformRuntimeState): void {
  if (runtimeState.pid === process.pid) {
    throw new Error(
      '运行态记录指向当前进程，已拒绝执行停止操作以免结束 CLI 自身。',
    )
  }
}

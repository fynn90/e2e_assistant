/** 使用 npm 包自身的 Playwright CLI 检测并安装 Chromium，不依赖全局命令。 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
  IChromiumInstaller,
  IChromiumInstallProgress,
  IChromiumStatus,
} from '../contracts/chromium'
import type { ISensitiveDataRedactor } from '../contracts/observability'
import { PlaywrightEngineError } from '../contracts/errors'
import { createDefaultRedactor } from '../observability/redaction'
import {
  ChromiumDetector,
  type IChromiumDetectorOptions,
} from './chromium-detector'
import {
  InstallProcessError,
  inferInstallProgressPhase,
  runInstallProcess,
  type TInstallProcessSpawner,
  type TProcessTreeTerminator,
} from './install-process'

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1_000
let sharedInstallPromise: Promise<IChromiumStatus> | undefined

/**
 * Chromium 安装器的依赖注入配置。
 */
export interface IChromiumInstallerOptions extends IChromiumDetectorOptions {
  resolveCliPath?: () => string[]
  spawnProcess?: TInstallProcessSpawner
  terminateProcessTree?: TProcessTreeTerminator
  environment?: NodeJS.ProcessEnv
  redactor?: ISensitiveDataRedactor
}

/**
 * 使用 Playwright 自带 CLI 完成 Chromium 检测和安装。
 */
export class ChromiumInstaller implements IChromiumInstaller {
  private readonly detector: ChromiumDetector
  private readonly resolveCliPath: () => string[]
  private readonly spawnProcess?: TInstallProcessSpawner
  private readonly terminateProcessTree?: TProcessTreeTerminator
  private readonly environment: NodeJS.ProcessEnv
  private readonly redactor: ISensitiveDataRedactor

  /**
   * 创建 Chromium 安装器。
   *
   * @param options - 检测器、CLI 解析、进程和脱敏适配器。
   * @returns 可在 CLI、桌面应用或 CI 中使用的安装器。
   * @throws 不抛出异常；依赖问题在 detect/install 调用时结构化返回。
   */
  constructor(options: IChromiumInstallerOptions = {}) {
    this.detector = new ChromiumDetector(options)
    this.resolveCliPath = options.resolveCliPath ?? defaultResolveCliPath
    this.spawnProcess = options.spawnProcess
    this.terminateProcessTree = options.terminateProcessTree
    this.environment = { ...process.env, ...options.environment }
    this.redactor = options.redactor ?? createDefaultRedactor()
  }

  /**
   * 检测 Playwright Chromium 是否已经可以执行。
   *
   * @param options - 可选浏览器缓存路径提示。
   * @returns 当前 Chromium 状态。
   * @throws 不抛出异常；文件系统失败由 detector 转换为状态原因。
   */
  detect(options: { browsersPath?: string } = {}): Promise<IChromiumStatus> {
    return this.detector.detect(options)
  }

  /**
   * 通过当前 npm 包内的 Playwright CLI 安装 Chromium。
   *
   * @param options - 超时、取消、缓存路径和进度回调。
   * @returns 安装成功后的 Chromium 状态。
   * @throws 安装取消、超时、进程失败、CLI 定位失败或最终检测失败时抛出结构化错误。
   */
  install(
    options: Parameters<IChromiumInstaller['install']>[0] = {},
  ): Promise<IChromiumStatus> {
    if (sharedInstallPromise) {
      return sharedInstallPromise
    }

    sharedInstallPromise = this.installOnce(options).finally(() => {
      sharedInstallPromise = undefined
    })
    return sharedInstallPromise
  }

  /**
   * 执行单次安装并在结束后重新检测。
   *
   * @param options - 安装参数。
   * @returns 最终 Chromium 状态。
   * @throws 统一转换为 PlaywrightEngineError。
   */
  private async installOnce(
    options: Parameters<IChromiumInstaller['install']>[0] = {},
  ): Promise<IChromiumStatus> {
    const before = await this.detect({ browsersPath: options.browsersPath })
    if (before.installed) return before

    if (options.signal?.aborted) {
      throw createInstallError(
        'BROWSER_INSTALL_CANCELLED',
        'Chromium 安装已取消。',
        'cancelled',
      )
    }

    let cliArgs: string[]
    try {
      cliArgs = this.resolveCliPath()
    } catch {
      throw createInstallError(
        'BROWSER_INSTALL_FAILED',
        '无法定位 npm 包内的 Playwright CLI。',
        'cli-not-found',
      )
    }

    const startedAt = Date.now()
    const env = { ...this.environment }
    if (options.browsersPath)
      env.PLAYWRIGHT_BROWSERS_PATH = options.browsersPath

    try {
      await runInstallProcess({
        command: process.execPath,
        // cliArgs 可能是 [cliPath] 或 ['-e', 引导代码]；统一在其后追加安装子命令。
        args: [...cliArgs, 'install', 'chromium'],
        env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
        spawnProcess: this.spawnProcess,
        terminateProcessTree: this.terminateProcessTree,
        onOutput: (line) => {
          const message = this.redactor.redact(line)
          const progress: IChromiumInstallProgress = {
            phase: inferInstallProgressPhase(message),
            message,
          }
          options.onProgress?.(progress)
        },
      })
    } catch (error) {
      throw this.toEngineError(error, Date.now() - startedAt)
    }

    const after = await this.detect({ browsersPath: options.browsersPath })
    if (!after.installed) {
      throw createInstallError(
        'BROWSER_INSTALL_FAILED',
        'Chromium 安装命令已完成，但未检测到可执行浏览器。',
        'missing-after-install',
        Date.now() - startedAt,
      )
    }
    return after
  }

  /**
   * 将安装进程错误分类为 Engine 错误。
   *
   * @param error - 安装进程或 CLI 错误。
   * @param durationMs - 安装耗时。
   * @returns 脱敏后的结构化错误。
   * @throws 不抛出异常。
   */
  private toEngineError(
    error: unknown,
    durationMs: number,
  ): PlaywrightEngineError {
    if (error instanceof InstallProcessError) {
      if (error.kind === 'cancelled') {
        return createInstallError(
          'BROWSER_INSTALL_CANCELLED',
          'Chromium 安装已取消。',
          'cancelled',
          durationMs,
        )
      }
      if (error.kind === 'timeout') {
        return createInstallError(
          'BROWSER_INSTALL_TIMEOUT',
          'Chromium 安装超时。',
          'timeout',
          durationMs,
        )
      }
      const message = this.redactor.redact(error.message)
      return createInstallError(
        'BROWSER_INSTALL_FAILED',
        `Chromium 安装失败：${message}`,
        classifyInstallFailure(message),
        durationMs,
      )
    }

    const message = this.redactor.redact(
      error instanceof Error ? error.message : '未知安装错误。',
    )
    return createInstallError(
      'BROWSER_INSTALL_FAILED',
      `Chromium 安装失败：${message}`,
      classifyInstallFailure(message),
      durationMs,
    )
  }
}

/**
 * 解析本 npm 包自身可定位的 Playwright CLI 启动命令。
 *
 * 背景：不能使用 `require.resolve('playwright/cli.js')`——playwright 的 `exports`
 * 映射不导出该子路径，会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。但 `cli.js` 是
 * `playwright` 包 `bin` 指向的官方 CLI 脚本、与包入口 `index.js` 同级，先解析
 * 包入口再按文件路径拼出它，即可执行 `node <cli.js> install chromium`，
 * 等价官方 CLI 且不依赖全局 PATH。
 *
 * 为什么不用 `node -e "...program.parse(process.argv)"`：`-e` 模式没有脚本路径位，
 * Commander 的 `parse(process.argv)` 会把第一个真实参数（`install`）当作脚本名
 * 丢掉，只剩 `chromium` 被当成命令解析，结果是稳定报
 * `error: unknown command 'chromium'` 并以退出码 1 结束——自动安装永远失败。
 *
 * 解析顺序（全部基于本包自身的依赖解析，不依赖全局 PATH）：
 *   1. 包入口同级的 `cli.js`：官方 CLI 脚本，直接作为 node 脚本执行；
 *   2. `playwright/lib/program` 引导：包结构变化时的兜底，argv 需自行补足脚本位。
 *
 * @returns 启动 Playwright CLI 所需的 node 参数（脚本路径或 `-e` 引导代码）。
 * @throws 依赖不存在或所有候选路径都不可解析时抛出模块解析异常。
 */
function defaultResolveCliPath(): string[] {
  const require = createRequire(import.meta.url)

  const entryPath = require.resolve('playwright')
  const cliPath = join(dirname(entryPath), 'cli.js')

  if (existsSync(cliPath)) {
    return [cliPath]
  }

  // 兜底：cli.js 不存在时退回官方 program 模块引导。argv 必须补足脚本位，
  // 否则 Commander 会吃掉第一个真实参数（见函数头的背景说明）。
  const programPath = require.resolve('playwright/lib/program')
  // 用 JSON.stringify 转义路径，避免 Windows 反斜杠在 JS 字面量中被当作转义符。
  return [
    '-e',
    `require(${JSON.stringify(programPath)}).program.parse([process.argv[0], ${JSON.stringify(programPath)}, ...process.argv.slice(1)])`,
  ]
}

/**
 * 创建标准化 Chromium 安装错误。
 *
 * @param code - 安装错误码。
 * @param message - 脱敏消息。
 * @param reason - 诊断原因。
 * @param durationMs - 可选耗时。
 * @returns Engine 错误对象。
 * @throws 不抛出异常。
 */
function createInstallError(
  code:
    | 'BROWSER_INSTALL_FAILED'
    | 'BROWSER_INSTALL_CANCELLED'
    | 'BROWSER_INSTALL_TIMEOUT',
  message: string,
  reason: string,
  durationMs?: number,
): PlaywrightEngineError {
  return new PlaywrightEngineError(code, message, {
    component: 'chromium',
    retryable: code === 'BROWSER_INSTALL_FAILED',
    reason,
    ...(durationMs === undefined ? {} : { durationMs }),
  })
}

/**
 * 根据安装输出推断失败原因，供宿主展示可理解提示。
 *
 * @param message - 已脱敏的进程消息。
 * @returns 稳定的失败原因标识。
 * @throws 不抛出异常。
 */
function classifyInstallFailure(message: string): string {
  const normalized = message.toLowerCase()
  if (
    normalized.includes('enotfound') ||
    normalized.includes('econn') ||
    normalized.includes('network')
  )
    return 'network'
  if (
    normalized.includes('eacces') ||
    normalized.includes('eperm') ||
    normalized.includes('permission')
  )
    return 'permission-denied'
  if (normalized.includes('enospc') || normalized.includes('disk space'))
    return 'disk-space'
  if (normalized.includes('cli')) return 'cli-error'
  return 'process-exit'
}

/**
 * 创建默认 Chromium 安装器。
 *
 * @param options - 可选适配器。
 * @returns ChromiumInstaller 实例。
 * @throws 不抛出异常。
 */
export function createChromiumInstaller(
  options: IChromiumInstallerOptions = {},
): ChromiumInstaller {
  return new ChromiumInstaller(options)
}

/**
 * 返回默认安装超时。
 *
 * @returns 默认超时毫秒数。
 * @throws 不抛出异常。
 */
export function getDefaultChromiumInstallTimeout(): number {
  return DEFAULT_INSTALL_TIMEOUT_MS
}

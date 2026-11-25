/** 封装 Chromium 安装子进程、逐行进度、超时和跨平台进程树终止。 */

import { execFile, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

/** 非零退出时保留的诊断文本上限（字符）；超出只保留尾部。 */
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 2000

/**
 * 可被安装器消费的子进程最小接口。
 */
export interface IInstallProcess {
  readonly pid?: number
  readonly stdout?: Readable | null
  readonly stderr?: Readable | null
  on(event: 'error', listener: (error: Error) => void): this
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this
  kill(signal?: NodeJS.Signals): boolean
}

/**
 * 注入子进程启动器，供单元测试替换真实 spawn。
 */
export type TInstallProcessSpawner = (
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    detached?: boolean
  },
) => IInstallProcess

/**
 * 注入进程树终止器，供跨平台测试替换系统调用。
 */
export type TProcessTreeTerminator = (process: IInstallProcess) => Promise<void>

/**
 * 受控安装子进程的失败分类。
 */
export type TInstallProcessFailureKind =
  'cancelled' | 'timeout' | 'spawn' | 'exit'

/**
 * 包含进程退出信息的安装执行错误。
 */
export class InstallProcessError extends Error {
  readonly kind: TInstallProcessFailureKind
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null

  /**
   * 创建安装进程错误。
   *
   * @param kind - 取消、超时、启动或非零退出分类。
   * @param message - 已限制长度的诊断文本。
   * @param details - 退出码和信号。
   * @returns 安装进程错误对象。
   * @throws 不抛出异常。
   */
  constructor(
    kind: TInstallProcessFailureKind,
    message: string,
    details: { exitCode?: number | null; signal?: NodeJS.Signals | null } = {},
  ) {
    super(message)
    this.name = 'InstallProcessError'
    this.kind = kind
    this.exitCode = details.exitCode ?? null
    this.signal = details.signal ?? null
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * 启动安装子进程并消费其标准输出。
 *
 * 非零退出时，错误消息携带输出尾部（截断）——否则排障时只剩一个退出码，
 * 看不到 Playwright CLI 究竟报了什么错。
 *
 * @param options - 子进程、取消、超时和逐行输出配置。
 * @returns 子进程正常退出时完成。
 * @throws 安装进程启动失败、取消、超时或非零退出时抛出 InstallProcessError。
 */
export function runInstallProcess(options: {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs: number
  spawnProcess?: TInstallProcessSpawner
  terminateProcessTree?: TProcessTreeTerminator
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void
}): Promise<void> {
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess
  const terminateProcessTree =
    options.terminateProcessTree ?? createDefaultProcessTreeTerminator()

  return new Promise<void>((resolve, reject) => {
    let child: IInstallProcess
    try {
      child = spawnProcess(options.command, options.args, {
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      reject(new InstallProcessError('spawn', getErrorMessage(error)))
      return
    }

    let settled = false
    let terminating = false
    let timeout: NodeJS.Timeout | undefined
    let stdoutBuffer = ''
    let stderrBuffer = ''
    /**
     * 已消费输出行的尾部：完整行默认被 onOutput 即时消费（进度上报），
     * 这里再留一份供非零退出时的诊断文本使用。
     */
    let diagnosticOutput = ''

    /**
     * 追加一行诊断文本，超长时只保留尾部。
     *
     * @param line - 已去重的输出行。
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    const rememberLine = (line: string): void => {
      diagnosticOutput = `${diagnosticOutput}${line}\n`.slice(
        -MAX_DIAGNOSTIC_OUTPUT_LENGTH,
      )
    }

    const clearResources = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      options.signal?.removeEventListener('abort', abort)
    }

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearResources()
      if (error) reject(error)
      else resolve()
    }

    const flush = (
      buffer: string,
      stream: 'stdout' | 'stderr',
      force: boolean,
    ): string => {
      const parts = buffer.split(/\r?\n/)
      const remaining = force ? '' : (parts.pop() ?? '')
      for (const line of parts) {
        if (line.trim()) {
          rememberLine(line.trim())
          options.onOutput?.(line.trim(), stream)
        }
      }
      if (force && parts.length === 0 && buffer.trim()) {
        rememberLine(buffer.trim())
        options.onOutput?.(buffer.trim(), stream)
      }
      return remaining
    }

    const terminate = async (kind: 'cancelled' | 'timeout'): Promise<void> => {
      if (settled || terminating) return
      terminating = true
      try {
        await terminateProcessTree(child)
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // 进程已经结束时忽略二次终止失败，继续返回原始取消或超时原因。
        }
      }
      finish(
        new InstallProcessError(
          kind,
          kind === 'cancelled'
            ? 'Chromium 安装已取消。'
            : 'Chromium 安装超时。',
        ),
      )
    }

    const abort = (): void => {
      void terminate('cancelled')
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString()
      stdoutBuffer = flush(stdoutBuffer, 'stdout', false)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString()
      stderrBuffer = flush(stderrBuffer, 'stderr', false)
    })
    child.on('error', (error) =>
      finish(new InstallProcessError('spawn', getErrorMessage(error))),
    )
    child.on('close', (code, signal) => {
      // 先强制冲刷残留的半行，让诊断文本包含最后一行输出。
      flush(stdoutBuffer, 'stdout', true)
      flush(stderrBuffer, 'stderr', true)
      const output = diagnosticOutput.trim()
      if (settled) return
      if (code === 0) {
        finish()
      } else {
        finish(
          new InstallProcessError(
            'exit',
            output || `Chromium 安装进程退出，code=${code ?? 'null'}。`,
            { exitCode: code, signal },
          ),
        )
      }
    })

    if (options.signal?.aborted) {
      void terminate('cancelled')
      return
    }

    options.signal?.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => {
      void terminate('timeout')
    }, options.timeoutMs)
  })
}

/**
 * 创建默认的跨平台进程树终止器。
 *
 * @returns Windows 使用 taskkill、POSIX 使用进程组信号的终止函数。
 * @throws 终止失败由返回 Promise 表示，不在创建时抛出。
 */
export function createDefaultProcessTreeTerminator(): TProcessTreeTerminator {
  return async (child) => {
    if (!child.pid) {
      child.kill('SIGTERM')
      return
    }

    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'taskkill',
          ['/T', '/F', '/PID', String(child.pid)],
          (error) => {
            if (error) reject(error)
            else resolve()
          },
        )
      })
      return
    }

    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/**
 * 使用 Node child_process.spawn 启动安装器。
 *
 * @param command - Node 可执行文件。
 * @param args - Playwright CLI 参数。
 * @param options - 最小化环境和管道配置。
 * @returns 可被 runInstallProcess 使用的子进程。
 * @throws spawn 失败时抛出系统异常。
 *
 * Windows 上强制 windowsHide：安装器是控制台程序，宿主若没有控制台
 * （CLI 后台服务的 detached 进程）时会被系统新建一个可见黑窗。
 */
function defaultSpawnProcess(
  command: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    detached?: boolean
  },
): IInstallProcess {
  return spawn(command, [...args], {
    ...options,
    windowsHide: true,
  }) as unknown as IInstallProcess
}

/**
 * 将未知异常安全转换为短诊断文本。
 *
 * @param error - 未知异常。
 * @returns 脱离 stack 的错误消息。
 * @throws 不抛出异常。
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2_048)
    : '无法启动 Chromium 安装进程。'
}

/**
 * 将安装输出映射为用户可理解的安装阶段。
 *
 * @param line - 原始输出行。
 * @returns 安装阶段。
 * @throws 不抛出异常。
 */
export function inferInstallProgressPhase(
  line: string,
): 'resolving-cli' | 'downloading' | 'extracting' | 'verifying' {
  const normalized = line.toLowerCase()
  return normalized.includes('download')
    ? 'downloading'
    : normalized.includes('extract') || normalized.includes('unzip')
      ? 'extracting'
      : normalized.includes('verify') ||
          normalized.includes('success') ||
          normalized.includes('installed')
        ? 'verifying'
        : 'resolving-cli'
}

/**
 * 导出默认实现供测试构造注入配置。
 */
export const __private = {
  defaultSpawnProcess,
}

/**
 * 处理 `e2e_assistant log` 命令：查看（并可跟随）后台服务的日志。
 *
 * 三条前置判定决定了它的行为（v19 §4.3）：
 *   - 服务以前台模式运行中 → 日志在它的终端，本命令不展示可能过期的旧文件；
 *   - 从未以后台模式启动过 → 给出路径与启动方式，而不是报「文件不存在」；
 *   - 其余 → 展示最后 N 行；`--follow` 时持续跟随。
 *
 * 本命令**不触碰服务**：跟随中 Ctrl+C 只结束本命令。
 */
import process from 'node:process'
import {
  followServiceLog,
  getServiceLogPath,
  readServiceLogTail,
} from '../infrastructure/log/log-file'
import { inspectPlatformRuntimeState } from '../infrastructure/config/runtime-store'
import { resolveServiceState } from '../application/service-identity'
import { renderLogPanel } from '../presentation/console/log-panel'

/** 默认展示的行数（L4）。 */
export const DEFAULT_LOG_LINE_COUNT = 100

export interface ILogCommandOptions {
  /**
   * 行数；来自 `cac`。
   *
   * 实测类型陷阱（v19 §6.2）：声明 `default: '100'` 时不给 `-n` 得到**字符串**
   * `'100'`，`-n 500` 得到**数字** `500`。因此这里必须接受两者。
   */
  lines?: string | number
  follow?: boolean
}

/**
 * 解析并校验行数参数。
 *
 * 非有限正整数（`'abc'`、`0`、小数）一律报明确错误而不静默回退默认值——
 * 静默回退会让 `-n 0` 这类输入表现为「打印 100 行」，用户无法理解。
 *
 * @param rawLines - 原始参数（字符串或数字）。
 * @returns 校验通过的行数。
 * @throws Error 当取值不是正整数时抛出，携带可执行的说明。
 */
export function parseLogLineCount (rawLines: string | number | undefined): number {
  if (rawLines === undefined) {
    return DEFAULT_LOG_LINE_COUNT
  }

  const normalizedText = String(rawLines).trim()
  const parsedLines = Number(normalizedText)

  if (
    !/^\d+$/.test(normalizedText) ||
    !Number.isSafeInteger(parsedLines) ||
    parsedLines <= 0
  ) {
    throw new Error(
      `行数参数不合法：「${String(rawLines)}」。请提供正整数，例如 e2e_assistant log -n 50。`,
    )
  }

  return parsedLines
}

/**
 * 处理 `e2e_assistant log` 命令。
 *
 * @param options - 行数与是否跟随。
 * @returns 处理完成后无返回值；跟随模式在 Ctrl+C 时返回（退出码 0）。
 * @throws Error 当行数参数非法时抛出（由命令包装器统一上报）。
 */
export async function handleLogCommand (
  options: ILogCommandOptions,
): Promise<void> {
  const maxLines = parseLogLineCount(options.lines)

  // 「服务以前台模式运行中」的判定必须「记录 + 探测」双条件（§6.2 第 3 步）：
  // 只读记录会把陈旧记录误判为「正在前台运行」，只探测又拿不到模式。
  if (await isForegroundServiceRunning()) {
    process.stdout.write(
      renderLogPanel({ notice: 'foreground-running', logPath: getServiceLogPath() }),
    )
    return
  }

  const logTail = await readServiceLogTail({ maxLines })

  if (logTail === null) {
    process.stdout.write(
      renderLogPanel({ notice: 'no-log-file', logPath: getServiceLogPath() }),
    )
    return
  }

  if (logTail) {
    console.log(logTail)
  }

  if (options.follow !== true) {
    return
  }

  await followUntilInterrupted()
}

/**
 * 判断运行中的服务是否为前台模式。
 *
 * @returns 记录存在、探测确认在运行、且记录 mode 为 foreground 时返回 true。
 * @throws 不抛出异常；读取与探测失败都按「不是前台运行中」处理（继续走正常展示）。
 */
async function isForegroundServiceRunning (): Promise<boolean> {
  try {
    const inspection = await inspectPlatformRuntimeState()

    if (inspection.state !== 'present') {
      return false
    }

    const resolution = await resolveServiceState({
      runtimeState: inspection.runtimeState,
      isRecordInvalid: false,
    })

    return (
      resolution.state === 'active' &&
      resolution.runtimeState.mode === 'foreground'
    )
  } catch {
    return false
  }
}

/**
 * 跟随日志直到用户 Ctrl+C。
 *
 * 只注册本命令自己的 SIGINT 处理：默认行为会终止进程（跟随就此结束），
 * 这正是「Ctrl+C 只结束 log 命令」所需的语义；服务不受影响。
 *
 * @returns 用户中断时兑现。
 * @throws 不抛出异常。
 */
async function followUntilInterrupted (): Promise<void> {
  const abortController = new AbortController()

  const handleInterrupt = (): void => {
    abortController.abort()
  }

  process.once('SIGINT', handleInterrupt)

  try {
    await followServiceLog({
      signal: abortController.signal,
      onLines: (lines) => {
        console.log(lines.join('\n'))
      },
    })
  } finally {
    process.removeListener('SIGINT', handleInterrupt)
  }

  // 跟随结束时把退出码显式置 0：Ctrl+C 只结束 log 命令，不是失败。
  process.exitCode = 0
}

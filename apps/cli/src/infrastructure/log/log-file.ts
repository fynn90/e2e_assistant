/**
 * 后台服务日志文件的路径、轮转、尾部读取与跟随。
 *
 * 日志的**来源**不是本模块：后台子进程的 stdout/stderr 由启动器重定向到本文件
 * （fd 直连，见 v19 技术方案 §1.2），因此服务进程与启动链路都没有一行「写日志」
 * 的代码。本模块负责的是这之外的读写侧：路径、轮转、`log` 命令需要的内容读取与跟随。
 *
 * 定位：基础设施层的文件操作，不含任何进程语义与命令输出。
 */
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { getAuthineConfigDirectory } from '../config/config-path'

/** 日志文件超过该体积时轮转（只留一份旧文件，§4.3 L2）。 */
export const SERVICE_LOG_ROTATE_THRESHOLD_BYTES = 5 * 1024 * 1024

/** 跟随日志的轮询间隔；不用 fs.watch 的原因见文件头与 §3.3。 */
const FOLLOW_POLL_INTERVAL_MS = 300

/** 轮转后保留的旧文件名后缀。 */
const ROTATED_LOG_SUFFIX = '.1'

/** 后台服务日志文件名。 */
const SERVICE_LOG_FILE_NAME = 'service.log'

/**
 * 后台服务日志路径：`<配置目录>/logs/service.log`。
 *
 * 沿用 `@fynn90-e2e_assistant/config` 的配置目录约定（Windows `%APPDATA%\e2e_assistant`，
 * POSIX `~/.config/e2e_assistant`），不引入第二个用户级根目录（PRD Q3）。
 *
 * @returns 日志文件绝对路径。
 * @throws 不抛出异常。
 */
export function getServiceLogPath (): string {
  return path.join(getAuthineConfigDirectory(), 'logs', SERVICE_LOG_FILE_NAME)
}

/** 轮转后的旧日志路径（`service.log.1`）。 */
function getRotatedServiceLogPath (): string {
  return `${getServiceLogPath()}${ROTATED_LOG_SUFFIX}`
}

/**
 * 日志轮转的结果。
 */
export interface IRotateServiceLogResult {
  /** 是否真的发生了轮转。 */
  rotated: boolean
  /**
   * 轮转失败的原因说明；未失败时为 null。
   *
   * 只返回、不打印：本模块属基础设施层，终端文案由调用方呈现。且轮转发生在
   * **启动器进程**（父进程），它的输出用户可见——因此把说明随结果带上去，
   * 由启动面板统一呈现。
   */
  failureReason: string | null
}

/**
 * 日志文件超过阈值时轮转为 `service.log.1`。
 *
 * 只在后台启动派生新进程前调用：复用分支不轮转——日志文件的归属跟随服务进程，
 * 复用没有新进程，轮转会让正在运行的服务突然换文件。
 *
 * 失败不阻断启动（日志轮转失败不该让服务起不来），但要如实报告——
 * 静默失败会让用户以为日志是连续的，而实际已被覆盖。
 *
 * @returns 轮转结果，含是否发生轮转与失败原因（未失败时为 null）。
 * @throws 不抛出异常；失败被转换为结果中的 `failureReason`。
 */
export async function rotateServiceLogIfNeeded (): Promise<IRotateServiceLogResult> {
  const logPath = getServiceLogPath()

  try {
    const logStat = await stat(logPath)

    if (logStat.size <= SERVICE_LOG_ROTATE_THRESHOLD_BYTES) {
      return { rotated: false, failureReason: null }
    }

    const rotatedLogPath = getRotatedServiceLogPath()
    // 只留一份旧文件：先删旧的 .1 再重命名，避免体积无限累积。
    await rm(rotatedLogPath, { force: true })
    await rename(logPath, rotatedLogPath)
    return { rotated: true, failureReason: null }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { rotated: false, failureReason: null }
    }

    return {
      rotated: false,
      failureReason: `日志文件轮转失败，将继续写入当前文件：${formatErrorMessage(error)}`,
    }
  }
}

/**
 * 读取日志文件的最后若干行。
 *
 * @param options - `maxLines`：要读取的行数上限。
 * @returns 最后若干行的文本；文件不存在时返回 null（让调用方区分「空日志」与
 *   「从未产生过日志」，后者需要不同的用户指引）。
 * @throws 不抛出异常；读取失败按「没有日志」处理并返回 null。
 */
export async function readServiceLogTail (options: {
  maxLines: number
}): Promise<string | null> {
  try {
    const content = await readFile(getServiceLogPath(), 'utf-8')
    const lines = content.split(/\r?\n/)

    // 文本以换行结尾时会split 出一个尾随空串；它不是「空行」，不该计入。
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }

    return lines.slice(-options.maxLines).join('\n')
  } catch {
    return null
  }
}

export interface IFollowServiceLogOptions {
  /** 每批新增行（已按行切分，不含行尾符）。 */
  onLines: (lines: string[]) => void
  /** 停止跟随的信号；abort 后跟随循环退出。 */
  signal: AbortSignal
  /** 轮询间隔（毫秒），缺省 300；测试可注入更小的值。 */
  pollIntervalMs?: number
}

/**
 * 持续跟随日志文件的新增内容。
 *
 * 实现为**轮询读取**而非 `fs.watch`：文件重命名在各平台上的事件语义不一致
 * （Windows 上 rename 后 watcher 指向旧句柄），轮询简单且跨平台一致。
 * 文件大小小于已读偏移时（被轮转或截断）重置偏移，从新文件头继续——
 * `log -f` 期间日志轮转不会丢行，也不会卡死（AC「log 跟随中日志被轮转」）。
 *
 * @param options - 行回调、停止信号与轮询间隔。
 * @returns 跟随循环退出时兑现（signal abort 或读取持续失败）。
 * @throws 不抛出异常。
 */
export async function followServiceLog (
  options: IFollowServiceLogOptions,
): Promise<void> {
  const logPath = getServiceLogPath()
  const pollIntervalMs = options.pollIntervalMs ?? FOLLOW_POLL_INTERVAL_MS
  /** 已读字节偏移；文件轮转/截断后重置为 0。 */
  let readOffset = await resolveInitialOffset(logPath)

  while (!options.signal.aborted) {
    await sleep(pollIntervalMs)

    if (options.signal.aborted) {
      return
    }

    const nextOffset = await readNewContent({
      logPath,
      readOffset,
      onLines: options.onLines,
    })

    if (nextOffset !== null) {
      readOffset = nextOffset
    }
  }
}

/**
 * 解析跟随的起始偏移：从当前文件末尾开始（历史内容由「先展示最后 N 行」覆盖）。
 *
 * @param logPath - 日志文件路径。
 * @returns 起始字节偏移；文件不存在时为 0（等待它被创建）。
 * @throws 不抛出异常。
 */
async function resolveInitialOffset (logPath: string): Promise<number> {
  try {
    return (await stat(logPath)).size
  } catch {
    return 0
  }
}

interface IReadNewContentOptions {
  logPath: string
  readOffset: number
  onLines: (lines: string[]) => void
}

/**
 * 读取自 `readOffset` 之后的新增内容并回调完整行。
 *
 * 半行（未以换行结尾的尾巴）不回调，其字节计入偏移——否则跟随中会把一行
 * 拆成多次打印。文件变小视为轮转/截断：从头重新读。
 *
 * @param options - 日志路径、当前偏移与回调。
 * @returns 新的偏移；文件不可读时返回 null（调用方保持原偏移重试）。
 * @throws 不抛出异常。
 */
async function readNewContent (
  options: IReadNewContentOptions,
): Promise<number | null> {
  let fileSize: number

  try {
    fileSize = (await stat(options.logPath)).size
  } catch {
    return null
  }

  // 文件比已读偏移还小：轮转或截断发生了，回到文件头继续。
  const effectiveOffset = fileSize < options.readOffset ? 0 : options.readOffset

  if (fileSize === effectiveOffset) {
    return effectiveOffset
  }

  let content: string

  try {
    const fileHandle = await open(options.logPath, 'r')
    try {
      const buffer = Buffer.alloc(fileSize - effectiveOffset)
      const { bytesRead } = await fileHandle.read(
        buffer,
        0,
        buffer.length,
        effectiveOffset,
      )
      content = buffer.subarray(0, bytesRead).toString('utf-8')
    } finally {
      await fileHandle.close()
    }
  } catch {
    return null
  }

  const lastNewlineIndex = content.lastIndexOf('\n')

  if (lastNewlineIndex === -1) {
    // 只有半行：不打印，等它写完整（偏移不前进）。
    return effectiveOffset
  }

  const completeText = content.slice(0, lastNewlineIndex)
  const lines = completeText.split(/\r?\n/)

  if (lines.length > 0) {
    options.onLines(lines)
  }

  // 只把已消费的完整行计入偏移，半行留给下一轮。
  return effectiveOffset + Buffer.byteLength(completeText, 'utf-8') + 1
}

function sleep (durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function isMissingFileError (error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }

  return (error as { code?: unknown }).code === 'ENOENT'
}

function formatErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

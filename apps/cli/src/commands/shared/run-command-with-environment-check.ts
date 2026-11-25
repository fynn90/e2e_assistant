import process from 'node:process'
import { checkNodeVersion } from '../../application/environment-check'
import {
  renderNoticeBlock,
  renderNoticeLine,
} from '../../presentation/console/message-line'

interface IRunCommandWithEnvironmentCheckOptions {
  commandAction: () => Promise<void>
}

/**
 * 在执行具体 CLI 命令前完成环境校验，不满足要求时直接终止当前命令。
 *
 * 本函数是 CLI 的**错误出口**：所有命令失败都收敛到 `reportCliCommandError`，
 * 因此这里也是「错误长什么样」的唯一落点。输出走 stderr（错误不该混进 stdout，
 * 否则管道下游会把错误当成正常输出）。
 *
 * @param options 命令执行所需的回调参数。
 * @returns 执行完成后无返回值。
 */
export async function runCommandWithEnvironmentCheck(
  options: IRunCommandWithEnvironmentCheckOptions,
): Promise<void> {
  const versionCheck = checkNodeVersion()

  if (!versionCheck.satisfied) {
    console.error(
      renderNoticeLine({ level: 'error', message: versionCheck.message }),
    )
    process.exitCode = 1
    return
  }

  try {
    await options.commandAction()
  } catch (error) {
    reportCliCommandError(error)
    process.exitCode = 1
  }
}

/**
 * 将 CLI 启动或命令执行阶段的异常统一打印到 stderr，便于开发和排查问题。
 *
 * 保留「Authine CLI 执行失败」这一措辞与堆栈：PRD v18 明确约定 `reportCliCommandError`
 * 的报错形态不变（该行是用户报障时最先看到的信息），此处只统一图标与配色。
 *
 * @param error 捕获到的未知异常对象。
 * @returns 打印完成后无返回值。
 */
export function reportCliCommandError(error: unknown): void {
  if (error instanceof Error) {
    console.error(
      renderNoticeBlock({
        level: 'error',
        message: `Authine CLI 执行失败：${error.message}`,
        details: resolveStackFrames(error),
      }),
    )

    return
  }

  console.error(
    renderNoticeLine({ level: 'error', message: 'Authine CLI 执行失败。' }),
  )
  console.error(error)
}

/**
 * 取堆栈里的调用帧（去掉首行）。
 *
 * `error.stack` 的第一行是 `Error: <message>`，而该消息已由调用方作为正文打印；
 * 不去掉会让同一句话在屏幕上出现两次。
 *
 * @param error - 捕获到的异常。
 * @returns 各调用帧文本；无堆栈时为空数组。
 * @throws 不抛出异常。
 */
function resolveStackFrames(error: Error): string[] {
  if (!error.stack) {
    return []
  }

  return error.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

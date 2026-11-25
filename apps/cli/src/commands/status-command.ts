/**
 * 处理 `e2e_assistant status` 命令：只读地报告服务当前状态。
 *
 * 与 start / stop 的分界：本命令**不改变任何状态**——不启动、不结束进程、
 * 不清理记录（见 application/service-status.ts 的只读性质）。
 *
 * 退出码区分三态，便于写进脚本：
 *   0 服务在运行；1 服务未运行；2 无法确认状态。
 * 第三态单列而非并入「未运行」，是因为它不可安全自动化——脚本若把它当成
 * 「没在跑」就会去启动，而端口实际被占，启动会让仍可能存活的服务失去管理。
 */
import process from 'node:process'
import { readServiceStatus } from '../application/service-status'
import { getServiceLogPath } from '../infrastructure/log/log-file'
import { getCliPackageVersion } from '../infrastructure/cli-package-version'
import { renderStatusPanel } from '../presentation/console/status-panel'

/** 服务在运行时的退出码。 */
export const STATUS_EXIT_RUNNING = 0
/** 服务未运行时的退出码。 */
export const STATUS_EXIT_STOPPED = 1
/** 无法确认状态时的退出码（不可安全自动化）。 */
export const STATUS_EXIT_UNKNOWN = 2

/**
 * 处理 `e2e_assistant status` 命令。
 *
 * @returns 处理完成后无返回值；退出码由三态决定。
 * @throws 不抛出异常；查询失败会收敛为「无法确认」而非抛出。
 */
export async function handleStatusCommand (): Promise<void> {
  const status = await readServiceStatus()

  process.stdout.write(renderStatusPanel(toPanelInput(status)))
  process.exitCode = resolveExitCode(status.state)
}

/**
 * 把状态判定结果翻译为面板输入。
 *
 * @param status - 服务状态判定结果。
 * @returns 面板输入。
 * @throws 不抛出异常。
 */
function toPanelInput (
  status: Awaited<ReturnType<typeof readServiceStatus>>,
): Parameters<typeof renderStatusPanel>[0] {
  if (status.state === 'active') {
    const runtimeState = status.runtimeState

    return {
      kind: 'running',
      serverUrl: runtimeState.serverUrl,
      port: runtimeState.port,
      mode: runtimeState.mode,
      pid: runtimeState.pid,
      startedAt: runtimeState.startedAt,
      // 用探测到的版本而非本地常量：这样才能发现「跑着的是旧版服务」。
      version: status.version,
      // 本 CLI 包的版本；与上面的协议版本是两个概念，两行并存。
      cliVersion: getCliPackageVersion(),
      // 前台模式的日志刷在它自己的终端里，不落盘——给出路径是误导。
      ...(runtimeState.mode === 'background'
        ? { logPath: getServiceLogPath() }
        : {}),
    }
  }

  if (status.state === 'unknown') {
    return {
      kind: 'unconfirmable',
      detail: status.detail,
      port: status.runtimeState.port,
      pid: status.runtimeState.pid,
    }
  }

  return {
    kind: 'stopped',
    reason: status.reason,
    logPath: getServiceLogPath(),
  }
}

/**
 * 把状态映射为退出码。
 *
 * @param state - 状态判定的三态。
 * @returns 退出码：active → 0，absent → 1，unknown → 2。
 * @throws 不抛出异常。
 */
function resolveExitCode (state: 'active' | 'absent' | 'unknown'): number {
  if (state === 'active') {
    return STATUS_EXIT_RUNNING
  }

  return state === 'unknown' ? STATUS_EXIT_UNKNOWN : STATUS_EXIT_STOPPED
}

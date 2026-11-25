import process from 'node:process'
import { stopPlatformService } from '../application/service-lifecycle'
import { renderStopPanel } from '../presentation/console/stop-panel'

/**
 * 处理 `e2e_assistant stop` 命令，负责停止当前运行中的平台服务。
 *
 * 结论文案来自应用层（`已优雅停止` 等），此处只负责呈现，不重新措辞。
 *
 * @returns 处理完成后无返回值。
 * @throws 当状态无法确认或记录指向当前进程时抛出（由命令包装器统一上报）。
 */
export async function handleStopCommand (): Promise<void> {
  const stopResult = await stopPlatformService()

  process.stdout.write(
    renderStopPanel({
      stopped: stopResult.stopped,
      alreadyStopped: stopResult.alreadyStopped,
      message: stopResult.message,
      ...(stopResult.serverUrl ? { serverUrl: stopResult.serverUrl } : {}),
      ...(stopResult.pid !== undefined ? { pid: stopResult.pid } : {}),
      ...(stopResult.startedAt !== undefined
        ? { startedAt: stopResult.startedAt }
        : {}),
      ...(stopResult.port !== undefined ? { port: stopResult.port } : {}),
    }),
  )

  if (!stopResult.stopped && !stopResult.alreadyStopped) {
    process.exitCode = 1
  }
}

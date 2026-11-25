/**
 * 优雅关闭序列（v19 §4.2）：服务层「释放本层资源」的唯一实现。
 *
 * 三个触发源共用它：SIGINT、SIGTERM、`POST /api/shutdown`。它**不含**任何进程
 * 语义——不调 `process.exit`、不发信号、不注册信号处理器（v18 原则二）。
 * 「谁结束进程、用什么退出码」由宿主（CLI）的关闭例行程序决定。
 */
import type { ITestExecutionService } from '../application/test-execution/execution-service'
import type { IGenerationBrowserHost } from '../generation-runtime/index'
import type { IAgentWorkRuntimeRegistry } from '../agent-runtime/index'

/** 关闭序列中「等待在跑任务收敛」的上限：超过则不阻塞关闭（R3）。 */
export const SHUTDOWN_ABORT_WAIT_MS = 5000

export interface IShutdownSequenceDependencies {
  /** 执行服务：中止在跑任务。 */
  testExecutionService: ITestExecutionService
  /** 生成任务的浏览器宿主：关闭全部会话。 */
  browserHost: IGenerationBrowserHost
  /** 工作通道运行时注册表：释放 Agent 运行时与数据库句柄。 */
  workRuntimeRegistry: IAgentWorkRuntimeRegistry
}

/**
 * 创建优雅关闭序列。
 *
 * 每一步独立容错（R2）：单步失败只跳过、不中断后续——关闭链路里任何一环出问题，
 * 都不该让进程卡在关闭过程中。幂等：重复调用只执行第一次，后续立即返回。
 *
 * @param dependencies - 三步各自的落点。
 * @returns 无参、无返回值的关闭函数。
 * @throws 不抛出异常；各步失败都被内部吸收。
 */
export function createShutdownSequence(
  dependencies: IShutdownSequenceDependencies,
): () => Promise<void> {
  let isShuttingDown = false

  return async (): Promise<void> => {
    if (isShuttingDown) {
      return
    }

    isShuttingDown = true

    // 1. 中止在跑的执行任务并等待收敛（至多 5s；无任务时立即返回）。
    try {
      await dependencies.testExecutionService.abortAllAndWait({
        waitMs: SHUTDOWN_ABORT_WAIT_MS,
      })
    } catch {
      // 不中断后续步骤。
    }

    // 2. 关闭全部浏览器会话（生成中的有头 Chromium）。
    try {
      await dependencies.browserHost.dispose()
    } catch {
      // 不中断后续步骤。
    }

    // 3. 释放 Agent 工作通道运行时（含数据库句柄）。
    try {
      await dependencies.workRuntimeRegistry.disposeAll()
    } catch {
      // 不中断后续步骤。
    }
  }
}

/**
 * CLI 侧的关闭例行程序：服务关闭的唯一「收尾 + 退出」实现。
 *
 * 三个触发源共用同一条序列（v19 §1.3）：SIGINT、SIGTERM、`POST /api/shutdown`。
 * 三处各写一遍必然漂移——今天的「Ctrl+C 挂起、子进程残留」正是「只有一半序列」
 * 的后果，因此这里收敛为一个函数。
 *
 * 边界（v18 原则二）：本函数属于 CLI——**进程退出只在这里发生**。
 * 服务层（`packages/service`）只提供「释放本层资源」的入口，不碰进程。
 */

export interface IShutdownRoutineOptions {
  /**
   * 释放服务侧资源：中止在跑任务 → 关浏览器 → 释放运行时 → 关闭监听并销毁连接。
   * 由 `IStartedLocalServer.closeServer` 提供。
   */
  closeServer: () => Promise<void>
  /** 清理运行态记录；失败不应阻止进程退出（记录残留比进程不退更可接受）。 */
  clearRuntimeState: () => Promise<void>
  /** 结束当前进程；注入以便测试断言，生产环境为 `process.exit`。 */
  exitProcess: (exitCode: number) => void
  /**
   * 关闭失败时的错误出口；缺省写 stderr。
   *
   * 注入点保留给测试；生产环境的默认实现由组合根（`service-lifecycle.ts`）接管，
   * 以便与其它错误走同一套呈现。
   */
  onError?: (message: string) => void
}

/**
 * 创建关闭例行程序。
 *
 * 幂等：重复调用（信号与端点可能同时到达）只执行第一次，后续调用直接返回——
 * 第二次 `process.exit` 会打断第一次尚未完成的清理。
 *
 * @param options - 关闭序列的各步实现。
 * @returns 接受退出码的关闭函数。
 * @throws 不抛出异常；任一步失败都会被收敛为「打印错误 + 退出码 1」。
 */
export function createShutdownRoutine(
  options: IShutdownRoutineOptions,
): (exitCode: number) => void {
  let isShuttingDown = false
  // 缺省出口保留原始 console.error：application 层不拼终端格式（分层约束），
  // 需要统一观感时由组合根注入带配色的实现。
  const onError =
    options.onError ??
    ((message: string) => {
      console.error(message)
    })

  return (exitCode: number): void => {
    if (isShuttingDown) {
      return
    }

    isShuttingDown = true

    void (async () => {
      try {
        await options.closeServer()
        await options.clearRuntimeState()
        options.exitProcess(exitCode)
      } catch {
        onError('关闭 Authine E2E Agent Platform 服务失败。')
        options.exitProcess(1)
      }
    })()
  }
}

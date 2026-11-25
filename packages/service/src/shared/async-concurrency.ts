/**
 * 提供异步并发控制与超时辅助能力，供文件系统探测等需要限制并发度的场景复用。
 */

/**
 * 按指定并发上限依次处理集合元素，并保持结果顺序与输入顺序一致。
 *
 * 用于避免一次性创建过多文件系统句柄（例如同时探测数百个子目录）而耗尽资源。
 *
 * @param items 待处理的元素集合。
 * @param concurrencyLimit 同时进行的最大任务数，小于 1 时按 1 处理。
 * @param mapper 元素处理函数，返回该元素的结果。
 * @returns 与输入顺序一致的处理结果集合。
 * @throws 当任一元素处理函数抛出异常时，向上抛出该异常。
 */
export async function mapWithConcurrencyLimit<TItem, TResult>(
  items: readonly TItem[],
  concurrencyLimit: number,
  mapper: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const normalizedLimit = Math.max(1, Math.floor(concurrencyLimit))
  const results = new Array<TResult>(items.length)
  let nextIndex = 0

  // 启动固定数量的工作协程，共同消费同一个递增游标，实现简单且无锁的并发控制。
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex])
    }
  }

  const workerCount = Math.min(normalizedLimit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))

  return results
}

/**
 * 为异步任务添加超时上限，超时后返回兜底值而不抛出异常。
 *
 * 用于探测可能长时间无响应的路径（例如已断开的网络映射盘）。
 *
 * @param operation 需要限时的异步任务。
 * @param timeoutMs 超时时间（毫秒）。
 * @param fallbackValue 超时后返回的兜底值。
 * @returns 任务结果；任务超时或失败时返回兜底值。
 * @throws 不抛出异常，任务异常会被转换为兜底值。
 */
export function withTimeout<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
  fallbackValue: TResult,
): Promise<TResult> {
  return new Promise<TResult>((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(fallbackValue), timeoutMs)

    void operation
      .then((result) => resolve(result))
      .catch(() => resolve(fallbackValue))
      .finally(() => clearTimeout(timeoutHandle))
  })
}

/**
 * 为异步任务添加超时上限，超时或失败时抛出异常。
 *
 * 与 withTimeout 的区别在于超时被视为错误而非可接受的兜底结果，
 * 适用于「超时必须让用户知道并采取行动」的场景（例如访问已断开的网络盘）。
 * 超时后原任务仍会继续执行，但其结果会被忽略。
 *
 * @param operation 需要限时的异步任务。
 * @param timeoutMs 超时时间（毫秒）。
 * @param createTimeoutError 超时时用于构造并抛出异常的函数，每次超时调用一次。
 * @returns 任务结果。
 * @throws 任务超时时抛出 createTimeoutError 产生的异常；任务自身失败时向上抛出原异常。
 */
export function withTimeoutRejection<TResult>(
  operation: Promise<TResult>,
  timeoutMs: number,
  createTimeoutError: () => Error,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const timeoutHandle = setTimeout(
      () => reject(createTimeoutError()),
      timeoutMs,
    )

    // 无论成功、失败还是超时都要清理定时器；已结算的 Promise 上重复调用 resolve/reject 会被忽略，
    // 且此处始终挂载了拒绝处理函数，因此超时后原任务的失败不会成为未处理的拒绝。
    void operation
      .then((result) => resolve(result))
      .catch((error: unknown) => reject(error))
      .finally(() => clearTimeout(timeoutHandle))
  })
}

/**
 * 执行事件总线：按执行任务分配单调 seq、内存环形缓冲与订阅广播。
 *
 * 镜像 agent-runtime 的 session-event-bus 模式（技术方案 D6）：
 *   - seq 统一分配——缓冲、快照、SSE 流三处序号一致；
 *   - 环形缓冲——结构化事件全量保留，log 行限容（上限 800 条，超出丢最旧），
 *     支撑导航/刷新后的短窗口补发（PRD X16）；
 *   - 订阅广播——SSE 路由按 afterSeq 先补发缺口，再进入实时推送。
 *
 * 与 session-event-bus 的差异：执行事件不落盘（服务重启即丢，PRD 已知边界），
 * 因此没有 blockStore 物化步骤。
 */

import type { TExecutionEvent } from '@authine-e2e-agent/types'

/**
 * 分布式 Omit：对联合类型逐成员剔除字段。
 *
 * 直接 `Omit<TExecutionEvent, 'seq'>` 会先取联合的键交集再剔除，
 * 得到空对象类型；此处按成员分发，保留可辨识联合形状。
 */
type TDistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

/** 不含 seq 的执行事件草稿（publish 的入参形状）。 */
export type TExecutionEventDraft = TDistributiveOmit<TExecutionEvent, 'seq'>

/** log 行在环形缓冲中的最大保留条数（技术方案 §5.1）。 */
const LOG_BUFFER_CAPACITY = 800

/** 执行事件订阅的取消函数。 */
export type TExecutionUnsubscribe = () => void

/** 执行事件监听器。 */
export type TExecutionEventListener = (event: TExecutionEvent) => void

/** 单执行任务的总线状态。 */
interface IExecutionChannel {
  /** 已分配的最大 seq。 */
  lastSeq: number
  /** 事件环形缓冲（log 行限容、结构化事件全量）。 */
  buffer: TExecutionEvent[]
  /** 实时订阅者。 */
  listeners: Set<TExecutionEventListener>
}

/** 执行事件总线接口。 */
export interface IExecutionEventBus {
  /**
   * 发布事件：分配 seq → 写缓冲 → 广播订阅者。
   *
   * @param executionId - 执行任务 ID。
   * @param draft - 不含 seq 的事件草稿。
   * @returns 已分配 seq 的完整事件。
   */
  publish(executionId: string, draft: TExecutionEventDraft): TExecutionEvent
  /**
   * 订阅执行任务：先补发 afterSeq 之后的缓冲事件，再实时推送。
   *
   * @param executionId - 执行任务 ID。
   * @param afterSeq - 补发起点（不含）；undefined 表示从缓冲头开始。
   * @param listener - 事件监听器。
   * @returns 取消订阅函数。
   */
  subscribe(
    executionId: string,
    afterSeq: number | undefined,
    listener: TExecutionEventListener,
  ): TExecutionUnsubscribe
  /** 指定执行任务当前最大 seq（无事件时为 0）。 */
  currentSeq(executionId: string): number
  /** 释放执行任务的缓冲与订阅者（任务被清理时调用）。 */
  dispose(executionId: string): void
}

/**
 * 创建执行事件总线。
 *
 * @param options.logCapacity - log 行保留上限；缺省 800 条。
 * @returns 事件总线实例。
 * @throws 不抛出异常。
 */
export function createExecutionEventBus(
  options: { logCapacity?: number } = {},
): IExecutionEventBus {
  const logCapacity = options.logCapacity ?? LOG_BUFFER_CAPACITY
  const channels = new Map<string, IExecutionChannel>()

  /** 获取或创建执行通道。 */
  function channelOf(executionId: string): IExecutionChannel {
    let channel = channels.get(executionId)
    if (!channel) {
      channel = { lastSeq: 0, buffer: [], listeners: new Set() }
      channels.set(executionId, channel)
    }
    return channel
  }

  /**
   * 把 log 行事件写入缓冲：超限时只淘汰最旧的 log 行，
   * 保证结构化事件（状态/测试/步骤/文件/汇总）全量保留。
   */
  function pushWithLogCap(
    channel: IExecutionChannel,
    event: TExecutionEvent,
  ): void {
    channel.buffer.push(event)

    if (event.type === 'log') {
      const logCount = channel.buffer.reduce(
        (count, item) => (item.type === 'log' ? count + 1 : count),
        0,
      )

      if (logCount > logCapacity) {
        const overflow = logCount - logCapacity
        removeOldestLogs(channel, overflow)
      }
    }
  }

  /** 从缓冲头部移除指定数量的最旧 log 行（保持整体顺序单调）。 */
  function removeOldestLogs(channel: IExecutionChannel, count: number): void {
    let remaining = count
    let index = 0

    while (remaining > 0 && index < channel.buffer.length) {
      if (channel.buffer[index].type === 'log') {
        channel.buffer.splice(index, 1)
        remaining -= 1
        continue
      }
      index += 1
    }
  }

  return {
    publish(executionId, draft) {
      const channel = channelOf(executionId)
      channel.lastSeq += 1
      const event = { ...draft, seq: channel.lastSeq } as TExecutionEvent

      pushWithLogCap(channel, event)

      for (const listener of channel.listeners) {
        listener(event)
      }
      return event
    },

    subscribe(executionId, afterSeq, listener) {
      const channel = channelOf(executionId)

      // 补发缓冲事件：afterSeq 之后的缺口；undefined 表示从头回放全部缓冲
      // （快照构建依赖该语义）；缓冲外的缺口由客户端改用快照接口恢复。
      for (const event of channel.buffer) {
        if (afterSeq === undefined || event.seq > afterSeq) {
          listener(event)
        }
      }
      channel.listeners.add(listener)

      return () => {
        channel.listeners.delete(listener)
      }
    },

    currentSeq(executionId) {
      return channelOf(executionId).lastSeq
    },

    dispose(executionId) {
      channels.delete(executionId)
    },
  }
}

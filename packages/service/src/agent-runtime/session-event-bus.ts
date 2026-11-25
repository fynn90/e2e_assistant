/**
 * 会话事件总线：客户端事件的 seq 分配、内存缓冲与订阅广播。
 *
 * 本模块是「会话内事件有序」语义的唯一负责人：
 *   - seq 统一分配——内存缓冲、物化存储、SSE 流三处序号一致；
 *   - ring buffer——每会话保留最近若干条事件，支撑短窗口断线补发；
 *   - 订阅广播——SSE 路由按 afterSeq 先补发缺口，再进入实时推送。
 *
 * 事件落盘（物化为工作块）通过 IWorkBlockStore 在发布时同步完成；
 * status / heartbeat / file_change 等瞬态事件由存储层自行忽略。
 */

import type {
  TAgentClientEvent,
  TAgentClientEventDraft,
} from '@charlie_deng/e2e-assistant-types'
import type { IWorkBlockStore } from './work-block-store'

/** 每会话内存缓冲的最大事件条数。 */
const DEFAULT_BUFFER_CAPACITY = 1000

/** 会话事件订阅的取消函数。 */
export type TEventUnsubscribe = () => void

/** 会话事件监听器。 */
export type TSessionEventListener = (event: TAgentClientEvent) => void

/** 会话事件总线接口。 */
export interface ISessionEventBus {
  /** 发布事件：分配 seq → 物化落盘 → 写缓冲 → 广播订阅者。 */
  publish (draft: TAgentClientEventDraft): TAgentClientEvent
  /** 订阅会话：先补发 afterSeq 之后的缓冲事件，再实时推送；返回取消订阅函数。 */
  subscribe (
    sessionId: string,
    afterSeq: number | undefined,
    listener: TSessionEventListener,
  ): TEventUnsubscribe
  /** 会话当前最大 seq（无事件时为 0）。 */
  currentSeq (sessionId: string): number
}

/** 单会话的总线状态。 */
interface ISessionChannel {
  /** 已分配的最大 seq。 */
  lastSeq: number
  /** 最近事件环形缓冲（数组头裁剪实现）。 */
  buffer: TAgentClientEvent[]
  /** 实时订阅者。 */
  listeners: Set<TSessionEventListener>
}

/**
 * 创建会话事件总线。
 *
 * @param options.blockStore - 工作块存储：发布时同步物化（瞬态事件由存储层忽略）。
 * @param options.bufferCapacity - 每会话内存缓冲容量，缺省 1000 条。
 * @returns 事件总线实例。
 */
export function createSessionEventBus (options: {
  blockStore: IWorkBlockStore
  bufferCapacity?: number
}): ISessionEventBus {
  const capacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY
  const channels = new Map<string, ISessionChannel>()

  /** 获取或创建会话通道；lastSeq 以物化存储为基准恢复，保证重启后序号连续。 */
  function channelOf (sessionId: string): ISessionChannel {
    let channel = channels.get(sessionId)
    if (!channel) {
      channel = {
        lastSeq: options.blockStore.maxSeq(sessionId),
        buffer: [],
        listeners: new Set(),
      }
      channels.set(sessionId, channel)
    }
    return channel
  }

  return {
    publish (draft: TAgentClientEventDraft): TAgentClientEvent {
      const channel = channelOf(draft.sessionId)
      channel.lastSeq += 1
      const event = { ...draft, seq: channel.lastSeq } as TAgentClientEvent

      // 物化落盘失败不阻断广播：展示恢复可降级，实时观看不能断。
      try {
        options.blockStore.applyEvent(event)
      } catch {
        // 静默降级：存储异常只影响历史恢复，不影响实时流。
      }

      channel.buffer.push(event)
      if (channel.buffer.length > capacity) {
        channel.buffer.splice(0, channel.buffer.length - capacity)
      }
      for (const listener of channel.listeners) {
        listener(event)
      }
      return event
    },

    subscribe (
      sessionId: string,
      afterSeq: number | undefined,
      listener: TSessionEventListener,
    ): TEventUnsubscribe {
      const channel = channelOf(sessionId)
      // 补发缓冲内 afterSeq 之后的事件；缓冲外的缺口由客户端改用 GET /blocks 全量恢复。
      if (afterSeq !== undefined) {
        for (const event of channel.buffer) {
          if (event.seq > afterSeq) {
            listener(event)
          }
        }
      }
      channel.listeners.add(listener)
      return () => {
        channel.listeners.delete(listener)
      }
    },

    currentSeq (sessionId: string): number {
      return channelOf(sessionId).lastSeq
    },
  }
}

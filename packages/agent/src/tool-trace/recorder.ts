/**
 * Agent 底层工具执行事件到持久化追踪记录的归并器。
 *
 * pi-agent-core 的开始、进度与结束事件分散发生；本类以 toolCallId 为主键将它们合并为
 * 一条可 UPSERT 的工具调用记录，并保留开始顺序供并行调用的稳定 UI 排序使用。
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { toJsonSafeValue } from './safe-value'
import type { IToolCallRecord } from './types'

/**
 * 工具调用归并器的构造选项。
 */
export interface IToolTraceRecorderOptions {
  /** 当前 Agent 会话 ID。 */
  sessionId: string
  /** 当前 Agent 运行 ID。 */
  runId: string
  /** 根据工具名解析用于展示的标签。 */
  resolveToolLabel?: (toolName: string) => string | undefined
}

/**
 * 将同一次运行的工具执行事件归并为工具调用记录。
 */
export class ToolTraceRecorder {
  /** 已收到事件的调用记录，键为 toolCallId。 */
  private readonly records = new Map<string, IToolCallRecord>()
  /** 下一条调用记录的稳定顺序。 */
  private nextSequence = 0

  /** 当前会话 ID。 */
  private readonly sessionId: string
  /** 当前运行 ID。 */
  private readonly runId: string
  /** 工具标签解析器。 */
  private readonly resolveToolLabel?: (toolName: string) => string | undefined

  /**
   * @param options - 会话、运行与工具标签解析配置。
   */
  constructor(options: IToolTraceRecorderOptions) {
    this.sessionId = options.sessionId
    this.runId = options.runId
    this.resolveToolLabel = options.resolveToolLabel
  }

  /**
   * 合并一个 Agent 事件。
   *
   * @param event - pi-agent-core 发出的底层事件。
   * @returns 受影响记录的副本；非工具事件返回 undefined。
   */
  apply(event: AgentEvent): IToolCallRecord | undefined {
    switch (event.type) {
      case 'tool_execution_start':
        return this.applyStart(event)
      case 'tool_execution_update':
        return this.applyUpdate(event)
      case 'tool_execution_end':
        return this.applyEnd(event)
      default:
        return undefined
    }
  }

  /**
   * 获取一个工具调用的当前记录副本。
   *
   * @param toolCallId - 模型分配的工具调用 ID。
   * @returns 当前记录；不存在返回 undefined。
   */
  get(toolCallId: string): IToolCallRecord | undefined {
    const record = this.records.get(toolCallId)
    return record ? cloneRecord(record) : undefined
  }

  /**
   * 处理工具开始事件。
   *
   * @param event - 工具开始事件。
   * @returns 创建或更新后的记录。
   */
  private applyStart(
    event: Extract<AgentEvent, { type: 'tool_execution_start' }>,
  ): IToolCallRecord {
    const existing = this.records.get(event.toolCallId)
    const now = Date.now()
    const record: IToolCallRecord = existing
      ? {
          ...existing,
          toolName: event.toolName,
          toolLabel: this.resolveToolLabel?.(event.toolName),
          args: toJsonSafeValue(event.args),
          status: 'running',
          updatedAt: now,
        }
      : {
          sessionId: this.sessionId,
          runId: this.runId,
          toolCallId: event.toolCallId,
          sequence: this.nextSequence++,
          toolName: event.toolName,
          toolLabel: this.resolveToolLabel?.(event.toolName),
          args: toJsonSafeValue(event.args),
          status: 'running',
          startedAt: now,
          updatedAt: now,
        }
    this.records.set(event.toolCallId, record)
    return cloneRecord(record)
  }

  /**
   * 处理工具进度事件。
   *
   * 防御性兼容少数底层实现先发 update 再发 start 的情况，保证记录不会丢失。
   *
   * @param event - 工具进度事件。
   * @returns 更新后的记录。
   */
  private applyUpdate(
    event: Extract<AgentEvent, { type: 'tool_execution_update' }>,
  ): IToolCallRecord {
    const record = this.getOrCreateRunningRecord(event)
    record.args = toJsonSafeValue(event.args)
    record.partialResult = toJsonSafeValue(event.partialResult)
    record.updatedAt = Date.now()
    this.records.set(event.toolCallId, record)
    return cloneRecord(record)
  }

  /**
   * 处理工具结束事件。
   *
   * @param event - 工具结束事件。
   * @returns 带最终结果和错误状态的记录。
   */
  private applyEnd(
    event: Extract<AgentEvent, { type: 'tool_execution_end' }>,
  ): IToolCallRecord {
    const record = this.getOrCreateRunningRecord(event)
    const now = Date.now()
    record.result = toJsonSafeValue(event.result)
    record.isError = event.isError
    record.status = event.isError ? 'failed' : 'succeeded'
    record.completedAt = now
    record.updatedAt = now
    this.records.set(event.toolCallId, record)
    return cloneRecord(record)
  }

  /**
   * 返回已有运行中记录，或为乱序事件创建最小记录。
   *
   * @param event - 带工具 ID、名称和参数的工具事件。
   * @returns 可继续更新的内部记录。
   */
  private getOrCreateRunningRecord(
    event: Extract<
      AgentEvent,
      { type: 'tool_execution_update' | 'tool_execution_end' }
    >,
  ): IToolCallRecord {
    const existing = this.records.get(event.toolCallId)
    if (existing) return existing

    const now = Date.now()
    const record: IToolCallRecord = {
      sessionId: this.sessionId,
      runId: this.runId,
      toolCallId: event.toolCallId,
      sequence: this.nextSequence++,
      toolName: event.toolName,
      toolLabel: this.resolveToolLabel?.(event.toolName),
      args:
        event.type === 'tool_execution_update'
          ? toJsonSafeValue(event.args)
          : {},
      status: 'running',
      startedAt: now,
      updatedAt: now,
    }
    this.records.set(event.toolCallId, record)
    return record
  }
}

/**
 * 复制 JSON 安全记录，防止监听方意外修改归并器内部状态。
 *
 * @param record - 源记录。
 * @returns 深拷贝记录。
 */
function cloneRecord(record: IToolCallRecord): IToolCallRecord {
  return JSON.parse(JSON.stringify(record)) as IToolCallRecord
}

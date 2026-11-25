/**
 * Agent 工具调用追踪领域类型。
 *
 * 本模块定义工具执行的持久化事实记录。记录保留供审计、恢复与模型会话关联使用的 JSON 安全
 * 数据；对客户端展示时必须再经 projector.ts 生成脱敏、截断的 ToolCallView。
 */

/**
 * 工具调用的最终或进行中状态。
 */
export type ToolCallStatus = 'running' | 'succeeded' | 'failed'

/**
 * 单次 Agent 工具调用的持久化记录。
 *
 * 所有 unknown 字段进入此对象前均应经过 `toJsonSafeValue` 规范化，确保 SQLite 与内存存储
 * 可以稳定复制和序列化。
 */
export interface IToolCallRecord {
  /** 所属会话 ID。 */
  sessionId: string
  /** 所属 Agent 运行 ID。 */
  runId: string
  /** 模型为该工具调用分配的唯一 ID。 */
  toolCallId: string
  /** 同一运行中的稳定展示顺序。 */
  sequence: number
  /** 工具机器名称。 */
  toolName: string
  /** 工具人类可读标签；未配置时为空。 */
  toolLabel?: string
  /** 已验证的工具参数。 */
  args: unknown
  /** 工具调用当前状态。 */
  status: ToolCallStatus
  /** 工具开始执行的时间戳（毫秒）。 */
  startedAt: number
  /** 最近一次记录更新的时间戳（毫秒）。 */
  updatedAt: number
  /** 工具最终结束时间戳（毫秒）。 */
  completedAt?: number
  /** 最近一次工具流式增量结果。 */
  partialResult?: unknown
  /** 最终工具执行结果。 */
  result?: unknown
  /** 最终结果是否被 Agent 标记为错误。 */
  isError?: boolean
}

/**
 * 查询会话工具调用记录的条件。
 */
export interface IToolCallQuery {
  /** 仅返回指定运行的调用记录。 */
  runId?: string
}

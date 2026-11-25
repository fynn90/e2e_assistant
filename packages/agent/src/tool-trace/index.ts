/**
 * Agent 工具调用追踪模块统一出口。
 *
 * 对外提供工具调用持久化类型、底层事件归并器与安全展示投影器，避免循环、会话存储和 SSE
 * 适配层分别实现不一致的关联、序列化或脱敏规则。
 */

export { ToolTraceRecorder, type IToolTraceRecorderOptions } from './recorder'
export { toToolCallView } from './projector'
export {
  toJsonSafeValue,
  toSafePreview,
  type TJsonSafeValue,
} from './safe-value'
export type { IToolCallQuery, IToolCallRecord, ToolCallStatus } from './types'

/**
 * 工具调用记录到客户端展示 DTO 的投影器。
 *
 * 本模块是工具审计数据跨越 Agent/Web 边界的唯一出口，集中保证 SSE 和 UI 不会接触到
 * 原始工具参数、完整命令输出或私有 details。
 */

import type { IToolCallView } from '@fynn90-e2e_assistant/types'
import { toSafePreview } from './safe-value'
import type { IToolCallRecord } from './types'

/**
 * 将完整持久化记录投影为安全的客户端展示对象。
 *
 * @param record - 含原始 JSON 安全参数和结果的工具调用记录。
 * @returns 可安全经 SSE 传给客户端的预览对象。
 */
export function toToolCallView (record: IToolCallRecord): IToolCallView {
  const args = toSafePreview(record.args)
  const partialResult =
    record.partialResult === undefined
      ? undefined
      : toSafePreview(record.partialResult)
  const result =
    record.result === undefined ? undefined : toSafePreview(record.result)

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    toolLabel: record.toolLabel,
    sequence: record.sequence,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    arguments: args.value,
    argumentsTruncated: args.truncated,
    ...(partialResult
      ? {
        partialResult: partialResult.value,
        partialResultTruncated: partialResult.truncated,
      }
      : {}),
    ...(result
      ? { result: result.value, resultTruncated: result.truncated }
      : {}),
    ...(record.isError === undefined ? {} : { isError: record.isError }),
  }
}

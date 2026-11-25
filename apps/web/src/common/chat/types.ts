/**
 * Web Chat 的展示状态类型。
 *
 * 工具步骤只保存服务端发来的安全投影，页面不得在此处追加或缓存原始工具参数与结果。
 */

import type { IToolCallView } from '@fynn90-e2e_assistant/types'

/**
 * Chat 消息的页面视图模型。
 */
export interface IChatMessageViewModel {
  /** 页面内唯一消息 ID。 */
  id: string
  /** 消息角色。 */
  role: 'user' | 'assistant'
  /** 用户文本或持续拼接的助手文本。 */
  content: string
  /** 当前消息请求状态。 */
  status: 'complete' | 'streaming' | 'failed' | 'stopped'
  /** 本轮模型使用的当前文件。 */
  contextFile?: { relativePath: string; version: string }
  /** 服务端返回的上下文处理告警。 */
  contextWarnings?: string[]
  /** 按工具调用 ID 合并的安全工具步骤。 */
  toolCalls?: IToolCallView[]
}

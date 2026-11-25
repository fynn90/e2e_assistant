/**
 * Skill Chat 的公共流式事件与工具调用展示契约。
 *
 * 本模块定义 CLI、Agent 服务和 Web 客户端之间共享的 Chat 数据结构；工具调用仅传递
 * 经服务端安全投影后的预览，不能用该类型承载原始工具参数、完整命令输出或私有 details。
 */

import type { TApiErrorCode } from './common'

/**
 * 客户端提交给 Skill Chat 的一条历史消息。
 */
export interface ISkillChatMessage {
  /** 消息角色。 */
  role: 'user' | 'assistant'
  /** 消息文本内容。 */
  content: string
}

/**
 * 创建 Skill Chat 请求的输入结构。
 */
export interface ICreateSkillChatRequest {
  /** 客户端维护的完整文本对话历史。 */
  messages: ISkillChatMessage[]
  /** 可选的当前文件版本，用于服务端并发修改校验。 */
  currentFile?: {
    /** Skill 内相对路径。 */
    relativePath: string
    /** 客户端读取时的文件版本。 */
    version: string
  }
}

/**
 * 一次模型调用的 Token 用量。
 */
export interface ISkillChatUsage {
  /** 输入 Token 数。 */
  inputTokens?: number
  /** 输出 Token 数。 */
  outputTokens?: number
}

/**
 * 工具调用执行状态。
 *
 * running 表示工具尚未结束；succeeded 和 failed 分别表示最终工具结果是否为错误。
 */
export type TToolCallStatus = 'running' | 'succeeded' | 'failed'

/**
 * 给客户端展示的安全工具调用投影。
 *
 * arguments、partialResult 和 result 已在服务端递归脱敏及截断；字段值只能用于展示，
 * 不可回传作为原始工具调用参数或审计证据。
 */
export interface IToolCallView {
  /** 模型分配的工具调用唯一标识，用于合并同一调用的 start/update/end 事件。 */
  toolCallId: string
  /** 工具机器名称。 */
  toolName: string
  /** 工具的人类可读标签；未配置时省略。 */
  toolLabel?: string
  /** 同一运行内的稳定展示顺序。 */
  sequence: number
  /** 当前执行状态。 */
  status: TToolCallStatus
  /** 工具开始执行的毫秒时间戳。 */
  startedAt: number
  /** 最终结束的毫秒时间戳；运行中时省略。 */
  completedAt?: number
  /** 当前展示的安全参数预览。 */
  arguments: unknown
  /** 参数是否因安全展示策略被截断或替换。 */
  argumentsTruncated: boolean
  /** 最近一次工具增量结果的安全预览。 */
  partialResult?: unknown
  /** 增量结果是否因安全展示策略被截断或替换。 */
  partialResultTruncated?: boolean
  /** 最终工具结果的安全预览。 */
  result?: unknown
  /** 最终结果是否因安全展示策略被截断或替换。 */
  resultTruncated?: boolean
  /** 最终结果是否被底层 Agent 标记为错误。 */
  isError?: boolean
}

/**
 * 工具调用流事件所处的生命周期阶段。
 */
export type TToolCallEventPhase = 'start' | 'update' | 'end'

/**
 * Skill Chat 的 SSE 事件联合类型。
 *
 * 工具事件始终携带完整的当前安全投影，客户端通过 toolCallId 原位更新步骤即可；文本回复
 * 仍使用 delta 事件增量拼接。
 */
export type TSkillChatEvent =
  | {
      /** 流已建立。 */
      type: 'start'
      /** HTTP 请求关联 ID。 */
      requestId: string
      /** 服务端为本次 Agent 运行分配的持久化会话 ID。 */
      sessionId: string
      /** 本轮实际注入模型的当前文件。 */
      currentFile?: { relativePath: string; version: string }
      /** 上下文截断等非致命告警。 */
      contextWarnings: string[]
      /** 是否截断了历史。 */
      historyTruncated: boolean
      /** 是否截断了当前文件。 */
      currentFileTruncated: boolean
    }
  | {
      /** 助手文本增量。 */
      type: 'delta'
      /** 本次新增文本。 */
      text: string
    }
  | {
      /** 工具调用生命周期更新。 */
      type: 'tool'
      /** 工具事件阶段。 */
      phase: TToolCallEventPhase
      /** 经脱敏和截断后的工具调用展示数据。 */
      tool: IToolCallView
    }
  | {
      /** 本轮正常结束。 */
      type: 'complete'
      /** 可选模型用量。 */
      usage?: ISkillChatUsage
    }
  | {
      /** 本轮发生可展示错误。 */
      type: 'error'
      /** 标准 API 错误码。 */
      code: TApiErrorCode
      /** 用户可读错误描述。 */
      message: string
    }

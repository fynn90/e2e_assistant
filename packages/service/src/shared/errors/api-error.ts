/**
 * 表示可安全返回给 HTTP 客户端的标准 API 错误。
 *
 * 位置说明（勿轻易搬回 http 层）：本文件承载「错误码 + 面向用户的消息 + 可选 HTTP 状态」，
 * 是 application 与 http 共同依赖的协议概念。它必须位于最底层——application 抛错、
 * http 映射状态码，两者都只依赖本文件。若把它挪回 http/，application 将反向依赖传输层，
 * 重新引入 application ↔ http 的循环依赖（见 PRD v18 §4.4）。
 */
import type {
  IEnvFileIssuePayload,
  TApiErrorCode,
} from '@authine-e2e-agent/types'

/**
 * 表示可安全返回给 HTTP 客户端的标准 API 错误。
 *
 * @param options - 错误码、HTTP 状态、用户可读消息和仅供服务端诊断的原因；
 *   `issues` 仅 ENV_FILE_INVALID 携带（v10），随错误响应透传给前端校验反馈区。
 * @returns 新建的 API 错误实例。
 * @throws 不主动抛出异常。
 */
export class ApiError extends Error {
  readonly code: TApiErrorCode
  readonly status: number
  readonly cause?: unknown
  /** 结构化问题明细；仅 env.json 校验失败（ENV_FILE_INVALID）时提供。 */
  readonly issues?: IEnvFileIssuePayload[]

  constructor(options: {
    code: TApiErrorCode
    status: number
    message: string
    cause?: unknown
    issues?: IEnvFileIssuePayload[]
  }) {
    super(options.message)
    this.name = 'ApiError'
    this.code = options.code
    this.status = options.status
    this.cause = options.cause
    this.issues = options.issues
  }
}

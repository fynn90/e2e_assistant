/**
 * 定义 Agent 生成 SKILL.md 时使用的稳定应用错误。
 *
 * 该错误只携带可展示的错误码和消息，不保存模型密钥、原始响应或文件内容。
 *
 * 位置说明：本文件原本位于 application/e2e-test-case/ 之下，但它不是业务编排逻辑，
 * 而是纯错误类型定义。agent-runtime 也需要抛出该错误，若它留在 application/ 内，
 * agent-runtime → application → …… 会与 application → agent-runtime 构成循环依赖。
 * 因此下沉到此处：application 与 agent-runtime 都只向下依赖它（见 PRD v18 §4.4）。
 */
import type { TApiErrorCode } from '@fynn90-e2e_assistant/types'

/** Agent 生成阶段允许映射到 HTTP 层的错误码。 */
export type TSkillDocumentAgentErrorCode = Extract<
  TApiErrorCode,
  | 'GENERATION_CANCELLED'
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_RESPONSE'
>

/**
 * Agent 生成错误。
 *
 * @param code - 稳定错误码。
 * @param message - 不包含敏感信息的用户可读消息。
 * @param cause - 仅供服务端诊断的原始异常，不会直接返回给客户端。
 */
export class SkillDocumentAgentError extends Error {
  readonly code: TSkillDocumentAgentErrorCode
  readonly cause?: unknown

  constructor(
    code: TSkillDocumentAgentErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'SkillDocumentAgentError'
    this.code = code
    this.cause = cause
  }
}

/** 判断未知值是否为 SKILL.md Agent 生成错误。 */
export function isSkillDocumentAgentError (
  error: unknown,
): error is SkillDocumentAgentError {
  return error instanceof SkillDocumentAgentError
}

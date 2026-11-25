/**
 * 将各域错误统一映射为 HTTP 层的 ApiError（错误码 + 状态码）。
 *
 * 位置说明：本映射器必须认识全部四类域错误（config / skill-manager / application / 目录浏览），
 * 因此它依赖各上层模块——这是 http 层的正向依赖，不构成环。
 * 与之相对，ApiError 类本身已下沉到 shared/errors/：application 只用类、不用映射器，
 * 这样既满足「业务层不依赖传输层」，又让状态码知识集中在 http 层（见 PRD v18 §4.2 L5）。
 */
import { SkillManagerError } from '@fynn90-e2e_assistant/skill-manager'
import type { IEnvFileIssuePayload } from '@fynn90-e2e_assistant/types'
import { ConfigValidationError } from '../config/config-store'
import {
  DirectoryBrowserError,
  type TDirectoryBrowserErrorCode,
} from '../shared/errors/directory-browser-error'
import {
  SkillDocumentAgentError,
  isSkillDocumentAgentError,
} from '../shared/errors/skill-document-errors'
import { ApiError } from '../shared/errors/api-error'

/**
 * 将未知应用异常归一化为标准 HTTP API 错误。
 *
 * @param error - 配置、存储、Agent 或未知来源的异常。
 * @returns 可被路由安全序列化的 API 错误。
 * @throws 不抛出异常。
 */
export function toApiError (error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error
  }

  if (error instanceof ConfigValidationError) {
    return new ApiError({
      code: 'CONFIG_INVALID',
      status: 400,
      message: error.message,
      cause: error,
    })
  }

  if (error instanceof SkillManagerError) {
    return new ApiError({
      code: error.code,
      status: getSkillManagerStatus(error.code),
      message: error.message,
      cause: error,
      // env.json 校验闸门把问题明细放在 cause.issues 中，此处透传给客户端
      // （v10 4.1：前端据此渲染「行:列 + 原因」反馈区）。
      issues: extractEnvFileIssues(error),
    })
  }

  if (isSkillDocumentAgentError(error)) {
    return new ApiError({
      code: error.code,
      status: getSkillDocumentAgentStatus(error.code),
      message: error.message,
      cause: error,
    })
  }

  if (error instanceof DirectoryBrowserError) {
    return new ApiError({
      code: error.code,
      status: getDirectoryBrowserStatus(error.code),
      message: error.message,
      cause: error,
    })
  }

  return new ApiError({
    code: 'INTERNAL_ERROR',
    status: 500,
    message: '服务内部错误，请稍后重试。',
    cause: error,
  })
}

function getSkillManagerStatus (code: SkillManagerError['code']): number {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'INVALID_SKILL_ID':
    case 'INVALID_FILE_PATH':
    case 'E2E_SCHEMA_INVALID':
    case 'E2E_SCHEMA_VERSION_UNSUPPORTED':
      return 400
    case 'SKILL_NOT_FOUND':
    case 'FILE_NOT_FOUND':
      return 404
    case 'SKILL_PERMISSION_DENIED':
    case 'FILE_PERMISSION_DENIED':
    case 'FILE_READ_ONLY':
      return 403
    case 'SKILL_ALREADY_EXISTS':
    case 'FILE_VERSION_CONFLICT':
    case 'SOURCE_HASH_CONFLICT':
    case 'FILE_ALREADY_EXISTS':
    case 'DIRECTORY_ALREADY_EXISTS':
      return 409
    case 'SKILL_DOCUMENT_INVALID':
      return 400
    case 'FILE_TOO_LARGE':
      return 413
    case 'FILE_NOT_SUPPORTED':
    case 'TREE_TOO_LARGE':
      return 422
    // v10：env.json 实体校验失败（区别于 409 版本冲突）。
    case 'ENV_FILE_INVALID':
      return 422
    // v14：userWorkSpace 相关——被同名文件占用属冲突（409），
    // 不可写属权限（403），创建失败属服务端 IO 问题（500）。
    case 'USER_WORKSPACE_OCCUPIED':
      return 409
    case 'USER_WORKSPACE_NOT_WRITABLE':
      return 403
    case 'ENV_KEY_RESERVED':
      return 422
    default:
      return 500
  }
}

/**
 * 从 SkillManagerError 的 cause 中提取 env.json 校验问题明细。
 *
 * @param error - Skill Manager 抛出的错误。
 * @returns 问题明细；非 ENV_FILE_INVALID 或结构不符时返回 undefined。
 * @throws 不抛出异常。
 */
function extractEnvFileIssues (
  error: SkillManagerError,
): IEnvFileIssuePayload[] | undefined {
  if (error.code !== 'ENV_FILE_INVALID') return undefined
  const cause = error.cause as { issues?: unknown } | undefined
  return Array.isArray(cause?.issues)
    ? (cause.issues as IEnvFileIssuePayload[])
    : undefined
}

/**
 * 将目录浏览错误映射为客户端可处理的 HTTP 状态码。
 *
 * @param code - 目录浏览错误码。
 * @returns 对应的 HTTP 状态码。
 * @throws 不抛出异常。
 */
function getDirectoryBrowserStatus (code: TDirectoryBrowserErrorCode): number {
  switch (code) {
    case 'INVALID_REQUEST':
      return 400
    case 'DIRECTORY_NOT_FOUND':
      return 404
    case 'DIRECTORY_ALREADY_EXISTS':
      return 409
    case 'DIRECTORY_NOT_ACCESSIBLE':
      return 403
    case 'DIRECTORY_TIMEOUT':
      return 504
  }
}

/**
 * 将 Agent 生成错误映射为客户端可处理的 HTTP 状态码。
 *
 * @param code - Agent 生成错误码。
 * @returns 对应的 HTTP 状态码。
 * @throws 不抛出异常。
 */
function getSkillDocumentAgentStatus (
  code: SkillDocumentAgentError['code'],
): number {
  switch (code) {
    case 'GENERATION_CANCELLED':
      return 400
    case 'LLM_AUTH_FAILED':
      return 401
    case 'LLM_RATE_LIMITED':
      return 429
    case 'LLM_TIMEOUT':
      return 504
    case 'LLM_UNAVAILABLE':
      return 503
    case 'LLM_INVALID_RESPONSE':
      return 502
  }
}

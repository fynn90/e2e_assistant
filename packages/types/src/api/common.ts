/**
 * 定义跨 API 共用的成功/错误信封和稳定错误码 Schema。
 */
import { z } from 'zod'

export const LOCAL_SERVICE_PROTOCOL_VERSION = 6

/**
 * 本地 CLI 服务在 `/health` 中自报身份时使用的固定标识。
 *
 * 客户端据此区分「本平台 CLI」与「恰好占用同一端口的其他服务」；
 * 硬编码多处易漂移，统一收敛到此常量。
 */
export const LOCAL_SERVICE_IDENTITY = 'authine-e2e-agent-cli'

export interface ILocalServiceHealthResponse {
  service: typeof LOCAL_SERVICE_IDENTITY
  status: 'ok'
  version: typeof LOCAL_SERVICE_PROTOCOL_VERSION
  /** 服务进程 PID。用于把「响应者」与运行态记录中的 PID 精确对应，避免 PID 复用导致误判。 */
  pid: number
}

/**
 * 识别「是本平台 CLI」所需的最小健康响应契约。
 *
 * 与 `ILocalServiceHealthResponse` 的差别：
 * - `version` 放宽为正整数，使客户端能识别出版本不匹配的真实 CLI，
 *   而不是把它误判成无关服务（`ILocalServiceHealthResponse.version` 是字面量类型，无法描述该场景）；
 * - `pid` 可选，兼容尚未上报 PID 的旧版本服务；缺失时调用方需按「无法精确确认」降级处理。
 */
export const localServiceHealthSchema = z.object({
  service: z.literal(LOCAL_SERVICE_IDENTITY),
  status: z.literal('ok'),
  version: z.number().int().positive(),
  pid: z.number().int().positive().optional(),
})

/** 解析后的服务健康响应；用于探测与校验本地 CLI 服务身份。 */
export type ILocalServiceProbeResponse = z.infer<
  typeof localServiceHealthSchema
>

export const apiErrorCodes = [
  'INVALID_REQUEST',
  'API_NOT_FOUND',
  'REQUEST_TOO_LARGE',
  'CONFIG_NOT_INITIALIZED',
  'CONFIG_INVALID',
  'CONFIG_CORRUPTED',
  'INVALID_SKILL_ID',
  'SKILL_NOT_FOUND',
  'SKILL_CORRUPTED',
  'SKILL_PERMISSION_DENIED',
  'SKILL_ALREADY_EXISTS',
  'INVALID_FILE_PATH',
  'FILE_NOT_FOUND',
  'FILE_NOT_SUPPORTED',
  'FILE_TOO_LARGE',
  'FILE_PERMISSION_DENIED',
  'FILE_READ_ONLY',
  'FILE_VERSION_CONFLICT',
  'FILE_ALREADY_EXISTS',
  'DIRECTORY_NOT_FOUND',
  'DIRECTORY_NOT_ACCESSIBLE',
  'DIRECTORY_ALREADY_EXISTS',
  'DIRECTORY_TIMEOUT',
  'E2E_SCHEMA_INVALID',
  'E2E_SCHEMA_VERSION_UNSUPPORTED',
  'SOURCE_HASH_CONFLICT',
  'PLAYWRIGHT_SCRIPT_INVALID',
  'SKILL_DOCUMENT_INVALID',
  'ENV_FILE_INVALID',
  'ENV_REFERENCE_MISSING',
  'ENV_FILE_UNAVAILABLE',
  'ENV_KEY_RESERVED',
  'USER_WORKSPACE_OCCUPIED',
  'USER_WORKSPACE_CREATE_FAILED',
  'USER_WORKSPACE_NOT_WRITABLE',
  'EXECUTION_PRECHECK_FAILED',
  'EXECUTION_NOT_FOUND',
  'GENERATION_CANCELLED',
  'TREE_TOO_LARGE',
  'LLM_AUTH_FAILED',
  'LLM_RATE_LIMITED',
  'LLM_TIMEOUT',
  'LLM_UNAVAILABLE',
  'LLM_INVALID_RESPONSE',
  'CHAT_CONCURRENCY_LIMITED',
  'INTERNAL_ERROR',
] as const

export const apiErrorCodeSchema = z.enum(apiErrorCodes)
export type TApiErrorCode = z.infer<typeof apiErrorCodeSchema>

/**
 * env.json 校验问题的错误负载结构（v10）。
 *
 * 与领域层 `IEnvFileIssue` 同构；仅在错误码为 `ENV_FILE_INVALID` 时
 * 随错误响应携带，供前端校验反馈区渲染「行:列 + 原因」。
 */
export const envFileIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    key: z.string().optional(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    /**
     * 建议跳转目标面板（v11 执行就绪校验扩展）：
     * `env-file` → env.json 编辑页；`test-case` → 用例编辑页。
     * 可选字段，保持 v10 既有负载兼容。
     */
    target: z.string().optional(),
  })
  .strict()

/** env.json 校验问题的错误负载类型。 */
export type IEnvFileIssuePayload = z.infer<typeof envFileIssueSchema>

export interface IApiSuccessResponse<TData> {
  success: true
  data: TData
}

export const apiErrorResponseSchema = z
  .object({
    success: z.literal(false),
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    /** 结构化问题明细；仅 `ENV_FILE_INVALID` 携带（v10，可选以保持旧响应兼容）。 */
    issues: z.array(envFileIssueSchema).optional(),
  })
  .strict()

export type IApiErrorResponse = z.infer<typeof apiErrorResponseSchema>

export interface IProjectFileItem {
  relativePath: string
  name: string
  kind: 'file' | 'directory'
  depth: number
}

export type IWorkspaceFilesResponse = IApiSuccessResponse<IProjectFileItem[]>

export type IRecordStartResponse = IApiSuccessResponse<{
  status: 'pending'
}>

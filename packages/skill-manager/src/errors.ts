import type { TApiErrorCode } from '@fynn90-e2e_assistant/types'

export type TSkillManagerErrorCode = Extract<
  TApiErrorCode,
  | 'INVALID_REQUEST'
  | 'INVALID_SKILL_ID'
  | 'SKILL_NOT_FOUND'
  | 'SKILL_CORRUPTED'
  | 'SKILL_PERMISSION_DENIED'
  | 'SKILL_ALREADY_EXISTS'
  | 'INVALID_FILE_PATH'
  | 'FILE_NOT_FOUND'
  | 'FILE_NOT_SUPPORTED'
  | 'FILE_TOO_LARGE'
  | 'FILE_PERMISSION_DENIED'
  | 'FILE_READ_ONLY'
  | 'FILE_VERSION_CONFLICT'
  | 'FILE_ALREADY_EXISTS'
  | 'DIRECTORY_ALREADY_EXISTS'
  | 'E2E_SCHEMA_INVALID'
  | 'E2E_SCHEMA_VERSION_UNSUPPORTED'
  | 'SOURCE_HASH_CONFLICT'
  | 'SKILL_DOCUMENT_INVALID'
  | 'ENV_FILE_INVALID'
  | 'ENV_KEY_RESERVED'
  | 'TREE_TOO_LARGE'
  | 'USER_WORKSPACE_OCCUPIED'
  | 'USER_WORKSPACE_CREATE_FAILED'
  | 'USER_WORKSPACE_NOT_WRITABLE'
  | 'INTERNAL_ERROR'
>

export class SkillManagerError extends Error {
  readonly code: TSkillManagerErrorCode
  readonly cause?: unknown

  constructor(code: TSkillManagerErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'SkillManagerError'
    this.code = code
    this.cause = cause
  }
}

export function isFileSystemPermissionError (error: unknown): boolean {
  const code = getFileSystemErrorCode(error)
  return code === 'EACCES' || code === 'EPERM'
}

export function isFileSystemMissingError (error: unknown): boolean {
  return getFileSystemErrorCode(error) === 'ENOENT'
}

export function getFileSystemErrorCode (error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined
  }

  return typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
}

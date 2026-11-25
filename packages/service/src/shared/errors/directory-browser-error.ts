/**
 * 定义目录浏览与目录创建操作的领域错误，供文件系统模块与 HTTP 适配层共用。
 *
 * 位置说明：与其它域错误集中在共享位置，便于「错误定义只此一处」。
 * 它本身不构成循环依赖（workspace 不引用 http），此处是归类决策而非破环要求。
 */
import type { TApiErrorCode } from '@charlie_deng/e2e-assistant-types'

/** 目录浏览模块可产生的稳定错误码。 */
export type TDirectoryBrowserErrorCode = Extract<
  TApiErrorCode,
  | 'DIRECTORY_NOT_FOUND'
  | 'DIRECTORY_NOT_ACCESSIBLE'
  | 'DIRECTORY_ALREADY_EXISTS'
  | 'DIRECTORY_TIMEOUT'
  | 'INVALID_REQUEST'
>

/**
 * 表示目录浏览或目录创建过程中的可预期失败。
 *
 * @param code 稳定错误码，供 HTTP 层映射为状态码。
 * @param message 面向用户的中文提示。
 * @param cause 仅用于服务端诊断的原始异常。
 */
export class DirectoryBrowserError extends Error {
  readonly code: TDirectoryBrowserErrorCode
  readonly cause?: unknown

  constructor(
    code: TDirectoryBrowserErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'DirectoryBrowserError'
    this.code = code
    this.cause = cause
  }
}

/** 定义 Playwright Engine 的结构化错误码、错误详情和错误类型。 */

/**
 * Playwright Engine 对外暴露的错误码。
 *
 * @returns 错误码联合类型，不产生运行时副作用。
 */
export type TPlaywrightEngineErrorCode =
  | 'BROWSER_NOT_INSTALLED'
  | 'BROWSER_INSTALL_FAILED'
  | 'BROWSER_INSTALL_CANCELLED'
  | 'BROWSER_INSTALL_TIMEOUT'
  | 'BROWSER_SESSION_START_FAILED'
  | 'BROWSER_SESSION_DISCONNECTED'
  | 'PAGE_ACCESS_FAILED'
  | 'PAGE_NAVIGATION_BLOCKED'
  | 'PAGE_VERIFICATION_FAILED'
  | 'PAGE_ACTION_FAILED'
  | 'PAGE_WAIT_TIMEOUT'
  | 'CREDENTIAL_RESOLUTION_FAILED'
  | 'NETWORK_DOCUMENT_BLOCKED'
  | 'SCRIPT_VALIDATION_FAILED'
  | 'DRY_RUN_FAILED'
  | 'DRY_RUN_CANCELLED'
  | 'DRY_RUN_TIMEOUT'
  | 'TEMP_WORKSPACE_ERROR'
  | 'PROCESS_TERMINATION_FAILED'
  | 'ENGINE_CONFIGURATION_INVALID'
  | 'FRAME_NOT_FOUND'
  | 'FRAME_ACCESS_BLOCKED'

/**
 * 错误所属的 Engine 组件。
 */
export type TPlaywrightEngineComponent =
  'chromium' | 'browser' | 'network' | 'validation' | 'dry-run' | 'workspace'

/**
 * 向宿主提供的可脱敏错误详情。
 */
export interface IPlaywrightEngineErrorDetails {
  /** 发生错误的组件。 */
  component: TPlaywrightEngineComponent
  /** 是否建议宿主在相同输入下重试。 */
  retryable: boolean
  /** 面向诊断的分类原因，不应包含原始秘密值。 */
  reason?: string
  /** 已耗费的时间，单位为毫秒。 */
  durationMs?: number
}

/**
 * 表示一个可被宿主稳定识别的 Engine 错误。
 *
 * @param code - 结构化错误码。
 * @param message - 已脱敏的用户可读消息。
 * @param details - 组件、重试建议和诊断原因。
 * @returns 可直接抛出或作为 cause 使用的错误对象。
 * @throws 不在构造阶段主动抛出异常。
 */
export class PlaywrightEngineError extends Error {
  readonly code: TPlaywrightEngineErrorCode
  readonly details: IPlaywrightEngineErrorDetails

  constructor(
    code: TPlaywrightEngineErrorCode,
    message: string,
    details: IPlaywrightEngineErrorDetails,
  ) {
    super(message)
    this.name = 'PlaywrightEngineError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * 判断未知异常是否为结构化 Engine 错误。
 *
 * @param error - 待判断的未知异常。
 * @returns 如果异常由 Playwright Engine 创建则返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
export function isPlaywrightEngineError(
  error: unknown,
): error is PlaywrightEngineError {
  return error instanceof PlaywrightEngineError
}

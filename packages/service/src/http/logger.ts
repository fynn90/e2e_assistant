import type { TApiErrorCode } from '@charlie_deng/e2e-assistant-types'

export interface IHttpRequestLogEntry {
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
  errorCode?: TApiErrorCode
}

export interface IHttpLogger {
  request (entry: IHttpRequestLogEntry): void
  error (entry: IHttpRequestLogEntry, cause?: unknown): void
}

/**
 * 判定一条请求日志是否属于噪声（只影响是否打印，不影响请求处理与响应）。
 *
 * 静态资源请求的成功日志是噪声：一次页面加载会产生二十余行 `/assets/*.js` 记录，
 * 把有价值的 API 与错误日志淹没。失败（status ≥ 400）仍然记录——静态资源缺失
 * 往往是「前端产物没构建」的线索，不能静默。
 *
 * 规则只在这里一处，app 层只负责调用。
 *
 * @param entry - 已完成请求的日志条目。
 * @returns 应当静默时返回 true。
 * @throws 不抛出异常。
 */
export function isQuietHttpRequest (entry: IHttpRequestLogEntry): boolean {
  return entry.status < 400 && entry.path.startsWith('/assets/')
}

export const consoleHttpLogger: IHttpLogger = {
  request (entry) {
    console.info(
      `[http] ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms requestId=${entry.requestId}`,
    )
  },
  error (entry) {
    console.error(
      `[http] ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms requestId=${entry.requestId} code=${entry.errorCode ?? 'INTERNAL_ERROR'}`,
    )
  },
}

/**
 * 提供 Web 工作台访问本地 CLI HTTP API 的统一请求、响应校验与错误分类能力。
 */
import type { IApiErrorResponse, TApiErrorCode } from '@fynn90-e2e_assistant/types'

export class ApiClientError extends Error {
  readonly status: number
  readonly code?: TApiErrorCode
  readonly requestId?: string
  readonly kind: 'api' | 'network' | 'protocol' | 'aborted'
  /** 结构化问题明细（v11：执行就绪校验失败 422 携带，供就绪摘要渲染）。 */
  readonly issues?: Array<{ code: string; message: string; target?: string }>

  constructor(options: {
    message: string
    status?: number
    code?: TApiErrorCode
    requestId?: string
    kind?: ApiClientError['kind']
    issues?: Array<{ code: string; message: string; target?: string }>
  }) {
    super(options.message)
    this.name = 'ApiClientError'
    this.status = options.status ?? 0
    this.code = options.code
    this.requestId = options.requestId
    this.kind = options.kind ?? 'api'
    this.issues = options.issues
  }
}

interface IRequestJsonOptions {
  // PATCH 为 v17 会话重命名（`PATCH /api/agent/sessions/:id`）所需。
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/**
 * 请求本地 CLI JSON API，并统一处理网络、协议和业务错误。
 * @param options 请求路径、方法、请求体及取消信号。
 * @returns 解析后的 API 响应数据。
 * @throws 当请求失败、响应协议错误或 API 返回业务错误时抛出 ApiClientError。
 */
export async function requestJson<TResponse> (
  options: IRequestJsonOptions,
): Promise<TResponse> {
  let response: Response

  try {
    response = await fetch(options.path, {
      method: options.method ?? 'GET',
      headers:
        options.body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'same-origin',
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiClientError({ message: '请求已停止。', kind: 'aborted' })
    }

    throw new ApiClientError({
      message: `无法连接 CLI 服务（端口 ${getConfiguredCliPort()}），请确认 CLI 服务已启动。`,
      kind: 'network',
    })
  }

  if (response.status === 204) {
    return undefined as TResponse
  }

  const contentType = response.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiClientError({
      message: `当前请求未到达 CLI 服务，端口 ${getConfiguredCliPort()} 返回了非 JSON 响应。请检查 Web 与 CLI 的端口配置，或停止占用该端口的其他服务。`,
      status: response.status,
      kind: 'protocol',
    })
  }

  let responseData: unknown

  try {
    responseData = await response.json()
  } catch {
    throw new ApiClientError({
      message: 'CLI 服务返回了无法解析的 JSON 响应，请重启 CLI 服务。',
      status: response.status,
      kind: 'protocol',
    })
  }

  if (!response.ok) {
    const errorResponse = responseData as Partial<IApiErrorResponse>
    throw new ApiClientError({
      message: errorResponse.message || '请求失败，请稍后重试。',
      status: response.status,
      code: errorResponse.code,
      requestId: errorResponse.requestId,
      kind: 'api',
      // 执行就绪校验失败（422）等问题明细随错误透出，供就绪摘要展示（v11）。
      ...(Array.isArray(errorResponse.issues)
        ? { issues: errorResponse.issues }
        : {}),
    })
  }

  return responseData as TResponse
}

/**
 * 判断异常是否由用户主动取消请求导致。
 * @param error 待判断的未知异常。
 * @returns 异常名称为 AbortError 时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
function isAbortError (error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError',
  )
}

/**
 * 返回当前 Web 构建注入的 CLI 代理端口，兼容未经过 Vite 注入的测试环境。
 * @returns CLI 代理端口文本。
 * @throws 不抛出异常。
 */
function getConfiguredCliPort (): string {
  return typeof __AUTHINE_CLI_PORT__ === 'string'
    ? __AUTHINE_CLI_PORT__
    : '5826'
}

declare const __AUTHINE_CLI_PORT__: string

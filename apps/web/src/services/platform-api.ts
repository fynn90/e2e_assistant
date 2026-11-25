/**
 * 提供平台配置和本地 CLI 健康状态 API 调用。
 */
import {
  LOCAL_SERVICE_IDENTITY,
  LOCAL_SERVICE_PROTOCOL_VERSION,
  localServiceHealthSchema,
  type IGetConfigResponse,
  type IInitializeConfigRequest,
  type IInitializeConfigSuccessResponse,
  type ILocalServiceHealthResponse,
  type IUpdateConfigRequest,
  type IUpdateConfigResponse,
} from '@fynn90-e2e_assistant/types'
import { ApiClientError, requestJson } from './http-client'

/**
 * 请求本地 CLI 健康状态，并校验服务身份与协议版本。
 * @param signal 可选的请求取消信号。
 * @returns 通过校验的本地服务健康响应。
 * @throws 当服务不是 CLI、健康状态非法或协议版本不兼容时抛出协议错误。
 */
export async function fetchLocalServiceHealth (
  signal?: AbortSignal,
): Promise<ILocalServiceHealthResponse> {
  const response = await requestJson<unknown>({ path: '/health', signal })

  if (!isLocalServiceHealthResponse(response)) {
    throw new ApiClientError({
      message: `连接到的本地服务不是兼容的 CLI 服务（期望协议版本 ${LOCAL_SERVICE_PROTOCOL_VERSION}）。请确认 AUTHINE_CLI_PORT 配置正确。`,
      kind: 'protocol',
    })
  }

  return response
}

/**
 * 请求平台配置状态。
 * @param signal 可选的请求取消信号。
 * @returns 平台配置状态响应。
 * @throws 当本地 API 请求失败时抛出客户端异常。
 */
export function fetchConfigStatus (
  signal?: AbortSignal,
): Promise<IGetConfigResponse> {
  return requestJson({ path: '/api/config', signal })
}

/**
 * 提交平台首次初始化配置。
 * @param payload 初始化配置请求体。
 * @returns 初始化成功响应。
 * @throws 当本地 API 请求失败时抛出客户端异常。
 */
export function submitInitialization (
  payload: IInitializeConfigRequest,
): Promise<IInitializeConfigSuccessResponse> {
  return requestJson({
    path: '/api/config/init',
    method: 'POST',
    body: payload,
  })
}

/**
 * 更新平台配置。
 * @param payload 平台配置更新请求体。
 * @returns 配置更新成功响应。
 * @throws 当本地 API 请求失败时抛出客户端异常。
 */
export function updatePlatformConfig (
  payload: IUpdateConfigRequest,
): Promise<IUpdateConfigResponse> {
  return requestJson({ path: '/api/config', method: 'PUT', body: payload })
}

function isLocalServiceHealthResponse (
  value: unknown,
): value is ILocalServiceHealthResponse {
  const parsedHealth = localServiceHealthSchema.safeParse(value)

  // Web 端要求协议版本严格一致：版本不匹配意味着前后端能力集不同，必须显式报错。
  return (
    parsedHealth.success &&
    parsedHealth.data.version === LOCAL_SERVICE_PROTOCOL_VERSION &&
    parsedHealth.data.service === LOCAL_SERVICE_IDENTITY
  )
}

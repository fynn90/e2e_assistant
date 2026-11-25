/**
 * 提供目录选择器所需的本地文件系统浏览 API 调用。
 */
import type {
  IBrowseRootsResponse,
  ICreateDirectoryRequest,
  ICreateDirectoryResponse,
  IListDirectoryResponse,
} from '@fynn90-e2e_assistant/types'
import { requestJson } from '../../../services/http-client'

/**
 * 请求指定目录下的子目录列表。
 * @param options 待浏览目录路径与可选的请求取消信号；路径缺省时由服务端决定起始位置。
 * @returns 单层目录浏览响应。
 * @throws 当目录不存在、无权限访问或本地 API 请求失败时抛出客户端异常。
 */
export function fetchDirectoryListing (options: {
  path?: string
  signal?: AbortSignal
}): Promise<IListDirectoryResponse> {
  const queryPath = options.path
    ? `?path=${encodeURIComponent(options.path)}`
    : ''

  return requestJson({
    path: `/api/fs/directories${queryPath}`,
    signal: options.signal,
  })
}

/**
 * 请求目录选择器可用的起始位置集合。
 * @param signal 可选的请求取消信号。
 * @returns 起始位置响应。
 * @throws 当本地 API 请求失败时抛出客户端异常。
 */
export function fetchBrowseRoots (
  signal?: AbortSignal,
): Promise<IBrowseRootsResponse> {
  return requestJson({ path: '/api/fs/roots', signal })
}

/**
 * 在指定父目录下创建新目录。
 * @param payload 父目录路径与新建目录名称。
 * @returns 新建目录响应。
 * @throws 当名称非法、目录重名、无写入权限或本地 API 请求失败时抛出客户端异常。
 */
export function createDirectory (
  payload: ICreateDirectoryRequest,
): Promise<ICreateDirectoryResponse> {
  return requestJson({
    path: '/api/fs/directories',
    method: 'POST',
    body: payload,
  })
}

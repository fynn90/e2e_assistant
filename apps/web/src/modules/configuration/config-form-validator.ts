// 平台配置表单校验：在浏览器端镜像可确定的后端更新规则。
import type { IUpdateConfigRequest } from '@charlie_deng/e2e-assistant-types'

export type TConfigFieldName = keyof IUpdateConfigRequest
export type TConfigFieldErrors = Partial<Record<TConfigFieldName, string>>

export interface IConfigValidationResult {
  valid: boolean
  errors: TConfigFieldErrors
  payload?: IUpdateConfigRequest
}

/**
 * 校验并规范化平台配置更新载荷。
 * @param payload 用户当前输入的配置载荷。
 * @returns 校验结果；成功时包含可提交的规范化载荷。
 * @throws 不抛出异常，字段错误通过结果对象返回。
 */
export function validateConfigUpdate (
  payload: IUpdateConfigRequest,
): IConfigValidationResult {
  const errors: TConfigFieldErrors = {}
  const projectDirectory = payload.projectDirectory.trim()
  const llmApiKey = payload.llmApiKey?.trim() ?? ''
  const llmModelName = payload.llmModelName.trim()
  let llmApiBaseUrl = ''

  if (!projectDirectory) {
    errors.projectDirectory = '请先选择项目目录。'
  }

  if (!llmModelName) {
    errors.llmModelName = '请先输入大模型模型名称。'
  }

  const apiBaseUrlResult = normalizeApiBaseUrl(payload.llmApiBaseUrl)

  if (apiBaseUrlResult.error) {
    errors.llmApiBaseUrl = apiBaseUrlResult.error
  } else {
    llmApiBaseUrl = apiBaseUrlResult.value
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors }
  }

  return {
    valid: true,
    errors,
    payload: {
      projectDirectory,
      llmApiKey,
      llmApiBaseUrl,
      llmModelName,
    },
  }
}

/**
 * 校验并规范化大模型 API 根地址。
 * @param apiBaseUrl 用户输入的 API 地址。
 * @returns 规范化地址或对应的字段错误。
 * @throws 不抛出异常，URL 解析失败会返回错误文本。
 */
export function normalizeApiBaseUrl (
  apiBaseUrl: string,
): { value: string; error?: undefined } | { value: ''; error: string } {
  const normalizedApiBaseUrl = apiBaseUrl.trim()

  if (!normalizedApiBaseUrl) {
    return { value: '', error: '请先输入大模型 API 地址。' }
  }

  let parsedApiBaseUrl: URL

  try {
    parsedApiBaseUrl = new URL(normalizedApiBaseUrl)
  } catch {
    return { value: '', error: '大模型 API 地址格式不正确，请输入合法的 URL。' }
  }

  if (
    parsedApiBaseUrl.protocol !== 'https:' &&
    parsedApiBaseUrl.protocol !== 'http:'
  ) {
    return { value: '', error: '大模型 API 地址只支持 HTTP 或 HTTPS。' }
  }

  if (parsedApiBaseUrl.username || parsedApiBaseUrl.password) {
    return { value: '', error: '大模型 API 地址不能包含用户名或密码。' }
  }

  if (parsedApiBaseUrl.hash || parsedApiBaseUrl.search) {
    return { value: '', error: '大模型 API 地址不能包含 query 或 fragment。' }
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

  if (
    parsedApiBaseUrl.protocol === 'http:' &&
    !loopbackHosts.has(parsedApiBaseUrl.hostname)
  ) {
    return {
      value: '',
      error: '大模型 API 地址必须使用 HTTPS，仅本机 loopback 地址允许 HTTP。',
    }
  }

  const normalizedPath = parsedApiBaseUrl.pathname.replace(/\/+$/, '')

  if (normalizedPath.toLowerCase().endsWith('/chat/completions')) {
    return {
      value: '',
      error:
        '大模型 API 地址应填写 API 根地址，而不是完整的 chat/completions 地址。',
    }
  }

  parsedApiBaseUrl.pathname = normalizedPath || '/'
  return { value: parsedApiBaseUrl.toString().replace(/\/$/, '') }
}

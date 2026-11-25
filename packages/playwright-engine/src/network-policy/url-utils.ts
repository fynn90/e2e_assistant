/** 提供网络策略共享的 URL 规范化、同源判断和安全文本处理辅助函数。 */

import { PlaywrightEngineError } from '../contracts/errors'

/**
 * 将输入规范化为 HTTP/HTTPS URL。
 *
 * @param value - 待解析的 URL 文本。
 * @param fieldName - 出错时用于诊断的字段名。
 * @returns 规范化后的 URL 对象。
 * @throws 输入不是 HTTP/HTTPS URL 时抛出配置错误。
 */
export function normalizeHttpUrl(value: string, fieldName = 'url'): URL {
  try {
    const url = new URL(value)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol')
    }

    if (url.username || url.password) {
      throw new Error('credentials are not allowed')
    }

    return url
  } catch {
    throw new PlaywrightEngineError(
      'ENGINE_CONFIGURATION_INVALID',
      `${fieldName} 必须是无凭据的 HTTP 或 HTTPS URL。`,
      {
        component: 'network',
        retryable: false,
        reason: 'invalid-url',
      },
    )
  }
}

/**
 * 相对于安全基准 URL 解析页面导航地址。
 *
 * @param value - 绝对或相对导航地址。
 * @param baseUrl - 用于解析相对地址的 HTTP/HTTPS 基准 URL。
 * @returns 合法的 HTTP/HTTPS URL，无法解析时返回 null。
 * @throws 不抛出异常。
 */
export function resolveHttpUrl(
  value: string,
  baseUrl: string | URL,
): URL | null {
  try {
    const base = typeof baseUrl === 'string' ? new URL(baseUrl) : baseUrl
    const url = new URL(value, base)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

/**
 * 判断两个 URL 是否属于同一 origin。
 *
 * @param left - 第一个 URL 文本或对象。
 * @param right - 第二个 URL 文本或对象。
 * @returns 两者 origin 相同且均为 HTTP/HTTPS 时返回 true。
 * @throws URL 无法解析时返回 false。
 */
export function isSameOrigin(left: string | URL, right: string | URL): boolean {
  try {
    const leftUrl = typeof left === 'string' ? new URL(left) : left
    const rightUrl = typeof right === 'string' ? new URL(right) : right
    return (
      leftUrl.origin === rightUrl.origin &&
      !leftUrl.username &&
      !leftUrl.password &&
      !rightUrl.username &&
      !rightUrl.password &&
      (leftUrl.protocol === 'http:' || leftUrl.protocol === 'https:') &&
      (rightUrl.protocol === 'http:' || rightUrl.protocol === 'https:')
    )
  } catch {
    return false
  }
}

/**
 * 移除凭据并替换常见敏感查询参数，避免阻断事件泄露秘密。
 *
 * @param value - 可能包含凭据或 Token 的 URL 文本。
 * @param maxLength - 输出最大长度。
 * @returns 安全的 URL 文本。
 * @throws 不抛出异常。
 */
export function sanitizeUrl(value: string, maxLength = 2_048): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (
        /(pass(word)?|token|secret|api[_-]?key|authorization|auth|code)/i.test(
          key,
        )
      ) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    url.hash = ''
    const sanitized = url.toString()
    return sanitized.length > maxLength
      ? `${sanitized.slice(0, maxLength)}…`
      : sanitized
  } catch {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
  }
}

/**
 * 判断 Playwright 请求类型是否为主文档。
 *
 * @param resourceType - Playwright 请求资源类型。
 * @returns 文档请求返回 true。
 * @throws 不抛出异常。
 */
export function isDocumentResourceType(resourceType: string): boolean {
  return resourceType === 'document'
}

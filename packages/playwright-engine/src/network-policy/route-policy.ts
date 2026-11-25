/** 封装 Playwright 路由请求的文档/子资源判定和阻断行为。 */

import type { Route } from 'playwright'
import { isDocumentResourceType, isSameOrigin, sanitizeUrl } from './url-utils'

/**
 * RoutePolicy 的构造配置。
 */
export interface IRoutePolicyOptions {
  baseUrl: URL
  allowSubresources: boolean
  allowedOrigins?: ReadonlySet<string>
  onBlocked?: (url: string, resourceType: string) => void
}

/**
 * 对单个请求执行同源和子资源例外判断。
 */
export class RoutePolicy {
  private readonly baseUrl: URL
  private readonly allowSubresources: boolean
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly onBlocked?: (url: string, resourceType: string) => void

  /**
   * 创建请求路由判定器。
   *
   * @param options - baseUrl、子资源开关和额外 origin。
   * @returns 可供 BrowserContext route 回调使用的判定器。
   * @throws 不抛出异常；URL 已由调用方完成规范化。
   */
  constructor(options: IRoutePolicyOptions) {
    this.baseUrl = options.baseUrl
    this.allowSubresources = options.allowSubresources
    this.allowedOrigins = options.allowedOrigins ?? new Set<string>()
    this.onBlocked = options.onBlocked
  }

  /**
   * 判断主文档是否属于基准 origin。
   *
   * @param url - 文档 URL。
   * @returns 同源或显式允许的文档返回 true。
   * @throws URL 无法解析时返回 false。
   */
  isAllowedDocument(url: string): boolean {
    return isSameOrigin(url, this.baseUrl)
  }

  /**
   * 判断子资源是否可继续请求。
   *
   * @param url - 资源 URL。
   * @param resourceType - Playwright 资源类型。
   * @returns 同源资源或开启例外的跨源子资源返回 true。
   * @throws 不抛出异常。
   */
  isAllowedSubresource(url: string, resourceType: string): boolean {
    if (isDocumentResourceType(resourceType)) {
      return this.isAllowedDocument(url)
    }

    if (isSameOrigin(url, this.baseUrl)) {
      return true
    }

    if (!this.allowSubresources) {
      return false
    }

    try {
      return (
        this.allowedOrigins.size === 0 ||
        this.allowedOrigins.has(new URL(url).origin)
      )
    } catch {
      return false
    }
  }

  /**
   * 阻断请求并发布一个不含凭据的诊断回调。
   *
   * @param route - Playwright 路由对象。
   * @param url - 被阻断 URL。
   * @param resourceType - 资源类型。
   * @returns 路由 abort 完成的 Promise。
   * @throws Playwright abort 失败时抛出底层异常。
   */
  async abort(route: Route, url: string, resourceType: string): Promise<void> {
    this.onBlocked?.(sanitizeUrl(url), resourceType)
    await route.abort('blockedbyclient')
  }
}

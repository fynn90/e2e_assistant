/** 实现默认同源网络策略，限制主动文档导航并分类处理页面子资源。 */

import type { BrowserContext } from 'playwright'
import { publishEngineEvent, type IEngineEventSink } from '../contracts/events'
import type { INetworkPolicy, INetworkRouteOptions } from '../contracts/network'
import {
  isDocumentResourceType,
  isSameOrigin,
  normalizeHttpUrl,
  resolveHttpUrl,
  sanitizeUrl,
} from './url-utils'
import { RoutePolicy } from './route-policy'

/**
 * 默认的 baseUrl 同源网络策略。
 */
export class SameOriginNetworkPolicy implements INetworkPolicy {
  readonly baseUrl: string
  private readonly baseUrlObject: URL
  private readonly eventSink?: IEngineEventSink
  private readonly routePolicy: RoutePolicy

  /**
   * 创建同源策略。
   *
   * @param baseUrl - 允许主动导航的基准 URL。
   * @param options - 可选事件 sink 和跨源子资源配置。
   * @returns 可安装到 Playwright context 的网络策略。
   * @throws baseUrl 非 HTTP/HTTPS 或包含凭据时抛出配置错误。
   */
  constructor(
    baseUrl: string,
    options: {
      allowSubresources?: boolean
      allowedOrigins?: ReadonlySet<string>
      eventSink?: IEngineEventSink
    } = {},
  ) {
    this.baseUrlObject = normalizeHttpUrl(baseUrl, 'baseUrl')
    this.baseUrl = this.baseUrlObject.toString()
    this.eventSink = options.eventSink
    this.routePolicy = new RoutePolicy({
      baseUrl: this.baseUrlObject,
      allowSubresources: options.allowSubresources ?? true,
      allowedOrigins: options.allowedOrigins,
      onBlocked: (url, resourceType) => {
        publishEngineEvent(this.eventSink, {
          type: 'network.blocked',
          url: sanitizeUrl(url),
          resourceType,
        })
      },
    })
  }

  /**
   * 判断主动导航是否位于 baseUrl 同源范围。
   *
   * @param url - 主动导航 URL。
   * @returns 同源 HTTP/HTTPS URL 返回 true，否则返回 false。
   * @throws 不抛出异常。
   */
  assertNavigable(url: string): boolean {
    const target = resolveHttpUrl(url, this.baseUrlObject)
    return target ? isSameOrigin(target, this.baseUrlObject) : false
  }

  /**
   * 判断主文档请求是否允许跟随。
   *
   * @param url - 文档 URL。
   * @param baseUrl - 可选的策略基准 URL，缺省使用构造时的 baseUrl。
   * @returns 同源文档返回 true，否则返回 false。
   * @throws 不抛出异常。
   */
  isAllowedDocument(url: string, baseUrl = this.baseUrl): boolean {
    const target = resolveHttpUrl(url, baseUrl)
    const base = resolveHttpUrl(baseUrl, baseUrl)
    return Boolean(target && base && isSameOrigin(target, base))
  }

  /**
   * 为浏览器上下文安装文档和子资源路由拦截器。
   *
   * @param context - Playwright 浏览器上下文。
   * @param options - 可选的路由覆盖配置。
   * @returns 路由安装完成的 Promise。
   * @throws Playwright 无法注册路由时抛出底层异常。
   */
  async installRoute(
    context: BrowserContext,
    options?: INetworkRouteOptions,
  ): Promise<void> {
    const policy =
      options === undefined
        ? this.routePolicy
        : new RoutePolicy({
            baseUrl: normalizeHttpUrl(
              options.baseUrl ?? this.baseUrl,
              'baseUrl',
            ),
            allowSubresources: options.allowSubresources ?? true,
            allowedOrigins: options.allowedOrigins,
            onBlocked: (url, resourceType) => {
              publishEngineEvent(this.eventSink, {
                type: 'network.blocked',
                url: sanitizeUrl(url),
                resourceType,
              })
            },
          })

    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = request.url()
      const resourceType = request.resourceType()

      if (
        isDocumentResourceType(resourceType) &&
        !policy.isAllowedDocument(url)
      ) {
        await policy.abort(route, url, resourceType)
        return
      }

      if (!policy.isAllowedSubresource(url, resourceType)) {
        await policy.abort(route, url, resourceType)
        return
      }

      await route.continue()
    })
  }
}

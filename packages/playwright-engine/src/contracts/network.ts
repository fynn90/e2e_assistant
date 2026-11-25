/** 定义浏览器主动导航与页面子资源路由的安全策略契约。 */

import type { TBrowserContext } from './browser'

/**
 * 浏览器路由安装选项。
 */
export interface INetworkRouteOptions {
  baseUrl?: string
  allowSubresources?: boolean
  allowedOrigins?: ReadonlySet<string>
}

/**
 * 控制页面文档和子资源网络访问范围的策略。
 */
export interface INetworkPolicy {
  readonly baseUrl: string
  /**
   * 判断主动导航是否允许。
   *
   * @param url - 调用方准备导航到的 URL。
   * @returns URL 属于允许的同源文档范围时返回 true，否则返回 false。
   * @throws 不抛出异常；调用方应将 false 映射为结构化拒绝。
   */
  assertNavigable(url: string): boolean
  /**
   * 判断文档 URL 是否可被页面路由跟随。
   *
   * @param url - 文档请求 URL。
   * @param baseUrl - 作为策略基准的 URL。
   * @returns 同源或显式允许的文档返回 true。
   * @throws URL 无法解析时返回 false。
   */
  isAllowedDocument(url: string, baseUrl?: string): boolean
  /**
   * 在 Playwright context 上安装资源级路由策略。
   *
   * @param context - Playwright BrowserContext。
   * @param options - 子资源例外和额外 origin 配置。
   * @returns 路由安装完成的 Promise 或 void。
   * @throws Playwright 路由安装失败时抛出底层错误。
   */
  installRoute(
    context: TBrowserContext,
    options?: INetworkRouteOptions,
  ): Promise<void> | void
}

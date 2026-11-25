/** 创建真实 Playwright Chromium 浏览器会话并安装默认网络策略。 */

import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserType } from 'playwright'
import type {
  IBrowserSession,
  IBrowserSessionFactory,
  IBrowserSessionOptions,
} from '../contracts/browser'
import { PLATFORM_BROWSER_ENV } from '../contracts/browser-env'
import { PlaywrightEngineError } from '../contracts/errors'
import { createDefaultRedactor } from '../observability/redaction'
import { normalizeHttpUrl } from '../network-policy/url-utils'
import { SameOriginNetworkPolicy } from '../network-policy/same-origin-policy'
import { PlaywrightBrowserSession } from './playwright-browser-session'

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

/**
 * 浏览器会话工厂的 Playwright 适配器配置。
 */
export interface IBrowserSessionFactoryOptions {
  browserType?: BrowserType
  sessionIdFactory?: () => string
}

/**
 * 使用 Playwright Chromium 创建页面会话。
 */
export class PlaywrightBrowserSessionFactory implements IBrowserSessionFactory {
  private readonly browserType: BrowserType
  private readonly sessionIdFactory: () => string

  /**
   * 创建浏览器会话工厂。
   *
   * @param options - 可选 BrowserType 和会话 ID 生成器。
   * @returns 可替换 Playwright 启动细节的工厂。
   * @throws 不抛出异常。
   */
  constructor(options: IBrowserSessionFactoryOptions = {}) {
    this.browserType = options.browserType ?? chromium
    this.sessionIdFactory =
      options.sessionIdFactory ?? (() => `browser:${randomUUID()}`)
  }

  /**
   * 启动有头或无头 Chromium，并返回资源所有权明确的会话。
   *
   * @param options - 浏览器模式、Base URL、超时、网络策略和取消信号。
   * @returns 已创建并安装网络策略的浏览器会话。
   * @throws 配置无效、取消或浏览器启动失败时抛出结构化 Engine 错误。
   */
  async create(options: IBrowserSessionOptions): Promise<IBrowserSession> {
    if (options.signal?.aborted) {
      throw new PlaywrightEngineError(
        'BROWSER_SESSION_START_FAILED',
        '浏览器会话启动已取消。',
        { component: 'browser', retryable: false, reason: 'cancelled' },
      )
    }

    const baseUrl = normalizeHttpUrl(options.baseUrl, 'baseUrl').toString()
    const headed = options.headed === true
    const navigationTimeoutMs =
      options.navigationTimeoutMs ??
      options.timeoutMs ??
      DEFAULT_NAVIGATION_TIMEOUT_MS
    if (!Number.isFinite(navigationTimeoutMs) || navigationTimeoutMs <= 0) {
      throw new PlaywrightEngineError(
        'ENGINE_CONFIGURATION_INVALID',
        '浏览器导航超时必须是正数。',
        { component: 'browser', retryable: false, reason: 'invalid-timeout' },
      )
    }

    const networkPolicy =
      options.networkPolicy ??
      new SameOriginNetworkPolicy(baseUrl, {
        eventSink: options.eventSink,
      })
    // 仅用于本方法自身的启动失败诊断（短错误消息），不向下传给会话：
    // 会话需要按**有效快照上限**派生自己的脱敏器，若在此处用默认实例
    // （maxLength 8192）覆盖，快照会被静默截到 8KB，快照上限配置形同虚设。
    const diagnosticRedactor = options.redactor ?? createDefaultRedactor()
    let browser: Browser | undefined

    try {
      // v21（Windows 控制台黑窗）：无头模式默认落到 chromium-headless-shell，
      // 而 chrome-headless-shell.exe 是**控制台子系统**程序——宿主进程没有控制台时
      // （CLI 后台服务的 detached 进程），Windows 会给它新建一个可见黑窗；Playwright
      // 启动浏览器时并不传 windowsHide，从这里无法关闭它。显式指定 channel:
      // 'chromium' 让无头也走 GUI 子系统的完整浏览器：既消除黑窗，又让生成（无头）
      // 与执行（有头）共用同一浏览器构建，减少两条链路的渲染差异。
      browser = await this.browserType.launch({
        headless: !headed,
        channel: 'chromium',
      })
      // 显式注入平台统一 locale：不设置时浏览器跟随系统语言，会与执行链路
      // （@playwright/test runner 默认 en-US）产生页面语言差异，破坏文本定位器。
      const context = await browser.newContext({
        baseURL: baseUrl,
        ...PLATFORM_BROWSER_ENV,
      })
      await networkPolicy.installRoute(context)
      const page = await context.newPage()
      page.setDefaultTimeout(options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(navigationTimeoutMs)
      return new PlaywrightBrowserSession({
        id: this.sessionIdFactory(),
        headed,
        baseUrl,
        browser,
        context,
        page,
        networkPolicy,
        navigationTimeoutMs,
        eventSink: options.eventSink,
        // 只在宿主显式注入时向下传递：缺省由会话按快照上限自行派生。
        ...(options.redactor ? { redactor: options.redactor } : {}),
        // v20 凭据代理：解析端口同样只在注入时向下传递，缺省时 fill 只接受字面量。
        ...(options.credentialResolver
          ? { credentialResolver: options.credentialResolver }
          : {}),
        signal: options.signal,
      })
    } catch (error) {
      await closeBrowserQuietly(browser)
      if (error instanceof PlaywrightEngineError) throw error
      throw new PlaywrightEngineError(
        'BROWSER_SESSION_START_FAILED',
        '浏览器会话启动失败。',
        {
          component: 'browser',
          retryable: true,
          reason: diagnosticRedactor.redact(
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'playwright-launch-failed',
          ),
        },
      )
    }
  }
}

/**
 * 创建默认 Chromium 浏览器会话工厂。
 *
 * @param options - 可选启动适配器。
 * @returns PlaywrightBrowserSessionFactory 实例。
 * @throws 不抛出异常。
 */
export function createBrowserSessionFactory(
  options: IBrowserSessionFactoryOptions = {},
): PlaywrightBrowserSessionFactory {
  return new PlaywrightBrowserSessionFactory(options)
}

/**
 * 关闭启动失败时已经创建的浏览器。
 *
 * @param browser - 可选 Browser 实例。
 * @returns 关闭操作完成。
 * @throws 不抛出异常，避免覆盖原始启动错误。
 */
async function closeBrowserQuietly(
  browser: Browser | undefined,
): Promise<void> {
  if (!browser) return
  try {
    await browser.close()
  } catch {
    // 启动失败清理属于 best effort，原始错误由调用方转换。
  }
}

/**
 * 暴露浏览器默认配置。
 */
export const browserSessionFactoryDefaults = {
  navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
} as const

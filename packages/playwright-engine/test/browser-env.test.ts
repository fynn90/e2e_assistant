/**
 * 锁定「生成与执行两链路浏览器语言一致」的契约。
 *
 * 背景：@playwright/test 的 locale fixture 默认硬编码 "en-US"，而直连 API 的
 * 生成链路浏览器跟随系统语言。若两处不显式引用同一 PLATFORM_BROWSER_ENV，
 * 生成阶段按界面文本产出的定位器会在执行阶段失效（页面语言不一致）。
 */

import { describe, expect, it } from 'vitest'
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright'
import { PLATFORM_BROWSER_ENV } from '../src/contracts/browser-env'
import { createBrowserSessionFactory } from '../src/browser-session/browser-session-factory'
import { buildConfigContent } from '../src/runner-config-builder'

describe('PLATFORM_BROWSER_ENV', () => {
  it('locale 是合法的 BCP 47 语言标签', () => {
    expect(PLATFORM_BROWSER_ENV.locale).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/)
  })
})

/**
 * 创建同时记录 launch / newContext 入参的浏览器类型替身。
 *
 * 只实现工厂 create() 走通所需的最小接口面（页面、上下文、浏览器）。
 *
 * @returns browserType 替身与按调用顺序累积的 launch / newContext 入参。
 * @throws 不抛出异常。
 */
function createRecordingBrowserType(): {
  browserType: BrowserType
  launchOptions: Array<Record<string, unknown>>
  contextOptions: Array<Record<string, unknown>>
} {
  const launchOptions: Array<Record<string, unknown>> = []
  const contextOptions: Array<Record<string, unknown>> = []
  const fakePage = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
  } as unknown as Page
  const fakeContext = {
    route: async () => {},
    newPage: async () => fakePage,
    close: async () => {},
  } as unknown as BrowserContext
  const fakeBrowser = {
    on: () => {},
    off: () => {},
    close: async () => {},
    newContext: async (options: Record<string, unknown>) => {
      contextOptions.push(options)
      return fakeContext
    },
  } as unknown as Browser
  const fakeBrowserType = {
    launch: async (options: Record<string, unknown>) => {
      launchOptions.push(options)
      return fakeBrowser
    },
  } as unknown as BrowserType

  return { browserType: fakeBrowserType, launchOptions, contextOptions }
}

describe('PlaywrightBrowserSessionFactory 浏览器环境注入', () => {
  it('创建 context 时必须显式传入平台统一 locale 与 baseURL', async () => {
    const recorder = createRecordingBrowserType()

    const session = await createBrowserSessionFactory({
      browserType: recorder.browserType,
    }).create({
      baseUrl: 'http://127.0.0.1:9/',
      headed: false,
    })
    await session.close()

    expect(recorder.contextOptions).toHaveLength(1)
    expect(recorder.contextOptions[0]).toMatchObject({
      baseURL: 'http://127.0.0.1:9/',
      locale: PLATFORM_BROWSER_ENV.locale,
    })
  })

  it('两种模式都显式使用完整 Chromium（避免 Windows 控制台黑窗）', async () => {
    const headless = createRecordingBrowserType()
    const headlessSession = await createBrowserSessionFactory({
      browserType: headless.browserType,
    }).create({ baseUrl: 'http://127.0.0.1:9/', headed: false })
    await headlessSession.close()

    const headed = createRecordingBrowserType()
    const headedSession = await createBrowserSessionFactory({
      browserType: headed.browserType,
    }).create({ baseUrl: 'http://127.0.0.1:9/', headed: true })
    await headedSession.close()

    // 无头若走默认的 chromium-headless-shell（控制台子系统程序），在无控制台的
    // 宿主进程里会被 Windows 新建一个可见黑窗；channel: 'chromium' 指向 GUI
    // 子系统的完整浏览器，从根上消除该窗口。
    expect(headless.launchOptions[0]).toMatchObject({
      headless: true,
      channel: 'chromium',
    })
    expect(headed.launchOptions[0]).toMatchObject({
      headless: false,
      channel: 'chromium',
    })
  })
})

describe('buildConfigContent 执行配置', () => {
  const baseRequest = {
    runId: '20260920-120000',
    skillRoot: 'C:/skills/demo',
    specRelativePath: 'test.spec.ts',
    baseUrl: 'https://example.test/login',
    env: {},
    timeouts: { testMs: 120_000, overallMs: 600_000 },
  }

  it('use.locale 必须显式写入平台统一 locale（防止 test runner 默认 en-US 接管）', () => {
    const config = buildConfigContent(baseRequest)
    expect(config).toContain(
      `locale: ${JSON.stringify(PLATFORM_BROWSER_ENV.locale)}`,
    )
  })

  it('保留 baseURL、有头模式与超时等既有执行语义', () => {
    const config = buildConfigContent(baseRequest)
    expect(config).toContain(JSON.stringify(baseRequest.baseUrl))
    expect(config).toContain('headless: false')
    expect(config).toContain('timeout: 120000')
    expect(config).toContain('globalTimeout: 600000')
  })
})

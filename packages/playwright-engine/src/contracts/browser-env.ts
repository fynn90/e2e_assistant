/** 定义生成探查与测试执行共用的浏览器环境常量，保证两条链路的页面行为（语言等）一致。 */

/**
 * 平台统一浏览器环境配置。
 *
 * 背景：两条链路对浏览器语言的默认行为不对称——
 * - 生成链路（browser-session 直连 Playwright API）不设置 locale 时，
 *   浏览器跟随系统语言（中文系统为 zh-CN）；
 * - 执行链路（@playwright/test runner）的 locale fixture 默认硬编码为 "en-US"
 *   （playwright/lib/index.js：`contextOptions.locale ?? "en-US"`）。
 * 页面语言不一致会导致生成阶段按界面文本产出的定位器（如 getByPlaceholder）
 * 在执行阶段无法命中元素。因此生成与执行必须显式引用这同一份 locale 配置。
 */
export const PLATFORM_BROWSER_ENV = {
  /**
   * 浏览器上下文 locale：同时影响 navigator.language 与 Accept-Language 请求头。
   */
  locale: 'zh-CN',
} as const

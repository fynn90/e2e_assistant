/** 验证默认同源策略对主动导航、文档路由和子资源例外的处理。 */

import type { BrowserContext, Route } from 'playwright'
import { describe, expect, it } from 'vitest'
import { SameOriginNetworkPolicy } from '../src/network-policy/same-origin-policy'
import { sanitizeUrl } from '../src/network-policy/url-utils'

/**
 * 创建可触发 route handler 的最小 Playwright context 替身。
 *
 * @returns context 和当前注册的 route handler。
 * @throws 不抛出异常。
 */
function createFakeContext(): {
  context: BrowserContext
  getHandler: () => ((route: Route) => Promise<void>) | undefined
} {
  let handler: ((route: Route) => Promise<void>) | undefined
  const context = {
    route: async (
      _pattern: string,
      callback: (route: Route) => Promise<void>,
    ) => {
      handler = callback
    },
  } as unknown as BrowserContext
  return { context, getHandler: () => handler }
}

/**
 * 创建记录 continue/abort 行为的路由替身。
 *
 * @param url - 请求 URL。
 * @param resourceType - Playwright 资源类型。
 * @returns 路由替身和行为记录。
 * @throws 不抛出异常。
 */
function createFakeRoute(
  url: string,
  resourceType: string,
): {
  route: Route
  action: 'continue' | 'abort' | undefined
} {
  const state: { action: 'continue' | 'abort' | undefined } = {
    action: undefined,
  }
  const route = {
    request: () => ({ url: () => url, resourceType: () => resourceType }),
    continue: async () => {
      state.action = 'continue'
    },
    abort: async () => {
      state.action = 'abort'
    },
  } as unknown as Route
  return {
    route,
    get action() {
      return state.action
    },
  }
}

describe('SameOriginNetworkPolicy', () => {
  it('allows same-origin navigation and rejects cross-origin navigation', () => {
    const policy = new SameOriginNetworkPolicy('https://example.test/base')

    expect(policy.assertNavigable('https://example.test/login')).toBe(true)
    expect(policy.assertNavigable('/relative-login')).toBe(true)
    expect(policy.assertNavigable('https://attacker.test/login')).toBe(false)
    expect(
      policy.assertNavigable('https://user:password@example.test/login'),
    ).toBe(false)
    expect(policy.assertNavigable('javascript:alert(1)')).toBe(false)
    expect(policy.isAllowedDocument('https://example.test/redirect')).toBe(true)
    expect(policy.isAllowedDocument('https://cdn.example.test/redirect')).toBe(
      false,
    )
  })

  it('blocks cross-origin documents while allowing necessary subresources', async () => {
    const policy = new SameOriginNetworkPolicy('https://example.test')
    const { context, getHandler } = createFakeContext()
    await policy.installRoute(context)
    const handler = getHandler()
    expect(handler).toBeDefined()

    const sameOriginDocument = createFakeRoute(
      'https://example.test/home',
      'document',
    )
    const crossOriginDocument = createFakeRoute(
      'https://attacker.test/home',
      'document',
    )
    const crossOriginScript = createFakeRoute(
      'https://cdn.example.net/app.js',
      'script',
    )

    await handler?.(sameOriginDocument.route)
    await handler?.(crossOriginDocument.route)
    await handler?.(crossOriginScript.route)

    expect(sameOriginDocument.action).toBe('continue')
    expect(crossOriginDocument.action).toBe('abort')
    expect(crossOriginScript.action).toBe('continue')
  })

  it('limits cross-origin subresources when explicit origins are configured', async () => {
    const policy = new SameOriginNetworkPolicy('https://example.test', {
      allowedOrigins: new Set(['https://cdn.example.net']),
    })
    const { context, getHandler } = createFakeContext()
    await policy.installRoute(context)
    const handler = getHandler()
    const allowed = createFakeRoute('https://cdn.example.net/app.js', 'script')
    const denied = createFakeRoute('https://other.example.net/app.js', 'script')

    await handler?.(allowed.route)
    await handler?.(denied.route)

    expect(allowed.action).toBe('continue')
    expect(denied.action).toBe('abort')
  })

  it('redacts credentials and sensitive query parameters from network diagnostics', () => {
    const sanitized = sanitizeUrl(
      'https://user:password@example.test/path?token=secret&visible=yes#secret',
    )

    expect(sanitized).not.toContain('password')
    expect(sanitized).not.toContain('secret')
    expect(sanitized).toContain('visible=yes')
    expect(sanitized).not.toContain('#secret')
  })
})

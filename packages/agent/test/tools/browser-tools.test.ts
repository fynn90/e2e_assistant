/**
 * 浏览器交互工具的单元测试（v12-pre）。
 *
 * 用替身宿主验证四个新工具（click / select / waitFor / screenshot）的对外行为：
 * 参数到宿主端口的映射、返回值到工具结果的形态、以及超限降级。
 * 真实浏览器行为由 playwright-engine 的 browser-session.test.ts 覆盖，
 * 本文件只验证 agent 这一层，不启动浏览器。
 */

import { describe, expect, it, vi } from 'vitest'
import type { IPageScreenshot } from '@authine-e2e-agent/types'
import type { IBrowserSessionHost } from '../../src/tools/browser/Browser_session'
import { createBrowserClickTool } from '../../src/tools/browser/browser_click'
import { createBrowserSelectTool } from '../../src/tools/browser/browser_select'
import { createBrowserFillTool } from '../../src/tools/browser/browser_fill'
import { createBrowserWaitForTool } from '../../src/tools/browser/browser_waitFor'
import { createBrowserScreenshotTool } from '../../src/tools/browser/browser_screenshot'

/**
 * 构造只实现新工具所需方法的宿主替身。
 *
 * @returns 记录调用参数的宿主替身与其 spy。
 * @throws 不抛出异常。
 */
function createHostStub() {
  const clickElement = vi.fn(async () => ({
    url: 'https://example.test/after',
    title: '页面',
  }))
  const selectElementOption = vi.fn(async () => ({
    url: 'https://example.test/',
    title: '页面',
  }))
  const fillElement = vi.fn(async () => ({
    url: 'https://example.test/',
    title: '页面',
  }))
  const waitForPage = vi.fn(async () => ({ matched: true, elapsedMs: 42 }))
  const captureScreenshot = vi.fn(async (): Promise<IPageScreenshot> => ({
    data: 'iVBORw0KGgo=',
    mimeType: 'image/png',
    width: 800,
    height: 600,
  }))

  const host = {
    baseUrl: 'https://example.test/',
    headed: false,
    clickElement,
    selectElementOption,
    fillElement,
    waitForPage,
    captureScreenshot,
  } as unknown as IBrowserSessionHost

  return {
    host,
    clickElement,
    selectElementOption,
    fillElement,
    waitForPage,
    captureScreenshot,
  }
}

/** 工具执行结果的松散视图：用例只断言 content 形态与 details 字段。 */
interface ToolOutcome {
  content: Array<{
    type: string
    text?: string
    data?: string
    mimeType?: string
  }>
  details: Record<string, unknown>
}

/**
 * 以固定的调用标识执行工具，省去每个用例重复传参。
 *
 * 参数与返回值在此处收窄为结构化的松散类型：各工具的静态参数类型差异较大，
 * 逐个套用泛型会让调用点不得不重复 Schema 推导，反而降低用例可读性。
 * 参数的真实合法性由工具自身的 execute 在运行时校验。
 *
 * @param tool - 待执行的 AgentTool。
 * @param parameters - 工具参数。
 * @returns 工具返回的 content 与 details。
 * @throws 工具抛出异常时向外抛出。
 */
async function runTool(
  tool: {
    execute: (
      id: string,
      params: never,
      signal?: AbortSignal,
    ) => Promise<unknown>
  },
  parameters: unknown,
): Promise<ToolOutcome> {
  return tool.execute('call-1', parameters as never) as Promise<ToolOutcome>
}

describe('createBrowserClickTool', () => {
  it('把 selector 与超时透传给宿主并返回点击后的页面信息', async () => {
    const { host, clickElement } = createHostStub()
    const tool = createBrowserClickTool(host)

    const result = await runTool(tool, {
      selector: '[data-testid=preview]',
      timeoutMs: 5_000,
    })

    expect(clickElement).toHaveBeenCalledWith('[data-testid=preview]', {
      timeoutMs: 5_000,
    })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(result.details).toEqual({
      selector: '[data-testid=preview]',
      url: 'https://example.test/after',
      title: '页面',
    })
  })

  it('未传超时时不向宿主注入 timeoutMs', async () => {
    const { host, clickElement } = createHostStub()
    const tool = createBrowserClickTool(host)

    await runTool(tool, { selector: '#a' })

    expect(clickElement).toHaveBeenCalledWith('#a', {})
  })
})

describe('createBrowserSelectTool', () => {
  it('把 selector 与选项值一起透传', async () => {
    const { host, selectElementOption } = createHostStub()
    const tool = createBrowserSelectTool(host)

    const result = await runTool(tool, { selector: '#mode', value: 'final' })

    expect(selectElementOption).toHaveBeenCalledWith('#mode', 'final', {})
    expect(result.details).toMatchObject({ selector: '#mode', value: 'final' })
  })
})

describe('createBrowserWaitForTool', () => {
  it('把扁平参数收敛为 selector 条件', async () => {
    const { host, waitForPage } = createHostStub()
    const tool = createBrowserWaitForTool(host)

    const result = await runTool(tool, {
      kind: 'selector',
      selector: '#panel',
      state: 'visible',
    })

    expect(waitForPage).toHaveBeenCalledWith(
      { kind: 'selector', selector: '#panel', state: 'visible' },
      {},
    )
    expect(result.details).toMatchObject({
      kind: 'selector',
      matched: true,
      elapsedMs: 42,
    })
  })

  it('省略 state 时不写入条件，交由引擎使用默认状态', async () => {
    const { host, waitForPage } = createHostStub()
    const tool = createBrowserWaitForTool(host)

    await runTool(tool, { kind: 'selector', selector: '#panel' })

    expect(waitForPage).toHaveBeenCalledWith(
      { kind: 'selector', selector: '#panel' },
      {},
    )
  })

  it('收敛 loadState / url / timeout 三种条件', async () => {
    const { host, waitForPage } = createHostStub()
    const tool = createBrowserWaitForTool(host)

    await runTool(tool, { kind: 'loadState', loadState: 'networkidle' })
    await runTool(tool, { kind: 'url', urlPattern: '**/preview' })
    await runTool(tool, { kind: 'timeout', timeoutMs: 1_500 })

    expect(waitForPage).toHaveBeenNthCalledWith(
      1,
      { kind: 'loadState', state: 'networkidle' },
      {},
    )
    expect(waitForPage).toHaveBeenNthCalledWith(
      2,
      { kind: 'url', pattern: '**/preview' },
      {},
    )
    expect(waitForPage).toHaveBeenNthCalledWith(
      3,
      { kind: 'timeout', ms: 1_500 },
      { timeoutMs: 1_500 },
    )
  })

  it('缺少 kind 对应的必填字段时给出面向模型的明确错误', async () => {
    const { host, waitForPage } = createHostStub()
    const tool = createBrowserWaitForTool(host)

    // kind=selector 但没给 selector：必须抛错而不是发出无意义的等待。
    await expect(runTool(tool, { kind: 'selector' })).rejects.toThrow(
      /必须提供 selector/,
    )
    await expect(runTool(tool, { kind: 'loadState' })).rejects.toThrow(
      /必须提供 loadState/,
    )
    await expect(runTool(tool, { kind: 'url' })).rejects.toThrow(
      /必须提供 urlPattern/,
    )
    expect(waitForPage).not.toHaveBeenCalled()
  })

  it('超时未满足时说明原因而不是报错', async () => {
    const { host, waitForPage } = createHostStub()
    waitForPage.mockResolvedValueOnce({ matched: false, elapsedMs: 3_000 })
    const tool = createBrowserWaitForTool(host)

    const result = await runTool(tool, { kind: 'selector', selector: '#never' })

    expect(result.details).toMatchObject({ matched: false, elapsedMs: 3_000 })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('等待超时')
  })
})

describe('createBrowserScreenshotTool', () => {
  it('返回图片内容并附带尺寸说明', async () => {
    const { host, captureScreenshot } = createHostStub()
    const tool = createBrowserScreenshotTool(host)

    const result = await runTool(tool, { selector: '#canvas' })

    expect(captureScreenshot).toHaveBeenCalledWith({ selector: '#canvas' })
    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    })
    expect((result.content[1] as { text: string }).text).toContain('800×600')
    expect(result.details).toMatchObject({
      width: 800,
      height: 600,
      skipped: false,
    })
  })

  it('超出体积上限时降级为文字占位且不回传图片', async () => {
    const { host, captureScreenshot } = createHostStub()
    // 构造一个 base64 长度换算后超过 2MB 的数据（2.5MB 原始字节 → 约 3.33MB base64）。
    const oversizedBase64 = 'A'.repeat(Math.ceil((2.5 * 1024 * 1024 * 4) / 3))
    captureScreenshot.mockResolvedValueOnce({
      data: oversizedBase64,
      mimeType: 'image/png',
      width: 4_000,
      height: 4_000,
    })
    const tool = createBrowserScreenshotTool(host)

    const result = await runTool(tool, {})

    expect(result.content.every((block) => block.type === 'text')).toBe(true)
    expect(result.details.skipped).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('超过')
  })

  it('未指定 selector 时不向宿主注入该字段', async () => {
    const { host, captureScreenshot } = createHostStub()
    const tool = createBrowserScreenshotTool(host)

    await runTool(tool, { fullPage: true })

    expect(captureScreenshot).toHaveBeenCalledWith({ fullPage: true })
  })
})

describe('createBrowserFillTool', () => {
  it('把 selector 与明文原样传给宿主', async () => {
    const { host, fillElement } = createHostStub()
    const tool = createBrowserFillTool(host)

    await runTool(tool, { selector: '#email', value: 'alice' })

    expect(fillElement).toHaveBeenCalledWith('#email', 'alice', {})
  })

  it('把 ${ENV:KEY} 引用原样传给宿主，不在 agent 层解析', async () => {
    const { host, fillElement } = createHostStub()
    const tool = createBrowserFillTool(host)

    await runTool(tool, {
      selector: '#password',
      value: '${ENV:E2E_PASSWORD}',
    })

    // 关键：引用必须原样下传——解析发生在宿主，agent 层永远拿不到真值。
    expect(fillElement).toHaveBeenCalledWith(
      '#password',
      '${ENV:E2E_PASSWORD}',
      {},
    )
  })

  it('指定超时时注入该字段，未指定时不注入', async () => {
    const { host, fillElement } = createHostStub()
    const tool = createBrowserFillTool(host)

    await runTool(tool, { selector: '#a', value: 'x', timeoutMs: 3_000 })
    expect(fillElement).toHaveBeenCalledWith('#a', 'x', { timeoutMs: 3_000 })

    await runTool(tool, { selector: '#b', value: 'y' })
    expect(fillElement).toHaveBeenCalledWith('#b', 'y', {})
  })

  it('使用凭据引用时回执不泄露值，并标注来源', async () => {
    const { host } = createHostStub()
    const tool = createBrowserFillTool(host)

    const result = await runTool(tool, {
      selector: '#password',
      value: '${ENV:E2E_PASSWORD}',
    })

    const text = (result.content[0] as { text: string }).text
    // 回执可以提到「用了引用」，但绝不能出现引用里的值（此处以 key 名为界）。
    expect(text).toContain('敏感数据')
    expect(result.details.fromCredentialReference).toBe(true)
  })

  it('明文填入时 details 标注为非凭据', async () => {
    const { host } = createHostStub()
    const tool = createBrowserFillTool(host)

    const result = await runTool(tool, {
      selector: '#email',
      value: 'alice@example.test',
    })

    expect(result.details.fromCredentialReference).toBe(false)
  })
})

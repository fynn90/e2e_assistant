/**
 * 浏览器打开的容错测试（v19 macOS / Linux 兼容）。
 *
 * 无图形环境的 Linux 上 `open()` 会抛错（缺 xdg-open）——服务此时已经起来，
 * 不能因此把一次成功的启动报成失败。本测试锁定这条降级语义。
 */
import { describe, expect, it, vi } from 'vitest'
import { openBrowserQuietly } from '../../src/commands/shared/open-browser-quietly'

const SERVER_URL = 'http://127.0.0.1:5826'

describe('openBrowserQuietly', () => {
  it('打开成功时不输出任何内容', async () => {
    const openBrowser = vi.fn(async () => undefined)
    const log = vi.fn()

    await openBrowserQuietly(SERVER_URL, openBrowser, log)

    expect(openBrowser).toHaveBeenCalledWith(SERVER_URL)
    expect(log).not.toHaveBeenCalled()
  })

  it('打开失败时不抛错，改为打印可手动访问的地址', async () => {
    // 服务器 / 容器 / 精简发行版：服务已就绪，但本机没有可用的浏览器。
    const openBrowser = vi.fn(async () => {
      throw new Error('xdg-open: command not found')
    })
    const log = vi.fn()

    await expect(
      openBrowserQuietly(SERVER_URL, openBrowser, log),
    ).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain(SERVER_URL)
    expect(log.mock.calls[0]?.[0]).toMatch(/请手动访问/)
  })
})

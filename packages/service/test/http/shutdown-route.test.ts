/**
 * 优雅关闭端点测试（v19 §4.3 / AC-04）。
 *
 * 锁定的是「谁能关掉服务」这条安全性质：凭据不匹配或来自浏览器页面的请求
 * 一律 403 且不触发关闭；未提供凭据时不注册端点（兜底 404 仍然生效）。
 *
 * 「是否触发关闭」以注入的宿主回调（`onShutdownRequested`）观测——端点的
 * 职责边界正是「校验 → 应答 → 通知宿主」，关闭与退出不归它管（C3）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'
import {
  SHUTDOWN_TOKEN_HEADER,
  SHUTDOWN_RESPONSE_FLUSH_DELAY_MS,
} from '../../src/http/routes/shutdown'

const SHUTDOWN_TOKEN = 'test-shutdown-token'

function createTestApp(options: {
  shutdownToken?: string
  includeHostCallback?: boolean
}) {
  const onShutdownRequested = vi.fn()
  const app = createHttpApp({
    chatRuntimeFactory() {
      throw new Error('Chat runtime should not be called in this test.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    logger: { request() {}, error() {} },
    requestIdGenerator: () => 'request-test-id',
    ...(options.shutdownToken ? { shutdownToken: options.shutdownToken } : {}),
    ...(options.includeHostCallback === false ? {} : { onShutdownRequested }),
  })

  return { app, onShutdownRequested }
}

function postShutdown(headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers,
  } as const
}

/**
 * 等待关闭序列启动。
 *
 * 端点刻意延迟一拍再触发关闭（让 202 先写回客户端），因此断言需要等待；
 * 反过来断言「没有触发」时，也必须等过一个完整窗口再看。
 */
async function settleShutdownWindow(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, SHUTDOWN_RESPONSE_FLUSH_DELAY_MS + 150),
  )
}

describe('POST /api/shutdown', () => {
  it('携带正确凭据时返回 202 并触发关闭序列', async () => {
    const { app, onShutdownRequested } = createTestApp({
      shutdownToken: SHUTDOWN_TOKEN,
    })

    const response = await app.request(
      'http://127.0.0.1:5826/api/shutdown',
      postShutdown({ [SHUTDOWN_TOKEN_HEADER]: SHUTDOWN_TOKEN }),
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      success: true,
      data: { message: '服务正在关闭。' },
    })

    await settleShutdownWindow()
    expect(onShutdownRequested).toHaveBeenCalledTimes(1)
  })

  it('凭据不匹配时拒绝且不触发关闭', async () => {
    const { app, onShutdownRequested } = createTestApp({
      shutdownToken: SHUTDOWN_TOKEN,
    })

    const response = await app.request(
      'http://127.0.0.1:5826/api/shutdown',
      postShutdown({ [SHUTDOWN_TOKEN_HEADER]: 'wrong-token' }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
    })

    await settleShutdownWindow()
    expect(onShutdownRequested).not.toHaveBeenCalled()
  })

  it('缺少凭据时拒绝（裸调端点同样不被接受）', async () => {
    const { app, onShutdownRequested } = createTestApp({
      shutdownToken: SHUTDOWN_TOKEN,
    })

    const response = await app.request(
      'http://127.0.0.1:5826/api/shutdown',
      postShutdown(),
    )

    expect(response.status).toBe(403)

    await settleShutdownWindow()
    expect(onShutdownRequested).not.toHaveBeenCalled()
  })

  it('携带 Origin 的跨站请求被拒绝（挡浏览器页面）', async () => {
    const { app, onShutdownRequested } = createTestApp({
      shutdownToken: SHUTDOWN_TOKEN,
    })

    const response = await app.request(
      'http://127.0.0.1:5826/api/shutdown',
      postShutdown({
        [SHUTDOWN_TOKEN_HEADER]: SHUTDOWN_TOKEN,
        Origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)

    await settleShutdownWindow()
    expect(onShutdownRequested).not.toHaveBeenCalled()
  })

  it('未提供 shutdownToken 时不注册端点，兜底 404 生效', async () => {
    const { app } = createTestApp({})

    const response = await app.request(
      'http://127.0.0.1:5826/api/shutdown',
      postShutdown(),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'API_NOT_FOUND' })
  })

  it('重复请求应答 202 但不重复触发关闭', async () => {
    const { app, onShutdownRequested } = createTestApp({
      shutdownToken: SHUTDOWN_TOKEN,
    })
    const headers = { [SHUTDOWN_TOKEN_HEADER]: SHUTDOWN_TOKEN }

    expect(
      (
        await app.request(
          'http://127.0.0.1:5826/api/shutdown',
          postShutdown(headers),
        )
      ).status,
    ).toBe(202)
    expect(
      (
        await app.request(
          'http://127.0.0.1:5826/api/shutdown',
          postShutdown(headers),
        )
      ).status,
    ).toBe(202)

    await settleShutdownWindow()
    expect(onShutdownRequested).toHaveBeenCalledTimes(1)
  })
})

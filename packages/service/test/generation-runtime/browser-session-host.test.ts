/**
 * 浏览器会话宿主的关闭协作测试（v19 §4.2 第 2 步 / AC-04）。
 *
 * `dispose()` 是服务关闭序列的第二步：把还开着的有头 Chromium 全关掉，
 * 不留孤儿窗口。容错性质与 `release()` 一致——单个会话关闭失败不影响其余。
 */
import { describe, expect, it, vi } from 'vitest'
import { browserSessionRegistry } from '@fynn90-e2e_assistant/agent'
import type { IBrowserSession } from '@fynn90-e2e_assistant/playwright-engine'
import { createGenerationBrowserHost } from '../../src/generation-runtime/browser-session-host'

/**
 * 构造最小浏览器会话替身。
 *
 * @param closeBehavior - 关闭时的行为；返回 rejected promise 可模拟关闭失败。
 * @returns 会话替身与记录关闭次数的 spy。
 */
function createSessionStub (closeBehavior: () => Promise<void> = async () => { }) {
  const close = vi.fn(closeBehavior)

  return {
    session: { id: 'session-stub', close } as unknown as IBrowserSession,
    close,
  }
}

function createHostWithSessions (
  sessions: Array<{ sessionId: string; session: IBrowserSession }>,
) {
  // 逐个 create 调用返回预先排好的会话：acquire 的顺序即注入顺序。
  let index = 0
  const host = createGenerationBrowserHost({
    chromiumInstaller: {
      detect: async () => ({ installed: true, executablePath: '/fake/chromium' }),
      install: async () => ({
        installed: true,
        executablePath: '/fake/chromium',
      }),
    },
    sessionFactory: {
      async create () {
        const next = sessions[index]
        index += 1
        if (!next) {
          throw new Error('测试注入的会话数量不足。')
        }
        return next.session
      },
    },
  })

  return host
}

async function acquireSession (
  host: ReturnType<typeof createHostWithSessions>,
  sessionId: string,
): Promise<void> {
  await host.acquire({
    sessionId,
    headed: true,
    baseUrl: 'http://127.0.0.1:59999',
    signal: new AbortController().signal,
  })
}

describe('dispose', () => {
  it('关闭全部会话并清空登记表', async () => {
    const first = createSessionStub()
    const second = createSessionStub()
    const host = createHostWithSessions([
      { sessionId: 'session-1', session: first.session },
      { sessionId: 'session-2', session: second.session },
    ])

    await acquireSession(host, 'session-1')
    await acquireSession(host, 'session-2')

    await host.dispose()

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).toHaveBeenCalledTimes(1)
    // 重复 dispose 安全：表已清空，不重复关闭。
    await host.dispose()
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('单个会话关闭失败不影响其余会话', async () => {
    const failing = createSessionStub(async () => {
      throw new Error('关闭失败')
    })
    const healthy = createSessionStub()
    const host = createHostWithSessions([
      { sessionId: 'session-failing', session: failing.session },
      { sessionId: 'session-healthy', session: healthy.session },
    ])

    await acquireSession(host, 'session-failing')
    await acquireSession(host, 'session-healthy')

    // 关闭序列最怕「一个失败让后面的都不执行」。
    await expect(host.dispose()).resolves.toBeUndefined()

    expect(failing.close).toHaveBeenCalledTimes(1)
    expect(healthy.close).toHaveBeenCalledTimes(1)
  })

  it('会话不存在时安全无操作', async () => {
    const host = createHostWithSessions([])

    await expect(host.dispose()).resolves.toBeUndefined()
  })

  it('dispose 后会话从 Agent 浏览器注册表注销', async () => {
    const sessionStub = createSessionStub()
    const host = createHostWithSessions([
      { sessionId: 'session-registry', session: sessionStub.session },
    ])

    await acquireSession(host, 'session-registry')
    // 登记成功：Agent 该会话能拿到 browser_* 工具。
    expect(browserSessionRegistry.get('session-registry')).toBeDefined()

    await host.dispose()

    // 注销后 Agent 不再拿到已失效的浏览器宿主。
    expect(browserSessionRegistry.get('session-registry')).toBeUndefined()
  })
})

/** 使用本地 fixture server 验证真实浏览器会话的导航、快照、查询和释放。 */

import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { createBrowserSessionFactory } from '../src/browser-session/browser-session-factory'
import { createDefaultRedactor } from '../src/observability/redaction'

const hasChromium = existsSync(chromium.executablePath())

/**
 * 单个用例的超时时间。
 *
 * 本文件的每个用例都要真实启动一次 Chromium（含进程拉起、页面加载与关闭），
 * 连续执行时机器负载会让个别用例显著变慢；15s 会产生与代码无关的偶发失败，
 * 因此统一放宽到 30s，让失败只反映真实缺陷。
 */
const TEST_TIMEOUT_MS = 30_000

/**
 * fixture 页面里用于验证快照长度上限的填充文本字符数。
 *
 * 必须明显大于脱敏器的默认上限（8192），否则「快照实际被截到 8192」的回归
 * 无法被断言捕获——这正是该缺陷长期未被发现的原因。
 */
const LONG_TEXT_LENGTH = 20_000

/**
 * 生成 fixture 页面 HTML。
 *
 * 页面同时覆盖：基础表单元素、`<select>` 下拉框、点击后才出现的元素（内联脚本切换
 * `hidden`）、点击后触发的同源导航，以及一段超长文本节点（供快照长度断言）。
 * fixture server 对所有路径返回同一 HTML，因此导航到 `/login` 等路径同样有效。
 *
 * @returns fixture 页面的完整 HTML 文本。
 * @throws 不抛出异常。
 */
function buildFixtureHtml(): string {
  const longText = '长'.repeat(LONG_TEXT_LENGTH)

  return `<!doctype html>
      <html>
        <head><title>Fixture</title></head>
        <body>
          <main aria-label="测试页面">
            <h1>本地页面</h1>
            <label for="email">邮箱</label>
            <input id="email" placeholder="输入邮箱" />
            <label for="password">密码</label>
            <input id="password" name="password" type="password" placeholder="输入密码" />
            <!-- 用于在测试中验证「真值确实被填入密码框」而不必读取私有字段：
                 输入事件把密码框的值同步到一个普通元素（可被 query 读到）。 -->
            <div id="password-probe" data-testid="password-probe"></div>
            <button data-testid="submit">提交</button>
            <label for="mode">模式</label>
            <select id="mode" data-testid="mode">
              <option value="draft">草稿</option>
              <option value="final">正式</option>
            </select>
            <button id="reveal" data-testid="reveal">展开</button>
            <div id="panel" data-testid="panel" hidden>点击后才出现的面板</div>
            <button id="navigate" data-testid="navigate">同源跳转</button>
            <p id="long-text">${longText}</p>
            <script>
              // 点击「展开」显示默认隐藏的面板，用于验证 click + waitFor 链路。
              document.getElementById('reveal').addEventListener('click', () => {
                document.getElementById('panel').hidden = false
              })
              // 点击「同源跳转」触发导航，用于验证 click 后重读 url 的模式。
              document.getElementById('navigate').addEventListener('click', () => {
                window.location.href = '/after-click'
              })
              // 把密码框的当前值同步到探针元素：测试据此断言「真值确实被填入」
              // （密码框自身的 value 已被平台屏蔽，无法从 query 读到）。
              const password = document.getElementById('password')
              const probe = document.getElementById('password-probe')
              const syncProbe = () => {
                probe.textContent = 'filled:' + (password.value ? 'yes' : 'no')
              }
              password.addEventListener('input', syncProbe)
              password.addEventListener('change', syncProbe)
            </script>
          </main>
        </body>
      </html>`
}

/**
 * 启动一个仅用于本地测试的 fixture HTTP 服务。
 *
 * @returns 服务 URL 和关闭函数。
 * @throws 监听失败时抛出 Node HTTP 错误。
 */
async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(buildFixtureHtml())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeFixtureServer(server)
    throw new Error('fixture server 未返回 TCP 地址')
  }
  return { server, url: `http://127.0.0.1:${address.port}` }
}

/**
 * 关闭 fixture HTTP 服务。
 *
 * @param server - 待关闭的 HTTP 服务。
 * @returns 关闭完成。
 * @throws 关闭失败时抛出 Node HTTP 错误。
 */
async function closeFixtureServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('PlaywrightBrowserSessionFactory', () => {
  it.skipIf(!hasChromium)(
    'runs a headless session against a local fixture',
    async () => {
      const fixture = await startFixtureServer()
      const events: unknown[] = []
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        eventSink: {
          publish: (event) => {
            events.push(event)
          },
        },
      })

      try {
        const reference = await session.navigate('/login')
        const snapshot = await session.snapshot({
          maxA11yLength: 8_000,
          maxLocators: 20,
        })
        const elements = await session.query('button, input')

        expect(reference.url).toContain(fixture.url)
        expect(snapshot.title).toBe('Fixture')
        expect(
          snapshot.candidateLocators.some(
            (locator) => locator.testId === 'submit',
          ),
        ).toBe(true)
        // fixture 含 3 个 button（提交 / 展开 / 同源跳转）+ 2 个 input
        // （邮箱、密码——密码框是 v20 凭据代理测试所需，见 buildFixtureHtml）。
        expect(elements).toHaveLength(5)
        await expect(
          session.navigate('https://attacker.test/'),
        ).rejects.toMatchObject({
          code: 'NETWORK_DOCUMENT_BLOCKED',
        })
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'browser.started', headed: false }),
            expect.objectContaining({ type: 'browser.navigation' }),
            expect.objectContaining({ type: 'browser.snapshot' }),
          ]),
        )
      } finally {
        await session.close()
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'clicks an element and returns the post-click page reference',
    async () => {
      const fixture = await startFixtureServer()
      const events: unknown[] = []
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        eventSink: {
          publish: (event) => {
            events.push(event)
          },
        },
      })

      try {
        await session.navigate('/login')
        const panelBefore = await session.query('[data-testid=panel]')
        expect(panelBefore[0]?.attributes?.['data-testid']).toBe('panel')

        const result = await session.click('[data-testid=reveal]')

        expect(result.url).toContain(fixture.url)
        expect(result.title).toBe('Fixture')
        // 点击后面板应可见：交互是真实生效的，不只是发出了一次调用。
        await expect(
          session.waitFor({
            kind: 'selector',
            selector: '[data-testid=panel]',
            state: 'visible',
          }),
        ).resolves.toMatchObject({ matched: true })
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'browser.action',
              action: 'click',
            }),
          ]),
        )
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'rereads the url after a click that triggers same-origin navigation',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        const result = await session.click('[data-testid=navigate]')

        // 必须返回导航**之后**的地址，而不是点击前的地址。
        expect(result.url).toContain('/after-click')
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'selects a dropdown option',
    async () => {
      const fixture = await startFixtureServer()
      const events: unknown[] = []
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        eventSink: {
          publish: (event) => {
            events.push(event)
          },
        },
      })

      try {
        await session.navigate('/login')
        const result = await session.selectOption('#mode', 'final')

        expect(result.url).toContain(fixture.url)
        const selected = await session.query('#mode')
        expect(selected[0]?.value).toBe('final')
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'browser.action',
              action: 'select',
            }),
          ]),
        )
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'reports waitFor timeout as matched=false instead of throwing',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        const result = await session.waitFor(
          {
            kind: 'selector',
            selector: '[data-testid=never-exists]',
            state: 'visible',
          },
          { timeoutMs: 300 },
        )

        // 超时是预期结果而非异常：Agent 需要据此判断「元素确实没出现」。
        expect(result.matched).toBe(false)
        expect(result.elapsedMs).toBeGreaterThanOrEqual(300)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'rejects waitFor on an aborted session',
    async () => {
      const fixture = await startFixtureServer()
      const abortController = new AbortController()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        signal: abortController.signal,
      })

      try {
        await session.navigate('/login')
        abortController.abort()

        await expect(
          session.waitFor({ kind: 'loadState', state: 'load' }),
        ).rejects.toMatchObject({ code: 'PAGE_ACCESS_FAILED' })
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'captures a page screenshot and an element screenshot',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        const pageShot = await session.screenshot()
        expect(pageShot.mimeType).toBe('image/png')
        expect(pageShot.data.length).toBeGreaterThan(0)
        expect(pageShot.width).toBeGreaterThan(0)
        expect(pageShot.height).toBeGreaterThan(0)

        const elementShot = await session.screenshot({
          selector: '[data-testid=submit]',
        })
        expect(elementShot.mimeType).toBe('image/png')
        expect(elementShot.data.length).toBeGreaterThan(0)
        // 元素截图应小于整页截图：证明 selector 确实生效而非静默退化为整页。
        expect(elementShot.width).toBeLessThan(pageShot.width)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'produces snapshots longer than the redactor default limit',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        // 关键：不传 maxA11yLength，走引擎的默认快照上限。
        // 修复前脱敏器的默认上限（8192）会先把内容截掉，默认上限形同虚设。
        const snapshot = await session.snapshot({ maxLocators: 20 })

        // 断言必须严于「大于 8192」：脱敏器截断时会额外追加一个省略号，
        // 用 8192 作阈值会让未修复的实现以 8193 的长度侥幸通过。
        // 填充文本本身就超过 20_000 字符，未修复时输出只会有 ~8KB。
        expect(snapshot.a11yTree.length).toBeGreaterThan(LONG_TEXT_LENGTH)
        // 长文本节点应完整保留（默认上限 240_000，远大于填充文本）。
        expect(snapshot.a11yTree).not.toContain('[内容已截断]')
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'marks truncated consistently with the slice judgement',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        // 显式请求一个小于页面内容的上限，触发截断分支。
        const snapshot = await session.snapshot({
          maxA11yLength: 2_000,
          maxLocators: 20,
        })

        expect(snapshot.truncated).toBe(true)
        expect(snapshot.a11yTree.endsWith('[内容已截断]')).toBe(true)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'fills a literal value into an input',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')
        const result = await session.fill('#email', 'alice@example.test')

        expect(result.url).toContain(fixture.url)
        // 明文（非敏感）应当真的进入输入框，且可被正常读回。
        const elements = await session.query('#email')
        expect(elements[0]?.value).toBe('alice@example.test')
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'resolves an ENV reference and never leaks the real value back',
    async () => {
      const fixture = await startFixtureServer()
      const secret = 'S3cr3tP@ssw0rd'
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        credentialResolver: {
          resolve: async (key) =>
            key === 'E2E_PASSWORD'
              ? { ok: true, value: secret }
              : { ok: false, reason: 'not-found' },
        },
      })

      try {
        await session.navigate('/login')
        await session.fill('#password', '${ENV:E2E_PASSWORD}')

        // 关键断言 1：真值确实被填进了页面（证明引用被正确解析，而非填入占位符）。
        // 经探针元素读取——密码框自身的 value 已被平台屏蔽，正是被测行为本身。
        const probe = await session.query('#password-probe')
        expect(probe[0]?.text).toBe('filled:yes')

        // 关键断言 2：元素查询把密码字段的值屏蔽为 undefined。
        const elements = await session.query('#password')
        expect(elements[0]?.value).toBeUndefined()

        // 关键断言 3：无障碍树里不得出现真值（这是实测确认过的泄漏路径）。
        const snapshot = await session.snapshot({ maxA11yLength: 8_000 })
        expect(snapshot.a11yTree).not.toContain(secret)
        expect(snapshot.a11yTree).toContain('[已隐藏]')
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'registers the resolved secret so later output is redacted',
    async () => {
      const fixture = await startFixtureServer()
      const secret = 'TopSecretValue123'
      const redactor = createDefaultRedactor()

      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        redactor,
        credentialResolver: {
          resolve: async () => ({ ok: true, value: secret }),
        },
      })

      try {
        await session.navigate('/login')
        // 填入前：脱敏器不认识这个值。
        expect(redactor.redact(secret)).toBe(secret)

        await session.fill('#password', '${ENV:ANY_KEY}')

        // 填入后：值已被登记，任何经脱敏器的输出都不会再包含它。
        expect(redactor.redact(`日志中的密码是 ${secret}`)).not.toContain(secret)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'rejects an ENV reference when no resolver is injected',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/login')

        // 未注入解析器时引用形态必须报错，绝不能把引用文本当密码填进去——
        // 那会让错误推迟到断言阶段才暴露。
        await expect(
          session.fill('#password', '${ENV:E2E_PASSWORD}'),
        ).rejects.toMatchObject({ code: 'CREDENTIAL_RESOLUTION_FAILED' })

        // 密码框必须保持为空：报错后不得有任何内容被写入。
        const probe = await session.query('#password-probe')
        expect(probe[0]?.text ?? '').not.toContain('filled:yes')
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'reports stable reasons for credential resolution failures',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
        credentialResolver: {
          resolve: async (key) =>
            key === 'MISSING'
              ? { ok: false, reason: 'not-found' }
              : { ok: false, reason: 'empty' },
        },
      })

      try {
        await session.navigate('/login')

        await expect(
          session.fill('#password', '${ENV:MISSING}'),
        ).rejects.toMatchObject({
          code: 'CREDENTIAL_RESOLUTION_FAILED',
          // 失败原因必须点名 key 而不含任何值，便于模型自我修正。
          message: expect.stringContaining('MISSING'),
        })

        await expect(
          session.fill('#password', '${ENV:BLANK}'),
        ).rejects.toMatchObject({ code: 'CREDENTIAL_RESOLUTION_FAILED' })
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )
})

/**
 * 使用本地 fixture server 验证 iframe 发现、快照、查询和操作的端到端流程。
 *
 * fixture 页面包含一个同源 iframe，内部有输入框、下拉框和按钮。
 * 测试覆盖：
 *   - listFrames 返回主文档和子 frame
 *   - frame snapshot/query 只命中 iframe 内部元素
 *   - frame click/fill/select 在 iframe 内真实生效
 *   - 导航后旧 frameId 失效
 */

import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { createBrowserSessionFactory } from '../src/browser-session/browser-session-factory'

const hasChromium = existsSync(chromium.executablePath())
const TEST_TIMEOUT_MS = 30_000

/** iframe 内部页面 HTML。 */
function buildFrameHtml(): string {
  return `<!doctype html>
<html><head><title>Form Frame</title></head><body>
  <label for="title">标题</label>
  <input id="title" data-testid="frame-title" placeholder="请输入标题" />
  <label for="category">分类</label>
  <select id="category" data-testid="frame-category">
    <option value="general">通用</option>
    <option value="urgent">紧急</option>
  </select>
  <button data-testid="frame-submit" id="submit-btn">提交</button>
  <div id="result" data-testid="frame-result" hidden>已提交</div>
  <script>
    document.getElementById('submit-btn').addEventListener('click', function() {
      document.getElementById('result').hidden = false
    })
  </script>
</body></html>`
}

/** 主页面 HTML：包含一个嵌入 iframe 的弹出框。 */
function buildHostHtml(): string {
  return `<!doctype html>
<html><head><title>Host Page</title></head><body>
  <h1>主页面</h1>
  <button data-testid="open-modal">打开表单</button>
  <div id="modal" style="display:none">
    <iframe id="form-frame" data-testid="form-iframe" src="/frame" width="600" height="400"></iframe>
  </div>
  <script>
    document.querySelector('[data-testid=open-modal]').addEventListener('click', function() {
      document.getElementById('modal').style.display = 'block'
    })
  </script>
</body></html>`
}

/**
 * 启动一个本地 HTTP fixture 服务，返回主页面和 iframe 内容。
 *
 * @returns 服务 URL 和关闭函数。
 * @throws 监听失败时抛出 Node HTTP 错误。
 */
async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(buildFrameHtml())
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(buildHostHtml())
    }
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
 * @throws 关闭失败时抛出错误。
 */
async function closeFixtureServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

describe('PlaywrightBrowserSession iframe support', () => {
  it.skipIf(!hasChromium)(
    'lists frames, snapshots iframe, fills and clicks inside iframe',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/')

        // 打开弹出框，让 iframe 加载
        await session.click('[data-testid=open-modal]')

        // 1. listFrames 返回主文档和 iframe
        const inventory = await session.listFrames()
        expect(inventory.frames.length).toBeGreaterThanOrEqual(2)
        expect(inventory.mainFrameId).toBeDefined()

        // 找到 iframe 的 frameId
        const iframeInfo = inventory.frames.find(
          (f) => f.frameId !== inventory.mainFrameId,
        )
        expect(iframeInfo).toBeDefined()
        expect(iframeInfo!.sameOrigin).toBe(true)
        expect(iframeInfo!.operationAllowed).toBe(true)
        expect(iframeInfo!.locatorChain.length).toBeGreaterThan(0)

        const frameId = iframeInfo!.frameId

        // 2. frame snapshot 返回 iframe 内部内容
        const frameSnapshot = await session.snapshot({ frameId })
        expect(frameSnapshot.frame).toBeDefined()
        expect(frameSnapshot.frame!.frameId).toBe(frameId)
        expect(frameSnapshot.title).toBe('Form Frame')
        expect(frameSnapshot.candidateLocators.length).toBeGreaterThan(0)

        // 3. frame query 只命中 iframe 内部元素
        const elements = await session.query('input, textarea, button', { frameId })
        expect(elements.length).toBeGreaterThanOrEqual(2)

        // 4. frame fill 真实填入 iframe 内输入框
        await session.fill(
          '[data-testid=frame-title]',
          '测试标题',
          { frameId },
        )

        // 验证填入生效：从主文档视角看不到该值，但从 frame 内 query 可以
        const filledElement = await session.query('[data-testid=frame-title]', { frameId })
        expect(filledElement[0]?.value).toBe('测试标题')

        // 5. frame select 选择下拉框
        await session.selectOption(
          '[data-testid=frame-category]',
          'urgent',
          { frameId },
        )

        // 6. frame click 点击提交按钮
        await session.click('[data-testid=frame-submit]', { frameId })

        // 验证点击生效：iframe 内的结果元素变为可见
        const resultElement = await session.query('[data-testid=frame-result]', { frameId })
        expect(resultElement.length).toBe(1)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'invalidates old frameId after navigation',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/')
        await session.click('[data-testid=open-modal]')

        const inventory = await session.listFrames()
        const iframeInfo = inventory.frames.find(
          (f) => f.frameId !== inventory.mainFrameId,
        )
        expect(iframeInfo).toBeDefined()
        const oldFrameId = iframeInfo!.frameId

        // 导航后旧 frameId 失效
        await session.navigate('/')

        await expect(
          session.snapshot({ frameId: oldFrameId }),
        ).rejects.toMatchObject({
          code: 'FRAME_NOT_FOUND',
        })
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'frame waitFor selector works inside iframe',
    async () => {
      const fixture = await startFixtureServer()
      const session = await createBrowserSessionFactory().create({
        baseUrl: fixture.url,
        headed: false,
      })

      try {
        await session.navigate('/')
        await session.click('[data-testid=open-modal]')

        const inventory = await session.listFrames()
        const iframeInfo = inventory.frames.find(
          (f) => f.frameId !== inventory.mainFrameId,
        )
        const frameId = iframeInfo!.frameId

        // 点击提交，触发结果元素显示
        await session.click('[data-testid=frame-submit]', { frameId })

        // 等待 iframe 内的结果元素出现
        const result = await session.waitFor(
          {
            kind: 'selector',
            selector: '[data-testid=frame-result]',
            state: 'visible',
          },
          { frameId },
        )
        expect(result.matched).toBe(true)
      } finally {
        await session.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )
})

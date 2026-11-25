/**
 * 验证 Web 静态资源托管的行为契约。
 *
 * 这些断言锁住的是从服务层迁出时**必须逐字保留**的安全性质与降级行为：
 * 路径穿越防护、安全响应头、产物缺失时的 503 降级页。
 * 迁移可以改位置与依赖方向，但不得放宽这些约束。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import {
  registerWebStaticRoutes,
  resolveWebDistInfo,
} from '../src/register-web-static-routes'

let tempRoot = ''

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-web-host-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tempRoot, { recursive: true, force: true })
})

/**
 * 构造一个只挂载了静态资源的应用。
 * @returns 待测试的 Hono 应用。
 */
function createApp(): Hono {
  const app = new Hono()
  registerWebStaticRoutes(app)
  return app
}

describe('resolveWebDistInfo', () => {
  it('能解析到已安装的 web 包与其 dist 目录', async () => {
    const resolved = await resolveWebDistInfo()

    // 工作区内 web 包已构建，因此应解析成功；
    // 若失败说明 web-host 漏声明了 @authine-e2e-agent/web 依赖。
    expect(resolved.source).toBe('dependency')
    expect(resolved.webDistDirectoryPath).not.toBeNull()
    expect(path.basename(resolved.webDistDirectoryPath ?? '')).toBe('dist')
  })
})

describe('静态资源路由', () => {
  it('产物可用时返回页面与安全响应头，不出现降级页', async () => {
    const response = await createApp().request('http://127.0.0.1:5826/')

    expect(response.status).toBe(200)

    const body = await response.text()
    // 降级页会写明「依赖包不可用」；正常页面不应出现这段文案。
    expect(body).not.toContain('Web 工作台依赖包不可用')

    expect(response.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'none'",
    )
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('前端路由的兜底请求同样返回页面（SPA 深链可用）', async () => {
    const response = await createApp().request(
      'http://127.0.0.1:5826/agent/workbench',
    )

    expect(response.status).toBe(200)
  })

  it('不存在于 dist 的资源返回 404，不落到页面兜底', async () => {
    const response = await createApp().request(
      'http://127.0.0.1:5826/assets/definitely-not-here.js',
    )

    expect(response.status).toBe(404)
  })

  it('用编码的路径穿越尝试被拒绝', async () => {
    const response = await createApp().request(
      'http://127.0.0.1:5826/assets/%2e%2e%2f%2e%2e%2fpackage.json',
    )

    expect(response.status).toBe(404)
  })
})

describe('API 路由不被静态兜底遮蔽', () => {
  it('先注册的 API 路由优先于 `*` 兜底', async () => {
    const app = new Hono()

    // 模拟服务层：先挂 API，再交给 web-host 挂静态资源。
    app.get('/api/ping', (context) => context.json({ ok: true }))
    registerWebStaticRoutes(app)

    const apiResponse = await app.request('http://127.0.0.1:5826/api/ping')

    expect(apiResponse.status).toBe(200)
    await expect(apiResponse.json()).resolves.toEqual({ ok: true })

    // 非 API 路径仍应由页面兜底接住。
    expect((await app.request('http://127.0.0.1:5826/')).status).toBe(200)
  })
})

describe('产物缺失时的降级', () => {
  it('解析不到产物时页面路由返回 503 降级页，资源路由返回 404', async () => {
    // 用注入的替身模拟「web 包不可用」，无需真的卸载依赖。
    const app = new Hono()
    registerWebStaticRoutes(app, {
      resolveWebDistInfo: async () => ({
        webDistDirectoryPath: null,
        source: 'missing',
      }),
    })

    const pageResponse = await app.request('http://127.0.0.1:5826/')

    expect(pageResponse.status).toBe(503)
    await expect(pageResponse.text()).resolves.toContain(
      'Web 工作台依赖包不可用',
    )

    const assetResponse = await app.request(
      'http://127.0.0.1:5826/assets/index.js',
    )

    expect(assetResponse.status).toBe(404)
  })

  it('降级页也适用于前端深链，且不泄露内部路径', async () => {
    const app = new Hono()
    registerWebStaticRoutes(app, {
      resolveWebDistInfo: async () => ({
        webDistDirectoryPath: null,
        source: 'missing',
      }),
    })

    const deepLinkResponse = await app.request(
      'http://127.0.0.1:5826/skills/some-skill',
    )

    expect(deepLinkResponse.status).toBe(503)

    const body = await deepLinkResponse.text()

    // 降级页只说明「依赖包不可用」，不应把本机绝对路径暴露给浏览器。
    expect(body).not.toContain(process.cwd())
    expect(body).not.toMatch(/[A-Z]:\\/)
  })
})

describe('产物可用性判据', () => {
  it('解析成功时必须指向含 index.html 的目录', async () => {
    // 只看目录存在不够——构建未完成的 dist 会是空目录。
    // 契约是「能解析到 web 包且其 dist/index.html 可读」才算可用。
    const resolved = await resolveWebDistInfo()

    if (resolved.webDistDirectoryPath) {
      const indexHtml = await readFile(
        path.join(resolved.webDistDirectoryPath, 'index.html'),
        'utf-8',
      )

      // Vite 产物用小写 doctype；这里只断言是一个完整的 HTML 文档。
      expect(indexHtml.toLowerCase()).toContain('<!doctype html>')
      expect(resolved.source).toBe('dependency')
      return
    }

    // 解析不到时必须是明确的 missing，而不是抛异常或返回半成品路径。
    expect(resolved.source).toBe('missing')
    expect(resolved.webDistDirectoryPath).toBeNull()
  })
})

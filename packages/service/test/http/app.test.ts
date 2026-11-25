/**
 * 验证本地 HTTP 应用的健康协议、配置 API 和错误信封行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { LOCAL_SERVICE_PROTOCOL_VERSION } from '@fynn90-e2e_assistant/types'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

let tempRoot = ''
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-test-'))
  process.env.APPDATA = path.join(tempRoot, 'app-data')
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config-home')
})

afterEach(async () => {
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  await rm(tempRoot, { recursive: true, force: true })
})

function createTestApp (logger = silentLogger) {
  return createHttpApp({
    chatRuntimeFactory () {
      throw new Error('Chat runtime should not be called in this test.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    logger,
    requestIdGenerator: () => 'request-test-id',
  })
}

const silentLogger = { request () { }, error () { } }

describe('local HTTP app', () => {
  it('returns the shared CLI health protocol', async () => {
    const app = createTestApp()
    const response = await app.request('http://127.0.0.1:5826/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      service: 'authine-e2e-agent-cli',
      status: 'ok',
      version: LOCAL_SERVICE_PROTOCOL_VERSION,
      // 服务需上报自身 PID，调用方据此把响应者与运行态记录精确对应，
      // 避免 PID 被无关进程复用后仍被当作本服务。
      pid: process.pid,
    })
  })

  it('allows direct local API access and returns structured API 404 responses', async () => {
    const app = createTestApp()
    const configResponse = await app.request('http://127.0.0.1:5826/api/config')

    expect(configResponse.status).toBe(200)
    expect(await configResponse.json()).toMatchObject({
      success: true,
      data: { state: 'uninitialized' },
    })

    const missing = await app.request('http://127.0.0.1:5826/api/missing')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({
      success: false,
      code: 'API_NOT_FOUND',
      requestId: 'request-test-id',
    })
  })

  it('initializes configuration without transport authentication or API key exposure', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    const response = await app.request(
      'http://127.0.0.1:5826/api/config/init',
      {
        method: 'POST',
        headers: {
          Host: 'untrusted.example',
          Origin: 'https://attacker.example',
          'Sec-Fetch-Site': 'cross-site',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectDirectory,
          llmApiKey: 'sentinel-secret-key',
          llmApiBaseUrl: 'http://127.0.0.1:9999/v1',
          llmModelName: 'fake-model',
        }),
      },
    )
    const bodyText = await response.text()

    expect(response.status).toBe(200)
    expect(bodyText).not.toContain('sentinel-secret-key')
    expect(JSON.parse(bodyText)).toMatchObject({
      success: true,
      data: {
        workspaceReady: true,
        chatReady: true,
      },
    })
  })

  it('静态资源成功请求不产生日志调用', async () => {
    // 一次页面加载产生二十余行 /assets/* 记录，是日志刷屏的主因（v19 Q1）。
    const requestLogger = vi.fn()
    const app = createTestApp({ request: requestLogger, error () { } })

    const response = await app.request('http://127.0.0.1:5826/assets/app.js')

    // 静默只影响打印：请求照常走到兜底（本测试未挂前端资源，故为 404）。
    expect(response.status).toBe(404)
    expect(requestLogger).not.toHaveBeenCalled()
  })

  it('静态资源请求失败时仍产生错误日志', async () => {
    const errorLogger = vi.fn()
    const app = createTestApp({ request () { }, error: errorLogger })

    const response = await app.request('http://127.0.0.1:5826/assets/missing.js')

    expect(response.status).toBe(404)
    expect(errorLogger).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/assets/missing.js', status: 404 }),
    )
  })

  it('API 请求的成功日志保持', async () => {
    const requestLogger = vi.fn()
    const app = createTestApp({ request: requestLogger, error () { } })

    await app.request('http://127.0.0.1:5826/api/config')

    expect(requestLogger).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/config', status: 200 }),
    )
  })
})

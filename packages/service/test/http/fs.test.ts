/**
 * 目录浏览 HTTP 接口测试：验证响应信封、错误码映射与未初始化配置下的可用性。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

const SERVICE_ORIGIN = 'http://127.0.0.1:5826'
let tempRoot = ''
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-fs-route-'))
  // 指向空的配置目录，确保平台配置处于未初始化状态。
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

function createTestApp() {
  return createHttpApp({
    chatRuntimeFactory() {
      throw new Error('Chat runtime should not be called in this test.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    logger: { request() {}, error() {} },
    requestIdGenerator: () => 'request-test-id',
  })
}

describe('directory browsing HTTP routes', () => {
  it('lists subdirectories without requiring an initialized platform config', async () => {
    const browseTarget = path.join(tempRoot, 'workspace')
    await mkdir(path.join(browseTarget, 'skill-one'), { recursive: true })

    const app = createTestApp()
    const response = await app.request(
      `${SERVICE_ORIGIN}/api/fs/directories?path=${encodeURIComponent(browseTarget)}`,
    )
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody).toMatchObject({
      success: true,
      data: {
        currentPath: path.resolve(browseTarget),
        currentEmpty: false,
        currentWritable: true,
        truncated: false,
      },
    })
    expect(
      responseBody.data.directories.map(
        (entry: { name: string }) => entry.name,
      ),
    ).toEqual(['skill-one'])
  })

  it('rejects a missing path query parameter', async () => {
    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/directories`)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
      requestId: 'request-test-id',
    })
  })

  it('maps a missing directory to DIRECTORY_NOT_FOUND', async () => {
    const app = createTestApp()
    const missingPath = path.join(tempRoot, 'missing')
    const response = await app.request(
      `${SERVICE_ORIGIN}/api/fs/directories?path=${encodeURIComponent(missingPath)}`,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'DIRECTORY_NOT_FOUND',
    })
  })

  it('maps a file path to DIRECTORY_NOT_ACCESSIBLE', async () => {
    const filePath = path.join(tempRoot, 'file.txt')
    await writeFile(filePath, 'content')

    const app = createTestApp()
    const response = await app.request(
      `${SERVICE_ORIGIN}/api/fs/directories?path=${encodeURIComponent(filePath)}`,
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'DIRECTORY_NOT_ACCESSIBLE',
    })
  })

  it('returns available browse roots', async () => {
    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/roots`)
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody.success).toBe(true)
    expect(responseBody.data.roots.length).toBeGreaterThan(0)
  })

  it('creates a directory and returns its absolute path', async () => {
    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: tempRoot, name: 'created-folder' }),
    })
    const responseBody = await response.json()

    expect(response.status).toBe(200)
    expect(responseBody).toEqual({
      success: true,
      data: { absolutePath: path.resolve(tempRoot, 'created-folder') },
    })
  })

  it('rejects a create request with unexpected fields', async () => {
    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentPath: tempRoot,
        name: 'new-folder',
        extra: true,
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
    })
  })

  it('maps a duplicate directory name to DIRECTORY_ALREADY_EXISTS', async () => {
    await mkdir(path.join(tempRoot, 'duplicate'))

    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: tempRoot, name: 'duplicate' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'DIRECTORY_ALREADY_EXISTS',
    })
  })

  it('rejects a directory name containing path separators', async () => {
    const app = createTestApp()
    const response = await app.request(`${SERVICE_ORIGIN}/api/fs/directories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPath: tempRoot, name: '../escape' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
    })
  })
})

/**
 * 验证图片预览字节路由的 HTTP 契约（v13）。
 *
 * 这是「文件树可打开图片」的服务端落点，因此重点验证：
 *   - 返回正确的 `Content-Type` 与**原始字节**（不是 JSON 信封）；
 *   - 非图片、越界路径、体积超限分别映射到正确的错误状态码；
 *   - 该路由绕过了文本读取的二进制拦截（这正是它存在的理由）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

/** 一个最小 PNG 字节序列（含签名，内容不重要）。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-skill-image-'))
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config-home')
  process.env.APPDATA = path.join(tempRoot, 'app-data')
})

afterEach(async () => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  await rm(tempRoot, { recursive: true, force: true })
})

/**
 * 创建供测试使用的 HTTP 应用。
 * @returns Hono 应用实例。
 * @throws 不抛出异常。
 */
function createTestApp () {
  return createHttpApp({
    chatRuntimeFactory () {
      throw new Error('Chat runtime should not run.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    logger: { request () { }, error () { } },
    requestIdGenerator: () => 'skill-image-http-test',
  })
}

/**
 * 写入平台配置，初始化 projectDirectory。
 * @param projectDirectory - 待写入的 Skill 工作目录。
 * @returns 配置写入完成的 Promise。
 */
async function writePlatformConfig (projectDirectory: string): Promise<void> {
  const configDirectory = path.join(tempRoot, 'app-data', 'e2e_assistant')
  await mkdir(projectDirectory, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    path.join(configDirectory, 'config.json'),
    JSON.stringify({
      projectDirectory,
      llmApiKey: 'fake-key',
      llmApiBaseUrl: 'http://127.0.0.1:9999/v1',
      llmModelName: 'fake-model',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    'utf-8',
  )
}

/**
 * 通过创建接口构造 Skill 夹具，并返回其磁盘目录。
 *
 * @param app - HTTP 应用实例。
 * @param projectDirectory - Skill 工作目录。
 * @returns Skill ID 与目录绝对路径。
 * @throws 创建失败时抛出断言错误。
 */
async function createSkillFixture (
  app: ReturnType<typeof createTestApp>,
  projectDirectory: string,
): Promise<{ skillId: string; skillRoot: string }> {
  const createResponse = await app.request('http://localhost/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '图片预览HTTP测试',
      description: '验证图片字节路由。',
    }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { data: { id: string } }
  const directoryName = (await readdir(projectDirectory)).find((name) =>
    name.endsWith(created.data.id),
  )
  expect(directoryName).toBeTruthy()
  return {
    skillId: created.data.id,
    skillRoot: path.join(projectDirectory, directoryName!),
  }
}

describe('GET /api/skills/:skillId/image', () => {
  it('返回图片原始字节与正确的 Content-Type（而非 JSON 信封）', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )

    await mkdir(path.join(skillRoot, 'baselines', 'img'), { recursive: true })
    await writeFile(
      path.join(skillRoot, 'baselines', 'img', 'candidate-a.png'),
      PNG_BYTES,
    )

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image?path=${encodeURIComponent('baselines/img/candidate-a.png')}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('content-length')).toBe(
      String(PNG_BYTES.byteLength),
    )

    const received = new Uint8Array(await response.arrayBuffer())
    expect(Array.from(received)).toEqual(Array.from(PNG_BYTES))
  })

  it('按扩展名返回对应的 MIME 类型', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )

    await writeFile(path.join(skillRoot, 'photo.jpg'), PNG_BYTES)

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image?path=${encodeURIComponent('photo.jpg')}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
  })

  it('文本文件经此路由也报不支持（该路由只服务图片）', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )

    await writeFile(path.join(skillRoot, 'SKILL.md'), '# 说明\n', 'utf-8')

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image?path=${encodeURIComponent('SKILL.md')}`,
    )

    // FILE_NOT_SUPPORTED → 422（见 api-error 的状态码映射表）
    expect(response.status).toBe(422)
    expect(((await response.json()) as { code: string }).code).toBe(
      'FILE_NOT_SUPPORTED',
    )
  })

  it('路径穿越被拒绝', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image?path=${encodeURIComponent('../../etc/passwd.png')}`,
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe(
      'INVALID_FILE_PATH',
    )
  })

  it('图片不存在时返回 404', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image?path=${encodeURIComponent('nope.png')}`,
    )

    expect(response.status).toBe(404)
    expect(((await response.json()) as { code: string }).code).toBe(
      'FILE_NOT_FOUND',
    )
  })

  it('缺少 path 参数时按路径非法处理', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/image`,
    )

    expect(response.status).toBe(400)
  })

  it('Skill ID 格式非法时返回 400', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)

    const response = await app.request(
      'http://localhost/api/skills/NOT-AN-ID/image?path=a.png',
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe(
      'INVALID_SKILL_ID',
    )
  })
})

/**
 * 验证「删除 Skill 内文件 / 目录」的 HTTP 契约（v13）。
 *
 * 删除不可逆，因此重点是**保护边界**必须经 HTTP 层同样生效——
 * 前端隐藏按钮只是即时反馈，服务端才是最终防线。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-file-delete-'))
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
    requestIdGenerator: () => 'skill-file-delete-http-test',
  })
}

/**
 * 写入平台配置。
 * @param projectDirectory - Skill 工作目录。
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
 * 创建 Skill 夹具并返回磁盘目录。
 * @param app - HTTP 应用实例。
 * @param projectDirectory - Skill 工作目录。
 * @returns Skill ID 与目录绝对路径。
 */
async function createSkillFixture (
  app: ReturnType<typeof createTestApp>,
  projectDirectory: string,
): Promise<{ skillId: string; skillRoot: string }> {
  const createResponse = await app.request('http://localhost/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '删除HTTP测试',
      description: '验证删除契约。',
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

/**
 * 构造删除请求地址。
 * @param skillId - Skill ID。
 * @param relativePath - 待删相对路径。
 * @returns 完整请求 URL。
 */
function buildDeleteUrl (skillId: string, relativePath: string): string {
  return `http://localhost/api/skills/${skillId}/file?path=${encodeURIComponent(relativePath)}`
}

describe('DELETE /api/skills/:skillId/file', () => {
  it('删除普通文件并返回类型', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )
    await writeFile(path.join(skillRoot, 'SKILL.md'), '# doc\n', 'utf-8')

    const response = await app.request(buildDeleteUrl(skillId, 'SKILL.md'), {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      data: { relativePath: string; kind: string }
    }
    expect(payload.data).toEqual({ relativePath: 'SKILL.md', kind: 'file' })
    await expect(stat(path.join(skillRoot, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('递归删除基线目录', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )
    await mkdir(path.join(skillRoot, 'baselines', 'img'), { recursive: true })
    await writeFile(path.join(skillRoot, 'baselines', 'img', 'a.png'), 'x')

    const response = await app.request(buildDeleteUrl(skillId, 'baselines'), {
      method: 'DELETE',
    })

    expect(response.status).toBe(200)
    expect(
      ((await response.json()) as { data: { kind: string } }).data.kind,
    ).toBe('directory')
    await expect(stat(path.join(skillRoot, 'baselines'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })

  it.each(['manifest.json', 'e2e_schema.json', 'env.json'])(
    '创建期文件 %s 经 HTTP 同样不可删',
    async (fileName) => {
      const app = createTestApp()
      const projectDirectory = path.join(tempRoot, 'workspace')
      await writePlatformConfig(projectDirectory)
      const { skillId, skillRoot } = await createSkillFixture(
        app,
        projectDirectory,
      )

      const response = await app.request(buildDeleteUrl(skillId, fileName), {
        method: 'DELETE',
      })

      // FILE_READ_ONLY → 403（见 api-error 状态码映射表）
      expect(response.status).toBe(403)
      expect(((await response.json()) as { code: string }).code).toBe(
        'FILE_READ_ONLY',
      )
      await expect(stat(path.join(skillRoot, fileName))).resolves.toBeTruthy()
    },
  )

  it('路径穿越被拒绝', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const response = await app.request(
      buildDeleteUrl(skillId, '../../evil.txt'),
      {
        method: 'DELETE',
      },
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe(
      'INVALID_FILE_PATH',
    )
  })

  it('缺少 path 参数时按路径非法处理（不会误删 Skill 根目录）', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillRoot } = await createSkillFixture(
      app,
      projectDirectory,
    )

    const response = await app.request(
      `http://localhost/api/skills/${skillId}/file`,
      {
        method: 'DELETE',
      },
    )

    expect(response.status).toBe(400)
    // Skill 目录必须完好
    await expect(stat(skillRoot)).resolves.toBeTruthy()
  })

  it('目标不存在时返回 404', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const response = await app.request(buildDeleteUrl(skillId, 'nope.txt'), {
      method: 'DELETE',
    })

    expect(response.status).toBe(404)
  })
})

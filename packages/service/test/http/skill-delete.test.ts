/**
 * 验证删除 Skill 的 HTTP 契约：彻底清理目录与索引、数据库关联数据清理，以及错误状态码。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSqliteSessionStore } from '@fynn90-e2e_assistant/agent'
import {
  createWorkBlockStore,
  resolveRuntimeDbPaths,
} from '../../src/agent-runtime/index'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-skill-delete-'))
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
 * 创建供测试使用的 HTTP 应用（Chat 等重运行时不会执行）。
 *
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
    requestIdGenerator: () => 'skill-delete-http-test',
  })
}

/**
 * 写入平台配置，初始化 projectDirectory。
 *
 * @param projectDirectory - 待写入的 Skill 工作目录。
 * @returns 配置初始化完成的 Promise。
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
 * 通过创建接口构造一个 Skill 夹具。
 *
 * @param app - HTTP 应用实例。
 * @param projectDirectory - Skill 工作目录。
 * @returns 创建的 Skill ID 与目录名。
 * @throws 创建失败时抛出断言错误。
 */
async function createSkillFixture (
  app: ReturnType<typeof createTestApp>,
  projectDirectory: string,
): Promise<{ skillId: string; skillDirectoryName: string }> {
  const createResponse = await app.request('http://localhost/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '删除HTTP测试',
      description: '验证删除流程。',
    }),
  })
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { data: { id: string } }
  const directoryName = (await readdir(projectDirectory)).find((name) =>
    name.endsWith(created.data.id),
  )
  expect(directoryName).toBeTruthy()
  return { skillId: created.data.id, skillDirectoryName: directoryName! }
}

describe('DELETE /api/skills/:skillId', () => {
  it('彻底删除目录与索引，并清除数据库关联会话与工作块', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId, skillDirectoryName } = await createSkillFixture(
      app,
      projectDirectory,
    )

    // 预置关联数据：会话库一条 skill 会话 + 工作块库一份工作块。
    const { sessionsDbPath, workBlocksDbPath } =
      resolveRuntimeDbPaths(projectDirectory)
    const sessionId = 'seed-session-1'
    const sessionsStore = createSqliteSessionStore({ dbPath: sessionsDbPath })
    await sessionsStore.save(
      sessionId,
      [{ role: 'user', content: 'hi', timestamp: 1 }],
      {
        skillId,
      },
    )
    sessionsStore.close()
    const workBlockStore = createWorkBlockStore({ dbPath: workBlocksDbPath })
    workBlockStore.applyEvent({
      type: 'turn',
      phase: 'begin',
      runId: 'run-1',
      sessionId,
      seq: 0,
      blockId: 'block-1',
      timestamp: 1,
    })
    workBlockStore.close()

    const deleteResponse = await app.request(
      `http://localhost/api/skills/${skillId}`,
      { method: 'DELETE' },
    )

    expect(deleteResponse.status).toBe(200)
    const body = (await deleteResponse.json()) as { data: { skillId: string } }
    expect(body.data.skillId).toBe(skillId)

    // 目录已消失。
    await expect(
      access(path.join(projectDirectory, skillDirectoryName)),
    ).rejects.toMatchObject({ code: 'ENOENT' })

    // 索引剔除。
    const listContent = await readFile(
      path.join(projectDirectory, 'skill.list.json'),
      'utf-8',
    )
    expect(listContent).not.toContain(skillId)

    // 数据库清理：会话与工作块均被清除。
    const sessionsStore2 = createSqliteSessionStore({ dbPath: sessionsDbPath })
    expect(await sessionsStore2.listSessions()).toHaveLength(0)
    expect(await sessionsStore2.getSession(sessionId)).toBeUndefined()
    sessionsStore2.close()
    const workBlockStore2 = createWorkBlockStore({ dbPath: workBlocksDbPath })
    expect(workBlockStore2.listSessions()).toHaveLength(0)
    workBlockStore2.close()
  })

  it('再次删除已删除的 Skill 返回 404', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)
    const { skillId } = await createSkillFixture(app, projectDirectory)

    const firstResponse = await app.request(
      `http://localhost/api/skills/${skillId}`,
      { method: 'DELETE' },
    )
    expect(firstResponse.status).toBe(200)

    const secondResponse = await app.request(
      `http://localhost/api/skills/${skillId}`,
      { method: 'DELETE' },
    )
    expect(secondResponse.status).toBe(404)
    const errorBody = (await secondResponse.json()) as { code: string }
    expect(errorBody.code).toBe('SKILL_NOT_FOUND')
  })

  it('Skill ID 格式非法时返回 400', async () => {
    const app = createTestApp()
    const projectDirectory = path.join(tempRoot, 'workspace')
    await writePlatformConfig(projectDirectory)

    const response = await app.request('http://localhost/api/skills/abc', {
      method: 'DELETE',
    })
    expect(response.status).toBe(400)
    const errorBody = (await response.json()) as { code: string }
    expect(errorBody.code).toBe('INVALID_SKILL_ID')
  })
})

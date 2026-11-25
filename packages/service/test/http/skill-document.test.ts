/**
 * 验证 SKILL.md 生成 SSE、候选不落盘、确认保存和并发冲突的 HTTP 契约。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  IE2ETestCase,
  IE2ETestCaseDocumentData,
} from '@charlie_deng/e2e-assistant-types'
import { createE2ETestCaseApplicationServices } from '../../src/application/e2e-test-case/create-services'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'
import type { ISkillMarkdownGenerator } from '../../src/application/e2e-test-case/skill-markdown-generator'

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(
    path.join(os.tmpdir(), 'authine-cli-skill-document-http-'),
  )
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
 * 根据结构化用例构造 fake Agent 的合法 SKILL.md 候选。
 *
 * @param testCase - 当前结构化 E2E 用例。
 * @returns 满足服务端正文校验器要求的 Markdown 文本。
 * @throws 不抛出异常。
 */
function buildContent (testCase: IE2ETestCase): string {
  const enabledSteps = testCase.steps.filter((step) => step.enabled)
  // v12：action / expectedResult 以 ```text 围栏承载原文（与真实生成模板一致），
  // 块内内容不参与文档结构解析。
  const steps = enabledSteps
    .map((step, index) =>
      [
        `${index + 1}. **${step.description}**`,
        '   - 操作：',
        '',
        '     ```text',
        `     ${step.action}`,
        '     ```',
        '',
        '   - 预期结果：',
        '',
        '     ```text',
        `     ${step.expectedResult}`,
        '     ```',
      ].join('\n'),
    )
    .join('\n\n')
  return `---
name: ${testCase.title}
description: ${testCase.description}
---

# 测试目标

${testCase.description}

## 执行上下文

- 目标 URL：\`${testCase.baseUrl}\`

## 前置条件

${testCase.preconditions.map((item, index) => `${index + 1}. ${item.description}`).join('\n') || '1. 测试环境可访问。'}

## 测试步骤

${steps}

## 执行注意事项

- 当前阶段不会运行 Playwright 测试。
`
}

/**
 * 创建使用真实文件仓储、但注入 fake Agent 生成器的 HTTP 应用。
 *
 * @returns 可直接执行配置初始化和 Skill API 请求的 Hono 应用。
 * @throws 不抛出异常。
 */
function createTestApp () {
  const generator: ISkillMarkdownGenerator = {
    async generate (input, options) {
      options.onProgress?.('requesting-model')
      options.onProgress?.('writing-skill')
      options.onProgress?.('repairing-output')
      const content = buildContent(input.testCase)
      await writeFile(
        path.join(input.targetDirectory, 'SKILL.md'),
        content,
        'utf8',
      )
      return {
        content,
        warnings: [],
        assumptions: [],
      }
    },
  }
  return createHttpApp({
    chatRuntimeFactory () {
      throw new Error('Chat runtime should not run.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    e2eTestCaseServices: createE2ETestCaseApplicationServices(
      undefined,
      () => generator,
    ),
    logger: { request () { }, error () { } },
    requestIdGenerator: () => 'skill-document-http-test',
  })
}

/**
 * 初始化本测试使用的平台配置和项目目录。
 *
 * @param app - HTTP 应用实例。
 * @returns 配置初始化响应完成的 Promise。
 * @throws 当配置接口返回异常时由调用方断言响应状态。
 */
async function initialize (
  app: ReturnType<typeof createTestApp>,
): Promise<void> {
  void app
  const projectDirectory = path.join(tempRoot, 'workspace')
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
 * 创建测试 Skill 并读取初始结构化用例文档。
 *
 * @param app - HTTP 应用实例。
 * @returns Skill ID、Skill 目录名和初始文档。
 * @throws 当测试前置 API 失败时抛出断言错误。
 */
async function createTestSkill (app: ReturnType<typeof createTestApp>): Promise<{
  skillId: string
  skillDirectoryName: string
  document: IE2ETestCaseDocumentData
}> {
  const createResponse = await app.request('http://localhost/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'HTTPSkill',
      description: '验证 HTTP 生成流程。',
    }),
  })
  if (createResponse.status !== 201)
    throw new Error(`创建 Skill 失败：${await createResponse.text()}`)
  expect(createResponse.status).toBe(201)
  const created = (await createResponse.json()) as { data: { id: string } }
  const getResponse = await app.request(
    `http://localhost/api/skills/${created.data.id}/e2e-test-case`,
  )
  expect(getResponse.status).toBe(200)
  const body = (await getResponse.json()) as { data: IE2ETestCaseDocumentData }
  const directoryName = (await readdir(path.join(tempRoot, 'workspace'))).find(
    (name) => name.endsWith(created.data.id),
  )
  expect(directoryName).toBeTruthy()
  return {
    skillId: created.data.id,
    skillDirectoryName: directoryName!,
    document: body.data,
  }
}

/**
 * 将测试用例补充为可以生成 SKILL.md 的完整用例。
 *
 * @param testCase - 初始结构化用例。
 * @returns 包含描述、目标 URL 和启用步骤的新用例。
 * @throws 不抛出异常。
 */
function readyTestCase (testCase: IE2ETestCase): IE2ETestCase {
  return {
    ...testCase,
    description: '验证 HTTP 生成流程。',
    baseUrl: 'https://example.test/login',
    steps: [
      {
        id: 'step_login',
        order: 1,
        description: '打开登录页面',
        action: '访问登录页。',
        expectedResult: '登录页面正常展示。',
        testData: {},
        enabled: true,
      },
    ],
  }
}

/**
 * 更新用例并返回服务端最新版本。
 *
 * @param app - HTTP 应用实例。
 * @param skillId - Skill ID。
 * @param document - 当前文档。
 * @returns 更新后的结构化用例文档。
 * @throws 当更新请求失败时抛出断言错误。
 */
async function updateTestCase (
  app: ReturnType<typeof createTestApp>,
  skillId: string,
  document: IE2ETestCaseDocumentData,
): Promise<IE2ETestCaseDocumentData> {
  const response = await app.request(
    `http://localhost/api/skills/${skillId}/e2e-test-case`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testCase: readyTestCase(document.testCase),
        expectedVersion: document.version,
      }),
    },
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { data: IE2ETestCaseDocumentData }).data
}

/**
 * 解析候选生成 SSE 中的 complete 事件数据。
 *
 * @param text - SSE 响应文本。
 * @returns 候选正文及其来源版本元数据。
 * @throws 当 SSE 缺少 complete 事件时抛出断言错误。
 */
function parseCompleteEvent (text: string): {
  content: string
  sourceHash: string
  skillDocumentVersion: string | null
} {
  const line = text
    .split('\n')
    .find(
      (item) => item.startsWith('data:') && item.includes('"type":"complete"'),
    )
  expect(line).toBeTruthy()
  const event = JSON.parse(line!.slice(5).trim()) as {
    data: {
      content: string
      sourceHash: string
      skillDocumentVersion: string | null
    }
  }
  return event.data
}

/**
 * 解析 SSE 文本中的 start 事件。
 *
 * @param text - 完整 SSE 响应文本。
 * @returns 已解析的 start 事件负载。
 * @throws 断言失败（无 start 事件）时由 expect 抛出。
 */
function parseStartEvent (text: string): {
  requestId: string
  sessionId: string
} {
  const line = text
    .split('\n')
    .find((item) => item.startsWith('data:') && item.includes('"type":"start"'))
  expect(line).toBeTruthy()
  return JSON.parse(line!.slice(5).trim()) as {
    requestId: string
    sessionId: string
  }
}

describe('SKILL.md HTTP routes', () => {
  it('streams progress, writes the document, then accepts a mode-tagged save', async () => {
    const app = createTestApp()
    await initialize(app)
    const created = await createTestSkill(app)
    const updated = await updateTestCase(app, created.skillId, created.document)
    const generationResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: null,
        }),
      },
    )
    const generationText = await generationResponse.text()
    expect(generationResponse.status).toBe(200)
    expect(generationText).toContain('event: start')
    expect(generationText).toContain('requesting-model')
    expect(generationText).toContain('repairing-output')
    expect(generationText).toContain('event: complete')
    // start 事件必须携带会话 ID：前端据此订阅工作事件流展示 Agent 工作内容。
    expect(parseStartEvent(generationText).sessionId).toBeTruthy()
    // complete 事件不再携带 agentSessionId（会话 ID 只在 start 下发，避免第二数据源）。
    expect(generationText).not.toContain('agentSessionId')

    const candidate = parseCompleteEvent(generationText)
    const skillDirectoryPath = path.join(
      tempRoot,
      'workspace',
      created.skillDirectoryName,
    )
    await expect(
      readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toBe(candidate.content)

    const saveResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: candidate.content,
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: candidate.skillDocumentVersion,
          mode: 'generation',
        }),
      },
    )
    expect(saveResponse.status).toBe(200)
    const saved = (await saveResponse.json()) as {
      data: { diagnostics: unknown[]; version: string }
    }
    expect(saved.data.diagnostics).toEqual([])
    await expect(
      readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toBe(candidate.content)

    // edit 模式：用户手改的正文可以写入（generation 模式仍严格阻断）。
    const editResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `${candidate.content}\n## 用户补充\n\n手改内容。\n`,
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: saved.data.version,
          mode: 'edit',
        }),
      },
    )
    expect(editResponse.status).toBe(200)
    await expect(
      readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('用户补充')

    // v15：generation 模式对**结构不完整**的正文不再阻断，而是写入并以诊断提醒。
    const latestVersion = (
      (await editResponse.json()) as { data: { version: string } }
    ).data.version
    const warnResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: '---\nname: nope\ndescription: nope\n---\n\n不完整。\n',
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: latestVersion,
          mode: 'generation',
        }),
      },
    )
    expect(warnResponse.status).toBe(200)
    const warned = (await warnResponse.json()) as {
      data: { diagnostics: Array<{ code: string }> }
    }
    expect(
      warned.data.diagnostics.map((diagnostic) => diagnostic.code),
    ).toContain('SKILL_DOCUMENT_SECTION_MISSING')
    // 内容确实落盘——诊断不阻断写入。
    await expect(
      readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('不完整。')
  })

  it('still rejects plaintext credentials in generation mode (security family)', async () => {
    const app = createTestApp()
    await initialize(app)
    const created = await createTestSkill(app)
    const updated = await updateTestCase(app, created.skillId, created.document)
    const generationResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: null,
        }),
      },
    )
    const candidate = parseCompleteEvent(await generationResponse.text())
    const skillDirectoryPath = path.join(
      tempRoot,
      'workspace',
      created.skillDirectoryName,
    )

    const response = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `${candidate.content}\ntoken: sk-abcdefghijklmnopqrstuvwxyz\n`,
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: candidate.skillDocumentVersion,
          mode: 'generation',
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'SKILL_DOCUMENT_INVALID',
    })
    // 阻断时磁盘上不应出现这份带凭据的内容（仍是 Agent 写入的那一份）。
    await expect(
      readFile(path.join(skillDirectoryPath, 'SKILL.md'), 'utf-8'),
    ).resolves.not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
  })

  it('returns source-hash and document-version conflicts without overwriting the document', async () => {
    const app = createTestApp()
    await initialize(app)
    const created = await createTestSkill(app)
    const updated = await updateTestCase(app, created.skillId, created.document)
    const generationResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: null,
        }),
      },
    )
    const candidate = parseCompleteEvent(await generationResponse.text())

    const changedTestCase = {
      ...readyTestCase(updated.testCase),
      description: '验证变更后的流程。',
    }
    const changeResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/e2e-test-case`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase: changedTestCase,
          expectedVersion: updated.version,
        }),
      },
    )
    expect(changeResponse.status).toBe(200)

    const sourceConflictResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: candidate.content,
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: candidate.skillDocumentVersion,
          mode: 'generation',
        }),
      },
    )
    expect(sourceConflictResponse.status).toBe(409)
    expect(await sourceConflictResponse.json()).toMatchObject({
      success: false,
      code: 'SOURCE_HASH_CONFLICT',
    })

    const changedDocument = (await changeResponse.clone().json()) as {
      data: IE2ETestCaseDocumentData
    }
    const freshGenerationResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: changedDocument.data.version,
          expectedSkillDocumentVersion: candidate.skillDocumentVersion,
        }),
      },
    )
    const freshCandidate = parseCompleteEvent(
      await freshGenerationResponse.text(),
    )
    const firstSaveResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: freshCandidate.content,
          sourceHash: freshCandidate.sourceHash,
          expectedSkillDocumentVersion: freshCandidate.skillDocumentVersion,
          mode: 'generation',
        }),
      },
    )
    expect(firstSaveResponse.status).toBe(200)

    // 版本守卫：文件已存在时用 expectedVersion = null（断言「文件必须不存在」）
    // 必须被拒绝，避免乐观并发检查被绕过而覆盖外部修改。
    const versionConflictResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: freshCandidate.content,
          sourceHash: freshCandidate.sourceHash,
          expectedSkillDocumentVersion: null,
          mode: 'generation',
        }),
      },
    )
    expect(versionConflictResponse.status).toBe(409)
    expect(await versionConflictResponse.json()).toMatchObject({
      success: false,
      code: 'FILE_VERSION_CONFLICT',
    })
  })

  it('SKILL.md 被删除后重新生成应当成功（缺失语义是新建，不是冲突）', async () => {
    const app = createTestApp()
    await initialize(app)
    const created = await createTestSkill(app)
    const updated = await updateTestCase(app, created.skillId, created.document)

    // 先生成一次，拿到版本号（模拟前端缓存的「旧版本」）
    const firstGeneration = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: null,
        }),
      },
    )
    expect(firstGeneration.status).toBe(200)
    const firstCandidate = parseCompleteEvent(await firstGeneration.text())

    // 确认保存，使 SKILL.md 落盘
    await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: firstCandidate.content,
          sourceHash: firstCandidate.sourceHash,
          expectedSkillDocumentVersion: null,
          mode: 'generation',
        }),
      },
    )

    // 用户从文件树删除 SKILL.md
    const skillDirectory = path.join(
      tempRoot,
      'workspace',
      created.skillDirectoryName,
    )
    const existedVersion = await readFile(
      path.join(skillDirectory, 'SKILL.md'),
      'utf-8',
    )
    expect(existedVersion.length).toBeGreaterThan(0)
    await rm(path.join(skillDirectory, 'SKILL.md'))

    // 重新生成：前端此时可能仍持删除前的旧版本号，
    // 但文件已不存在 —— 这属于「新建」，不应被版本守卫当成「外部修改」拒绝。
    const regenerateResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: 'a'.repeat(64),
        }),
      },
    )

    expect(regenerateResponse.status).toBe(200)
    const regenerateText = await regenerateResponse.text()
    // 生成接口经 SSE 上报错误（HTTP 仍为 200），必须显式确认没有 error 事件——
    // 否则「HTTP 200」会把失败误判为成功。
    expect(regenerateText).not.toContain('"type":"error"')
    const regenerated = parseCompleteEvent(regenerateText)
    expect(regenerated.content.length).toBeGreaterThan(0)
  })

  it('文件存在时仍拒绝用过期版本覆盖（保住乐观并发保护）', async () => {
    const app = createTestApp()
    await initialize(app)
    const created = await createTestSkill(app)
    const updated = await updateTestCase(app, created.skillId, created.document)

    // 先落盘一份 SKILL.md
    const generationResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: null,
        }),
      },
    )
    const candidate = parseCompleteEvent(await generationResponse.text())
    const saveResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-document`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: candidate.content,
          sourceHash: candidate.sourceHash,
          expectedSkillDocumentVersion: candidate.skillDocumentVersion,
          mode: 'generation',
        }),
      },
    )
    expect(saveResponse.status).toBe(200)
    // 确认文件确实落盘（守卫依赖「文件存在」这一前提）
    await expect(
      readFile(
        path.join(
          tempRoot,
          'workspace',
          created.skillDirectoryName,
          'SKILL.md',
        ),
        'utf-8',
      ),
    ).resolves.toContain('# 测试目标')

    // 文件存在 + 过期版本 → 仍必须报冲突（本次改动只放开「文件不存在」）
    const conflictResponse = await app.request(
      `http://localhost/api/skills/${created.skillId}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.version,
          expectedSkillDocumentVersion: 'b'.repeat(64),
        }),
      },
    )

    expect(conflictResponse.status).toBe(200)
    const conflictText = await conflictResponse.text()
    expect(conflictText).toContain('"type":"error"')
    expect(conflictText).toContain('FILE_VERSION_CONFLICT')
  })
})

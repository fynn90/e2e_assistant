/**
 * 验证 E2E 用例和 Playwright 生成 HTTP 路由的契约、SSE 与依赖注入。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hashBytes } from '@fynn90-e2e_assistant/skill-manager'
import {
  createDefaultE2ETestCase,
  type IE2ETestCaseDocumentData,
} from '@fynn90-e2e_assistant/types'
import { createE2ETestCaseApplicationServices } from '../../src/application/e2e-test-case/create-services'
import type { IPlaywrightScriptAgentGenerator } from '../../src/application/e2e-test-case/playwright-script-generator'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'
import { getPlatformConfigPath } from '../../src/config/config-path'
import type { IE2ETestCaseApplicationServices } from '../../src/application/e2e-test-case/application-types'
import {
  createGenerationTaskRegistry,
  type IGenerationBrowserHost,
} from '../../src/generation-runtime'

let tempRoot = ''
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-e2e-api-'))
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

const document: IE2ETestCaseDocumentData = {
  testCase: createDefaultE2ETestCase({
    skillId: 'abc123def',
    title: '登录测试',
    description: '',
  }),
  version: 'a'.repeat(64),
  sourceHash: `sha256:${'b'.repeat(64)}`,
  updatedAt: new Date(0).toISOString(),
  script: {
    exists: false,
    status: 'not_generated',
    version: null,
    generatedAt: null,
    updatedAt: null,
    sourceHash: null,
  },
}

/**
 * 浏览器宿主替身：测试中不得真的启动 Playwright 浏览器。
 *
 * 只记录调用，让生成编排的其余部分（版本校验、temp 工作区、SSE）可被验证。
 */
function createBrowserHostStub (): IGenerationBrowserHost & {
  acquired: string[]
  released: string[]
} {
  const acquired: string[] = []
  const released: string[] = []

  return {
    acquired,
    released,
    async ensureChromium () {
      return {
        installed: true,
        executablePath: '/fake/chromium',
        reason: undefined,
      }
    },
    async acquire (input) {
      acquired.push(
        `${input.sessionId}:${input.headed ? 'headed' : 'headless'}`,
      )
    },
    async release (sessionId) {
      released.push(sessionId)
    },
    // v19 关闭序列的第二步；测试中无真实浏览器可关闭。
    async dispose () { },
  }
}

function createTestApp (
  overrides: Partial<IE2ETestCaseApplicationServices> = {},
) {
  const services: IE2ETestCaseApplicationServices = {
    async get () {
      return document
    },
    async update () {
      return {
        ...document,
        title: document.testCase.title,
        description: document.testCase.description,
        updatedAt: new Date(0).toISOString(),
      }
    },
    async generate (input) {
      input.onProgress?.('preparing')
      input.onProgress?.('validating-code')
      return {
        code: "import { test, expect } from '@playwright/test'\n",
        warnings: [],
        assumptions: [],
        environmentVariables: [],
        stepCoverage: [],
        sourceHash: document.sourceHash,
        testCaseVersion: document.version,
        scriptVersion: null,
      }
    },
    async saveScript () {
      return {
        relativePath: 'test.spec.ts',
        version: 'c'.repeat(64),
        size: 50,
        sourceHash: document.sourceHash,
        generatedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        diagnostics: [],
      }
    },
    ...overrides,
  }
  const browserHost = createBrowserHostStub()
  return Object.assign(
    createHttpApp({
      chatRuntimeFactory () {
        throw new Error('Chat runtime should not run.')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      e2eTestCaseServices: services,
      generationRuntime: {
        browserHost,
        taskRegistry: createGenerationTaskRegistry(),
      },
      logger: { request () { }, error () { } },
      requestIdGenerator: () => 'request-test-id',
    }),
    { browserHost },
  )
}

function createRealRepositoryApp () {
  const generator: IPlaywrightScriptAgentGenerator = {
    async generate (input, options) {
      options.onProgress?.('writing-script')
      const step = input.testCase.steps.find((item) => item.enabled)

      if (!step) {
        throw new Error('Expected an enabled step.')
      }

      return {
        code: `import { test, expect } from '@playwright/test'\n\ntest(${JSON.stringify(input.testCase.title)}, async ({ page }) => {\n  await page.goto(${JSON.stringify(input.testCase.baseUrl)})\n  await test.step(${JSON.stringify(step.id)}, async () => {\n    await page.getByRole('button', { name: '登录' }).click()\n    await expect(page).toHaveURL(${JSON.stringify(input.testCase.baseUrl)})\n  })\n})\n`,
        warnings: [],
        assumptions: [],
      }
    },
  }
  const browserHost = createBrowserHostStub()
  return Object.assign(
    createHttpApp({
      chatRuntimeFactory () {
        throw new Error('Chat runtime should not run.')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      e2eTestCaseServices: createE2ETestCaseApplicationServices(
        () => generator,
      ),
      generationRuntime: {
        browserHost,
        taskRegistry: createGenerationTaskRegistry(),
      },
      logger: { request () { }, error () { } },
      requestIdGenerator: () => 'request-real-id',
    }),
    { browserHost },
  )
}

async function initialize (
  app: ReturnType<typeof createTestApp>,
): Promise<void> {
  await app.request('http://localhost/api/config/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectDirectory: path.join(tempRoot, 'workspace'),
      llmApiKey: 'fake-key',
      llmApiBaseUrl: 'http://127.0.0.1:9999/v1',
      llmModelName: 'fake-model',
    }),
  })
}

describe('E2E test case HTTP routes', () => {
  it('writes configuration under the isolated test directory', async () => {
    const app = createTestApp()
    await initialize(app)

    const expectedConfigRoot =
      process.platform === 'win32'
        ? path.join(tempRoot, 'app-data')
        : path.join(tempRoot, 'config-home')

    expect(getPlatformConfigPath()).toBe(
      path.join(expectedConfigRoot, 'e2e_assistant', 'config.json'),
    )
  })

  it('reads and saves a structured test case through injected services', async () => {
    const app = createTestApp()
    await initialize(app)
    const getResponse = await app.request(
      'http://localhost/api/skills/abc123def/e2e-test-case',
    )
    expect(getResponse.status).toBe(200)
    expect(await getResponse.json()).toMatchObject({
      success: true,
      data: { version: document.version },
    })

    const putResponse = await app.request(
      'http://localhost/api/skills/abc123def/e2e-test-case',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase: document.testCase,
          expectedVersion: document.version,
        }),
      },
    )
    expect(putResponse.status).toBe(200)
  })

  it('streams only stage events and a final validated candidate', async () => {
    const app = createTestApp()
    await initialize(app)
    const response = await app.request(
      'http://localhost/api/skills/abc123def/playwright-generation',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: document.version,
          expectedScriptVersion: null,
        }),
      },
    )
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('preparing')
    expect(text).toContain('validating-code')
    expect(text).toContain('complete')
    // start 事件必须携带会话 ID：前端据此关联全局侧边栏 Chat（PRD 7.6 / AC-09）。
    const startLine = text
      .split('\n')
      .find(
        (line) => line.startsWith('data:') && line.includes('"type":"start"'),
      )
    expect(startLine).toBeTruthy()
    expect(JSON.parse(startLine!.slice(5).trim())).toMatchObject({
      type: 'start',
      sessionId: expect.any(String),
    })
  })

  it('uses real repositories and writes the formal test.spec.ts on the save call', async () => {
    const app = createRealRepositoryApp()
    await initialize(app)
    const createResponse = await app.request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '真实流程Skill',
        description: 'HTTP integration',
      }),
    })
    const created = (await createResponse.json()) as { data: { id: string } }
    const skillId = created.data.id
    const getResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
    )
    const initial = (await getResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }
    const testCase = {
      ...initial.data.testCase,
      description: '验证用户登录。',
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录',
          action: '点击登录按钮',
          expectedResult: '保持在目标页面',
          testData: {},
          enabled: true,
        },
      ],
    }
    const updateResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase,
          expectedVersion: initial.data.version,
        }),
      },
    )
    const updated = (await updateResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }

    // 脚本生成的前置条件：SKILL.md 必须已生成、结构合法且基于当前用例（PRD 8.1 / 8.3）。
    // 这里直接按 Skill 目录结构写入文档与生成元数据，模拟即时保存已完成。
    const workspace = path.join(tempRoot, 'workspace')
    const directoryName = (await readdir(workspace)).find((name) =>
      name.endsWith(skillId),
    )
    const skillRoot = path.join(workspace, directoryName!)
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      [
        '---',
        `name: ${testCase.title}`,
        `description: ${testCase.description}`,
        '---',
        '',
        '# 测试目标',
        '',
        testCase.description,
        '',
        '## 执行上下文',
        '',
        `- 目标 URL：\`${testCase.baseUrl}\``,
        '',
        '## 前置条件',
        '',
        '1. 测试环境可访问。',
        '',
        '## 测试步骤',
        '',
        `1. **${testCase.steps[0]!.description}**`,
        // v12：action / expectedResult 以 ```text 围栏承载原文（与真实生成模板一致）。
        '   - 操作：',
        '',
        '     ```text',
        `     ${testCase.steps[0]!.action}`,
        '     ```',
        '',
        '   - 预期结果：',
        '',
        '     ```text',
        `     ${testCase.steps[0]!.expectedResult}`,
        '     ```',
        '',
        '## 执行注意事项',
        '',
        '- 当前阶段不会运行 Playwright 测试。',
        '',
      ].join('\n'),
      'utf-8',
    )
    const manifestPath = path.join(skillRoot, 'manifest.json')
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8'),
    ) as Record<string, unknown>
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...manifest,
          generatedSkill: {
            path: 'SKILL.md',
            sourceHash: updated.data.sourceHash,
            generatedAt: new Date(0).toISOString(),
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    const generationResponse = await app.request(
      `http://localhost/api/skills/${skillId}/playwright-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.data.version,
          expectedScriptVersion: null,
        }),
      },
    )
    const generationText = await generationResponse.text()
    const completeLine = generationText
      .split('\n')
      .find(
        (line) =>
          line.startsWith('data:') && line.includes('"type":"complete"'),
      )
    expect(completeLine).toBeTruthy()
    const completeEvent = JSON.parse(completeLine!.slice(5).trim()) as {
      data: { code: string; sourceHash: string; scriptVersion: string | null }
    }
    const scriptPath = path.join(skillRoot, 'test.spec.ts')
    await expect(readFile(scriptPath, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    // 候选脚本只存在于 temp/；生成结束后 temp/ 必须已被清理（PRD 4.4 / AC-05）。
    await expect(readdir(path.join(skillRoot, 'temp'))).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const saveResponse = await app.request(
      `http://localhost/api/skills/${skillId}/playwright-script`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: completeEvent.data.code,
          sourceHash: completeEvent.data.sourceHash,
          expectedScriptVersion: completeEvent.data.scriptVersion,
          mode: 'generation',
        }),
      },
    )

    expect(saveResponse.status).toBe(200)
    expect(await readFile(scriptPath, 'utf-8')).toContain(
      'test.step("step_login"',
    )
  })

  it('refuses to start script generation when SKILL.md is structurally invalid', async () => {
    const app = createRealRepositoryApp()
    await initialize(app)
    const createResponse = await app.request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '结构校验Skill',
        description: 'HTTP integration',
      }),
    })
    const created = (await createResponse.json()) as { data: { id: string } }
    const skillId = created.data.id
    const getResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
    )
    const initial = (await getResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }
    const testCase = {
      ...initial.data.testCase,
      description: '验证用户登录。',
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录',
          action: '点击登录按钮',
          expectedResult: '保持在目标页面',
          testData: {},
          enabled: true,
        },
      ],
    }
    const updateResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase,
          expectedVersion: initial.data.version,
        }),
      },
    )
    const updated = (await updateResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }

    // edit 模式放开了用户直接改 SKILL.md，磁盘上可能出现结构不完整的中间态。
    // 生成入口必须重新把关，避免把不完整文档喂给 Agent（PRD 8.1）。
    const workspace = path.join(tempRoot, 'workspace')
    const directoryName = (await readdir(workspace)).find((name) =>
      name.endsWith(skillId),
    )
    const skillRoot = path.join(workspace, directoryName!)
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: 结构校验Skill\ndescription: 验证用户登录。\n---\n\n# 测试目标\n\n缺少必需章节。\n',
      'utf-8',
    )
    const manifestPath = path.join(skillRoot, 'manifest.json')
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8'),
    ) as Record<string, unknown>
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          ...manifest,
          generatedSkill: {
            path: 'SKILL.md',
            sourceHash: updated.data.sourceHash,
            generatedAt: new Date(0).toISOString(),
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    const generationResponse = await app.request(
      `http://localhost/api/skills/${skillId}/playwright-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedTestCaseFileVersion: updated.data.version,
          expectedScriptVersion: null,
        }),
      },
    )
    const text = await generationResponse.text()

    expect(text).toContain('"type":"error"')
    expect(text).toContain('SKILL_DOCUMENT_INVALID')
    // 未通过入口校验时不得启动 Agent，也不得留下 temp/ 工作区。
    await expect(readdir(path.join(skillRoot, 'temp'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('preserves CRLF and BOM so the returned version matches a fresh read (G9)', async () => {
    const app = createRealRepositoryApp()
    await initialize(app)
    const createResponse = await app.request('http://localhost/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '换行BOM用例',
        description: 'HTTP integration',
      }),
    })
    const created = (await createResponse.json()) as { data: { id: string } }
    const skillId = created.data.id
    const getResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
    )
    const initial = (await getResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }
    const testCase = {
      ...initial.data.testCase,
      description: '验证用户登录。',
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录',
          action: '点击登录按钮',
          expectedResult: '保持在目标页面',
          testData: {},
          enabled: true,
        },
      ],
    }
    const updateResponse = await app.request(
      `http://localhost/api/skills/${skillId}/e2e-test-case`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase,
          expectedVersion: initial.data.version,
        }),
      },
    )
    const updated = (await updateResponse.json()) as {
      data: IE2ETestCaseDocumentData
    }

    const workspace = path.join(tempRoot, 'workspace')
    const directoryName = (await readdir(workspace)).find((name) =>
      name.endsWith(skillId),
    )
    const skillRoot = path.join(workspace, directoryName!)
    const scriptPath = path.join(skillRoot, 'test.spec.ts')

    // Windows 上 VSCode 或 git autocrlf 极易产出 CRLF + BOM 文件。
    // 读取时版本基于磁盘原始字节计算，因此写回必须保留这两种形态，
    // 否则返回的版本与再次读取的版本永不相等，下一次保存必然伪冲突。
    const crlfBomBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(
        "import { test } from '@playwright/test'\r\n\r\ntest('placeholder', async () => {})\r\n",
        'utf-8',
      ),
    ])
    await writeFile(scriptPath, crlfBomBytes)

    const readResponse = await app.request(
      `http://localhost/api/skills/${skillId}/file?path=${encodeURIComponent('test.spec.ts')}`,
    )
    expect(readResponse.status).toBe(200)
    const readBody = (await readResponse.json()) as {
      data: { content: string; version: string }
    }

    const saveResponse = await app.request(
      `http://localhost/api/skills/${skillId}/playwright-script`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `${readBody.data.content}\n// 用户补充\n`,
          sourceHash: updated.data.sourceHash,
          expectedScriptVersion: readBody.data.version,
          mode: 'edit',
        }),
      },
    )
    expect(saveResponse.status).toBe(200)
    const saved = (await saveResponse.json()) as {
      data: { version: string }
    }

    const savedBytes = await readFile(scriptPath)
    expect(savedBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(savedBytes.toString('utf-8')).toContain('\r\n')
    // 关键断言：保存返回的版本必须等于磁盘当前字节版本，否则下一次保存必然冲突。
    expect(hashBytes(savedBytes)).toBe(saved.data.version)

    // 用返回的版本再次保存必须成功（伪冲突会在此处暴露为 409）。
    const secondSave = await app.request(
      `http://localhost/api/skills/${skillId}/playwright-script`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `${readBody.data.content}\n// 用户补充二\n`,
          sourceHash: updated.data.sourceHash,
          expectedScriptVersion: saved.data.version,
          mode: 'edit',
        }),
      },
    )
    expect(secondSave.status).toBe(200)
  })

  it('rejects arbitrary script fields through strict request validation', async () => {
    const app = createTestApp()
    await initialize(app)
    const response = await app.request(
      'http://localhost/api/skills/abc123def/playwright-script',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'safe',
          sourceHash: document.sourceHash,
          expectedScriptVersion: null,
          path: '../../escape.ts',
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'INVALID_REQUEST',
    })
  })
})

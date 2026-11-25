/**
 * 覆盖 v5 结构化用例编辑、候选生成、确认保存和脚本过期主流程。
 */
import { expect, test, type Page } from '@playwright/test'
import { createAndSelectProjectDirectory } from './helpers/directory-picker'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let tempRoot = ''
let projectDirectory = ''
let configHome = ''
let cliProcess: ChildProcess | null = null
let fakeModelServer: Server | null = null
let fakeModelUrl = ''
let serverUrl = ''

const TEST_TITLE = '用户使用有效账号登录成功'
const UPDATED_TITLE = '用户登录后进入工作台'

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-v5-e2e-'))
  projectDirectory = path.join(tempRoot, 'workspace')
  configHome = path.join(tempRoot, 'config-home')
  await mkdir(configHome, { recursive: true })
  fakeModelServer = createFakeModelServer()
  const fakeAddress = await listen(fakeModelServer)
  fakeModelUrl = `http://127.0.0.1:${fakeAddress.port}/v1`

  cliProcess = spawn(
    process.execPath,
    ['apps/cli/dist/index.js', 'web', '--foreground', '--no-open', '--port', '5938'],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        APPDATA: configHome,
        XDG_CONFIG_HOME: configHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const runtime = await waitForRuntime(
    path.join(configHome, 'e2e_assistant', 'runtime.json'),
  )
  serverUrl = runtime.serverUrl
})

test.afterAll(async () => {
  // 必须先等 CLI 真正退出再删临时目录：它会保持 SQLite 会话文件（sessions.db*）打开，
  // 进程未退出时删除会因文件占用（Windows 上表现为 EBUSY）而失败。
  await stopCliProcess()
  await closeServer(fakeModelServer)
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

test('edits, generates both products into the sidebar, and marks a Playwright script stale', async ({
  page,
}) => {
  await page.goto(serverUrl)
  await createAndSelectProjectDirectory(page, {
    parentDirectory: tempRoot,
    directoryName: 'workspace',
  })
  await page.getByPlaceholder('请输入大模型 API Key').fill('fake-api-key')
  await page.getByPlaceholder('https://api.openai.com/v1').fill(fakeModelUrl)
  await page.getByPlaceholder('gpt-4.1-mini').fill('fake-model')
  await page.getByRole('button', { name: '提交配置' }).click()

  await expect(page.getByText('完成首次 Playwright 脚本')).toBeVisible()
  await expect(
    page.getByText(
      '当前流程只生成、审阅并保存 Playwright 脚本，不会运行测试。',
    ),
  ).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page
    .locator('.catalog-bar')
    .getByRole('button', { name: '新建 Skill' })
    .click()
  await page
    .getByPlaceholder('请输入名称 (仅中英文、数字、下划线、中划线)')
    .fill('V5登录Skill')
  await page
    .getByPlaceholder('请输入描述 (最大 200 字符)')
    .fill('V5 structured fixture')
  await page.getByRole('button', { name: '确认' }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/e2e-test-case$/)
  const skillId = new URL(page.url()).pathname.split('/')[2]
  await expect
    .poll(async () =>
      (await readdir(projectDirectory)).find((name) => name.endsWith(skillId)),
    )
    .toBeTruthy()
  const directoryName = (await readdir(projectDirectory)).find((name) =>
    name.endsWith(skillId),
  )
  const skillDirectory = path.join(projectDirectory, String(directoryName))
  const schemaPath = path.join(skillDirectory, 'e2e_schema.json')
  const defaultSchema = JSON.parse(await readFile(schemaPath, 'utf-8'))
  expect(defaultSchema.schemaVersion).toBe('1.0')
  expect(defaultSchema.steps).toEqual([])

  await expect(
    page.getByText('E2E 用例编辑器').or(page.getByText('基础信息')),
  ).toBeVisible()
  await expect(page.getByText('先完成一份可生成的结构化用例')).toBeVisible()
  // v7 起「生成 Playwright 脚本」按钮只在 SKILL.md 已基于当前用例时渲染，
  // 未就绪时用户看到的是 SKILL.md 生成入口及其阻塞原因。
  await page.getByRole('button', { name: '生成 Skill 文档' }).click()
  await expect(page.getByText('生成 Skill 文档前还需要完成：')).toBeVisible()
  const firstReadinessReason = page.locator('.reason-link').first()
  // 默认草稿已带标题与描述，因此首条阻塞原因是空的目标 URL。
  await expect(firstReadinessReason).toContainText('目标 URL')
  await firstReadinessReason.click()
  await expect(page.getByPlaceholder('https://example.test')).toBeFocused()
  await page
    .getByPlaceholder('例如：用户使用正确账号密码登录成功')
    .fill(TEST_TITLE)
  await page
    .getByPlaceholder('说明测试目标、业务背景和范围')
    .fill('验证有效用户可以进入工作台。')
  await page
    .getByPlaceholder('https://example.test')
    .fill('https://example.test')

  await page.getByRole('button', { name: '新增前置条件' }).click()
  await page
    .getByPlaceholder('例如：系统中存在一个可用测试账号')
    .fill('系统中存在可用测试账号')
  await page.getByRole('button', { name: '新增步骤' }).click()
  const firstRow = page.locator('.step-row').first()
  const stepTextareas = firstRow.locator('textarea')
  await stepTextareas.nth(0).fill('输入用户名')
  await stepTextareas.nth(1).fill('在用户名输入框填写 ${ENV:E2E_USERNAME}')
  await stepTextareas.nth(2).fill('用户名输入框显示对应内容')
  await firstRow.getByRole('button', { name: /测试数据/ }).click()
  await firstRow.getByRole('button', { name: '添加数据' }).click()
  const testDataInputs = firstRow.locator('.test-data-row input')
  await testDataInputs.nth(0).fill('username')
  await testDataInputs.nth(1).fill('${ENV:E2E_USERNAME}')
  await firstRow.getByRole('button', { name: '步骤 1 更多操作' }).click()
  await page.getByText('在后面插入', { exact: true }).click()
  const secondRow = page.locator('.step-row').nth(1)
  const secondTextareas = secondRow.locator('textarea')
  await secondTextareas.nth(0).fill('提交登录')
  await secondTextareas.nth(1).fill('点击登录按钮')
  await secondTextareas.nth(2).fill('页面保持可用并显示工作台')

  // 第 1 阶段：保存用例并生成 SKILL.md（脚本生成的前置条件）。
  // v9 起不再有生成弹窗：点击后侧边栏展开并承载整个过程与产物（AC-01）。
  await page.getByRole('button', { name: '保存并生成 Skill 文档' }).click()
  const sidebar = page.getByLabel('全局侧边栏 Chat')
  await expect(sidebar.getByText('SKILL 阶段')).toBeVisible()
  // 副标题随流程状态切换为「SKILL.md 完成」（PRD 5.2 / AC-03）。
  await expect(sidebar.getByText('SKILL.md 完成')).toBeVisible()
  // 即时保存：生成完成即落盘，无需用户点击任何保存或确认按钮（AC-08）。
  await expect
    .poll(
      async () => await readFileOrNull(path.join(skillDirectory, 'SKILL.md')),
    )
    .not.toBeNull()
  const skillDocumentContent = await readFile(
    path.join(skillDirectory, 'SKILL.md'),
    'utf-8',
  )
  expect(skillDocumentContent).toContain('# 测试目标')
  const persistedSchema = JSON.parse(await readFile(schemaPath, 'utf-8'))
  expect(persistedSchema.title).toBe(TEST_TITLE)
  expect(
    persistedSchema.steps.map((step: { order: number }) => step.order),
  ).toEqual([1, 2])
  expect(persistedSchema.steps[0].testData).toEqual({
    username: '${ENV:E2E_USERNAME}',
  })
  const manifest = JSON.parse(
    await readFile(path.join(skillDirectory, 'manifest.json'), 'utf-8'),
  )
  expect(manifest.title).toBe(TEST_TITLE)
  // manifest.generatedSkill 必须随即时保存一并写入，否则脚本生成会被判定为未生成（PRD 8.1）。
  expect(manifest.generatedSkill.sourceHash).toMatch(/^sha256:/)

  // 第 2 阶段：从 SKILL.md 卡片的主按钮进入脚本生成，脚本阶段在同一侧边栏内继续（AC-01）。
  await sidebar.getByRole('button', { name: '生成 Playwright 脚本' }).click()
  await expect(sidebar.getByText('Playwright 脚本阶段')).toBeVisible()
  await expect(sidebar.getByText('Playwright 脚本生成完成')).toBeVisible()
  await expect(sidebar.getByText('需要配置的环境变量')).toBeVisible()
  await expect(
    sidebar.locator('.env-list').getByText('E2E_USERNAME', { exact: true }),
  ).toBeVisible()
  await expect(sidebar.getByText('步骤覆盖', { exact: true })).toBeVisible()
  await expect(sidebar.locator('.monaco-diff-editor')).toBeVisible()

  // 即时保存到正式 test.spec.ts：无需用户点击保存按钮（AC-08）。
  const scriptPath = path.join(skillDirectory, 'test.spec.ts')
  await expect.poll(async () => await readFileOrNull(scriptPath)).not.toBeNull()
  const script = await readFile(scriptPath, 'utf-8')
  expect(script).toContain('process.env.E2E_USERNAME')
  const generatedManifest = JSON.parse(
    await readFile(path.join(skillDirectory, 'manifest.json'), 'utf-8'),
  )
  expect(generatedManifest.generatedScript.sourceHash).toMatch(/^sha256:/)

  // 关闭入口在最新卡片上：脚本卡片（AC-06）。
  await sidebar.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByText('首次脚本已保存')).toBeVisible()
  const onboardingStorageKey = `authine.onboarding.v1:${encodeURIComponent(projectDirectory)}`
  const persistedOnboarding = await page.evaluate((storageKey) => {
    const serialized = localStorage.getItem(storageKey)
    return serialized ? JSON.parse(serialized) : null
  }, onboardingStorageKey)
  expect(persistedOnboarding?.milestones['reviewed-script-saved']).toBeTruthy()
  expect(persistedOnboarding?.activationCompletedAt).toBeTruthy()

  await page.getByRole('button', { name: '完成引导' }).click()
  await expect(page.getByText('首次脚本已保存')).not.toBeVisible()
  await page.reload()
  await expect(page.getByText('首次脚本已保存')).not.toBeVisible()
  await page
    .locator('.explorer-pane')
    .getByText('e2e_schema.json', { exact: true })
    .click()
  await page
    .getByPlaceholder('例如：用户使用正确账号密码登录成功')
    .fill(UPDATED_TITLE)
  await page.getByRole('button', { name: '保存用例' }).click()
  await expect(page.getByText('脚本可能已过期')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true)
  const workspaceWidth = await page
    .locator('.workspace-pane')
    .evaluate((element) => element.clientWidth)
  const explorerTrigger = page.getByRole('button', {
    name: '打开 Skill 文件树',
  })
  await explorerTrigger.click()
  await expect(page.getByText('Skill 文件树', { exact: true })).toBeVisible()
  expect(
    await page
      .locator('.workspace-pane')
      .evaluate((element) => element.clientWidth),
  ).toBe(workspaceWidth)
  await page.keyboard.press('Escape')
  await expect(
    page.getByText('Skill 文件树', { exact: true }),
  ).not.toBeVisible()
  await expect(explorerTrigger).toBeFocused()

  await page
    .getByPlaceholder('例如：用户使用正确账号密码登录成功')
    .fill(`${UPDATED_TITLE}未保存`)
  await explorerTrigger.click()
  await page.getByText('test.spec.ts', { exact: true }).click()
  await expect(
    page.getByRole('dialog').getByText('存在未保存修改'),
  ).toBeVisible()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '继续编辑' })
    .click()
  await expect(page.getByText('Skill 文件树', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByText('Skill 文件树', { exact: true }),
  ).not.toBeVisible()

  await page.getByRole('button', { name: '← 返回' }).click()
  await expect(
    page.getByRole('dialog').getByText('存在未保存修改'),
  ).toBeVisible()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '放弃修改' })
    .click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.getByRole('heading', { name: UPDATED_TITLE })).toBeVisible()
})

/**
 * 构造假装模型的 HTTP 服务器。
 *
 * 模型运行时（pi-ai 的 OpenAI Chat Completions 适配）恒以 `stream: true` 调用，
 * 因此这里必须返回 SSE 增量，而不是一次性 JSON。
 *
 * 生成链路要求 Agent 真正调用工具落盘，因此本替身按「轮次」驱动一个极简状态机：
 *   - SKILL.md 生成：load_skill → write(SKILL.md) → 汇报文本；
 *   - 脚本生成：load_skill → write(temp/candidate.spec.ts) → 汇报文本。
 *
 * 状态用「本次会话历史上已出现的工具调用」推断，避免依赖跨请求的全局可变状态。
 * 全部产物内容都从 prompt 与消息历史中动态推导，使断言与用例数据保持一致。
 */
function createFakeModelServer (): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    const body = JSON.parse(await readRequestBody(request)) as {
      model: string
      stream?: boolean
      messages: Array<{
        role: string
        content?: unknown
        tool_calls?: unknown[]
        tool_call_id?: string
      }>
    }

    if (body.stream === false) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: '本替身只支持流式调用' }))
      return
    }

    // 只用 system / user 消息判断任务意图，避开工具结果对大段用例文本的干扰。
    // content 可能是字符串，也可能是 `{ type: 'text', text }` 组成的数组。
    const userText = body.messages
      .filter((message) => message.role === 'user')
      .map((message) => normalizeMessageText(message.content))
      .join('\n')
    if (!extractTargetFileOrNull(userText)) {
      throw new Error(`提示词中未找到目标文件路径：\n${userText}`)
    }
    const testCase = parseTestCaseFromPrompt(userText)

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    // 已发生的工具调用决定当前处于哪一步（不依赖服务端内存，便于用例间隔离）。
    const executed = collectExecutedToolNames(body.messages)

    if (executed.includes('write')) {
      // 产物已落盘：给出最终文本，并按 Skill 约定附上说明小节。
      streamAssistantText(
        response,
        body.model,
        [
          '已完成。',
          '',
          '## 断点',
          '无',
          '',
          '## 假设',
          '- 页面元素依据页面核对结果确定。',
          '',
          '## 警告',
          '无',
        ].join('\n'),
      )
      return
    }

    // 任务类型由后端下发的写入目标决定：SKILL.md 生成写 SKILL.md，
    // 脚本生成写 temp/candidate.spec.ts。用目标文件名而非提示词措辞判断，
    // 因为脚本生成的提示词同样会提到 SKILL.md（它是业务输入之一）。
    const targetFile = extractTargetFile(userText)
    const isSkillDocumentTask = targetFile.endsWith('SKILL.md')

    if (executed.includes('load_skill')) {
      // 第二轮：写入产物。
      const content = isSkillDocumentTask
        ? buildSkillDocument(testCase)
        : buildGeneratedCode(testCase.title, testCase.baseUrl, testCase.stepIds)

      streamToolCall(response, body.model, 'call_write', 'write', {
        path: targetFile,
        content,
      })
      return
    }

    // 第一轮：加载生成规则。Skill 名称由任务类型决定。
    streamToolCall(response, body.model, 'call_load_skill', 'load_skill', {
      name: isSkillDocumentTask
        ? 'test_case_Skill_document'
        : 'playwright_script_generation',
    })
  })
}

/** 从提示词中提取后端下发的固定写入目标绝对路径；找不到时返回 null。 */
function extractTargetFileOrNull (prompt: string): string | null {
  const candidateScript =
    /([A-Za-z]:[\\/][^\s"']*candidate\.spec\.ts|\/[^\s"']*candidate\.spec\.ts)/.exec(
      prompt,
    )
  if (candidateScript) return candidateScript[1]

  const skillDocument =
    /([A-Za-z]:[\\/][^\s"']*SKILL\.md|\/[^\s"']*SKILL\.md)/.exec(prompt)
  if (skillDocument) return skillDocument[1]

  return null
}

/** 从提示词中提取后端下发的固定写入目标绝对路径。 */
function extractTargetFile (prompt: string): string {
  const targetFile = extractTargetFileOrNull(prompt)
  if (!targetFile) {
    throw new Error('提示词中未找到目标文件路径。')
  }
  return targetFile
}

/** 把消息 content 归一为纯文本（字符串或内容块数组）。 */
function normalizeMessageText (content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) =>
      part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text: string }).text)
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

/** 从消息历史中收集已经执行过的工具名称。 */
function collectExecutedToolNames (
  messages: Array<{ role: string; content?: string; tool_calls?: unknown[] }>,
): string[] {
  const names: string[] = []

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls))
      continue

    for (const toolCall of message.tool_calls as Array<{
      function?: { name?: string }
    }>) {
      const name = toolCall.function?.name
      if (name) names.push(name)
    }
  }

  return names
}

/** 从提示词里解析出用例数据（prompt 中的 JSON 片段）。 */
function parseTestCaseFromPrompt (prompt: string): {
  title: string
  description: string
  baseUrl: string
  stepIds: string[]
  steps: Array<{
    id: string
    description: string
    action: string
    expectedResult: string
  }>
} {
  // 提示词由散文与 JSON 拼接而成，逐个尝试解析其中的 JSON 对象。
  // 不能用贪婪正则：正文里的 `${ENV:...}` 等花括号会跨进 JSON 片段导致解析失败。

  for (const fragment of extractJsonObjects(prompt)) {
    try {
      const parsed = JSON.parse(fragment) as {
        title?: string
        description?: string
        baseUrl?: string
        steps?: Array<{
          id?: string
          description?: string
          action?: string
          expectedResult?: string
        }>
      }
      if (!parsed.title || !Array.isArray(parsed.steps)) continue

      const steps = parsed.steps
        .filter((step) => typeof step.id === 'string')
        .map((step) => ({
          id: String(step.id),
          description: String(step.description ?? ''),
          action: String(step.action ?? ''),
          expectedResult: String(step.expectedResult ?? ''),
        }))

      return {
        title: parsed.title,
        description: parsed.description ?? '',
        baseUrl: parsed.baseUrl ?? '',
        stepIds: steps.map((step) => step.id),
        steps,
      }
    } catch {
      // 不是合法 JSON 的片段直接跳过，继续尝试下一个候选。
    }
  }

  // 解析失败不能静默降级：用编造的用例数据会掩盖提示词格式的真实问题。
  throw new Error(`未能从提示词中解析出用例数据：\n${prompt.slice(0, 2000)}`)
}

/**
 * 从混合文本中提取「成对花括号」片段，供后续尝试解析。
 *
 * 通过括号计数而非正则匹配：散文中的 `${ENV:...}` 只含左括号，
 * 计数法能跳过它，而贪婪正则会把多个片段连成一段非法 JSON。
 * 字符串字面量内的花括号会被忽略，避免用例文本里的括号干扰计数。
 */
function extractJsonObjects (text: string): string[] {
  const fragments: string[] = []
  let depth = 0
  let start = -1
  let inString = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }

    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        fragments.push(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return fragments
}

/**
 * 构造符合 `validateSkillDocument` 约定的 SKILL.md 正文。
 *
 * 校验器要求 frontmatter 与用例完全一致、包含全部必需章节与目标 URL、
 * 且每个启用步骤的标题必须是 `N. **<描述>**` 并包含其操作与预期结果。
 * v12：操作与预期结果以 ```text 围栏承载原文，块内不参与文档结构解析。
 */
function buildSkillDocument (testCase: {
  title: string
  description: string
  baseUrl: string
  steps: Array<{ description: string; action: string; expectedResult: string }>
}): string {
  const steps = testCase.steps
    .map((step, index) =>
      [
        `${index + 1}. **${step.description}**`,
        '   - 操作：',
        '',
        '     ```text',
        `     ${step.action}。`,
        '     ```',
        '',
        '   - 测试数据：无。',
        '   - 预期结果：',
        '',
        '     ```text',
        `     ${step.expectedResult}`,
        '     ```',
      ].join('\n'),
    )
    .join('\n\n')

  return [
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
    '无特殊前置条件。',
    '',
    '## 测试步骤',
    '',
    steps,
    '',
    '## 执行注意事项',
    '',
    '- 真实敏感值只能从运行环境读取。',
    '',
  ].join('\n')
}

/**
 * 构造符合 `PlaywrightScriptValidator` 约定的候选脚本。
 *
 * 每个启用步骤都必须被 `test.step('<step-id>')` 唯一包裹，
 * 且步骤内既有操作也有断言；`page.goto` 必须是同源字符串字面量。
 */
function buildGeneratedCode (
  title: string,
  baseUrl: string,
  stepIds: string[],
): string {
  const steps = stepIds
    .map((stepId, index) =>
      index === 0
        ? `  await test.step(${JSON.stringify(stepId)}, async () => {\n    const username = process.env.E2E_USERNAME\n    await page.getByLabel('用户名').fill(username ?? '')\n    await expect(page.getByLabel('用户名')).toHaveValue(username ?? '')\n  })`
        : `  await test.step(${JSON.stringify(stepId)}, async () => {\n    await page.getByRole('button', { name: '登录' }).click()\n    await expect(page).toHaveURL(${JSON.stringify(baseUrl)})\n  })`,
    )
    .join('\n')
  return `import { test, expect } from '@playwright/test'\n\ntest(${JSON.stringify(title)}, async ({ page }) => {\n  await page.goto(${JSON.stringify(baseUrl)})\n${steps}\n})\n`
}

/** 以 SSE 增量返回一次工具调用。 */
function streamToolCall (
  response: ServerResponse,
  model: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  writeChunk(response, model, {
    tool_calls: [
      {
        index: 0,
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })
  writeChunk(response, model, {}, 'tool_calls')
  response.end('data: [DONE]\n\n')
}

/** 以 SSE 增量返回纯文本回复。 */
function streamAssistantText (
  response: ServerResponse,
  model: string,
  text: string,
): void {
  writeChunk(response, model, { content: text })
  writeChunk(response, model, {}, 'stop')
  response.end('data: [DONE]\n\n')
}

/** 写入一个 chat.completion.chunk 事件。 */
function writeChunk (
  response: ServerResponse,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: 'chunk',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  )
}

/**
 * 终止 CLI 进程并等待其真正退出。
 *
 * 进程退出前会一直占用工作区内的 SQLite 会话文件，直接删除临时目录会失败。
 *
 * @returns 进程已退出（或被强制结束）后兑现的 Promise。
 * @throws 不抛出异常；等待超时后强制结束进程。
 */
async function stopCliProcess (): Promise<void> {
  const process_ = cliProcess
  if (!process_ || process_.killed) return

  const exited = new Promise<void>((resolve) =>
    process_.once('exit', () => resolve()),
  )
  process_.kill('SIGTERM')

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
  ])

  if (timedOut && !process_.killed) {
    process_.kill('SIGKILL')
    await exited
  }
}

async function readRequestBody (request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

async function readFileOrNull (filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null
    throw error
  }
}

function listen (server: Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        reject(new Error('Fake model server did not bind.'))
      else resolve({ port: address.port })
    })
  })
}

async function waitForRuntime (
  runtimePath: string,
): Promise<{ serverUrl: string }> {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(runtimePath, 'utf-8'))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  throw new Error('CLI runtime state was not created.')
}

function closeServer (server: Server | null): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

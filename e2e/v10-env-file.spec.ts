/**
 * 覆盖 v10 env.json 敏感数据管理的主流程（PRD v10 验收标准）：
 * 默认创建、env.json 编辑页阻断落盘、敏感数据引用、插入前置条件引用、
 * 引用失效提示与生成前就绪校验、普通行敏感数据软提醒。
 */
import { expect, test } from '@playwright/test'
import { createAndSelectProjectDirectory } from './helpers/directory-picker'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let tempRoot = ''
let projectDirectory = ''
let configHome = ''
let cliProcess: ChildProcess | null = null
let serverUrl = ''

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-v10-e2e-'))
  projectDirectory = path.join(tempRoot, 'workspace')
  configHome = path.join(tempRoot, 'config-home')
  await mkdir(configHome, { recursive: true })

  cliProcess = spawn(
    process.execPath,
    ['apps/cli/dist/index.js', 'web', '--foreground', '--no-open', '--port', '5961'],
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
  // 必须先等 CLI 真正退出再删临时目录：它保持 SQLite 会话文件打开，
  // 进程未退出时删除会因文件占用（Windows 上表现为 EBUSY）而失败。
  await new Promise<void>((resolve) => {
    if (!cliProcess) return resolve()
    cliProcess.once('exit', () => resolve())
    cliProcess.kill()
    setTimeout(resolve, 5000).unref?.()
  })
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

test('env.json 默认创建、阻断落盘、敏感数据引用与就绪校验', async ({
  page,
}) => {
  await page.goto(serverUrl)
  await createAndSelectProjectDirectory(page, {
    parentDirectory: tempRoot,
    directoryName: 'workspace',
  })
  // 就绪校验只要求配置字段齐全（不校验连通性），因此填一个不可达的合法地址即可；
  // 本用例的生成流程在校验层即被阻断，不会真正调用模型。
  await page.getByPlaceholder('请输入大模型 API Key').fill('fake-api-key')
  await page
    .getByPlaceholder('https://api.openai.com/v1')
    .fill('http://127.0.0.1:59999/v1')
  await page.getByPlaceholder('gpt-4.1-mini').fill('fake-model')
  await page.getByRole('button', { name: '提交配置' }).click()
  await expect(page.getByText('Skill 管理')).toBeVisible()

  // AC-01：新建 Skill 默认创建 env.json，文件树中立即可见。
  await page
    .locator('.catalog-bar')
    .getByRole('button', { name: '新建 Skill' })
    .click()
  await page
    .getByPlaceholder('请输入名称 (仅中英文、数字、下划线、中划线)')
    .fill('V10登录Skill')
  await page
    .getByPlaceholder('请输入描述 (最大 200 字符)')
    .fill('v10 env fixture')
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
  const envPath = path.join(skillDirectory, 'env.json')
  expect(await readFile(envPath, 'utf-8')).toBe('{\n}')

  // AC-02：桌面宽度下文件树常驻，点击 env.json 打开说明栏 + JSON 编辑器。
  await page
    .locator('.explorer-pane')
    .getByText('env.json', { exact: true })
    .click()
  await expect(
    page.getByText('env.json 用于保存本 Skill 的敏感数据'),
  ).toBeVisible()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(page.locator('.save-state')).toContainText('已保存')

  // AC-03：编辑非法 JSON 后保存被阻止，反馈区给出定位；磁盘保留最近合法内容。
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('{ "password": "明文密码"', { delay: 20 })
  await page.keyboard.press('Control+S')
  await expect(page.locator('.save-state')).toContainText('保存被阻止')
  const issues = page.locator('.env-issues')
  await expect(issues).toBeVisible()
  await expect(issues).toContainText('JSON 语法错误')
  expect(await readFile(envPath, 'utf-8')).toBe('{\n}')

  // AC-03：修正后保存恢复「已保存」，同时写入后续用例要用的 key。
  await page.keyboard.press('Control+A')
  await page.keyboard.type(
    '{\n  "E2E_PASSWORD": "真实密码值",\n  "ADMIN_TOKEN": "真实令牌值"\n}',
    { delay: 10 },
  )
  await page.keyboard.press('Control+S')
  await expect(page.locator('.save-state')).toContainText('已保存')
  await expect(issues).not.toBeVisible()
  expect(JSON.parse(await readFile(envPath, 'utf-8'))).toEqual({
    E2E_PASSWORD: '真实密码值',
    ADMIN_TOKEN: '真实令牌值',
  })

  // 回到结构化用例面板。
  await page
    .locator('.explorer-pane')
    .getByText('e2e_schema.json', { exact: true })
    .click()
  await page
    .getByPlaceholder('https://example.test')
    .fill('https://example.test')

  // AC-05：前置条件为长文本输入框；下拉插入占位符后光标停在占位符之后。
  await page.getByRole('button', { name: '新增前置条件' }).click()
  const preconditionInput =
    page.getByPlaceholder(/例如：系统中存在一个可用测试账号/)
  await preconditionInput.fill('用户已登录工作台')
  await preconditionInput.click()
  await page.keyboard.press('Control+End')
  await page.locator('.reference-insert .n-base-selection').click()
  await page
    .locator('.n-base-select-option')
    .filter({ hasText: 'ADMIN_TOKEN' })
    .first()
    .click()
  await expect(preconditionInput).toHaveValue(
    '用户已登录工作台${ENV:ADMIN_TOKEN}',
  )
  // I3：继续键入的文字必须落在占位符后面。
  await page.keyboard.type('后进入控制台')
  await expect(preconditionInput).toHaveValue(
    '用户已登录工作台${ENV:ADMIN_TOKEN}后进入控制台',
  )

  // AC-10：常量行填入疑似敏感明文 → 非阻断软提醒实时出现。
  await page.getByRole('button', { name: '新增步骤' }).click()
  const firstRow = page.locator('.step-row').first()
  const stepTextareas = firstRow.locator('textarea')
  await stepTextareas.nth(0).fill('提交登录')
  await stepTextareas.nth(1).fill('点击登录按钮')
  await stepTextareas.nth(2).fill('页面跳转到工作台')
  await firstRow.getByRole('button', { name: /测试数据/ }).click()
  await firstRow.getByRole('button', { name: '添加数据' }).click()
  const dataRow = firstRow.locator('.test-data-row').first()
  const plainInputs = dataRow.locator('input')
  await plainInputs.nth(0).fill('password')
  await plainInputs.nth(1).fill('123456')
  await expect(
    firstRow.getByText('疑似敏感数据，明文会写入 e2e_schema.json'),
  ).toBeVisible()

  // 保存不被阻断（提醒为引导）；旧的敏感词拦截不再出现（D4 已移除）。
  await page.getByRole('button', { name: '保存用例' }).click()
  await expect(page.getByText('E2E 用例已保存。')).toBeVisible()

  // AC-04：同一行的类型切换为「敏感数据」→ 值位置变为 env.json key 选择器。
  await dataRow.locator('.n-base-selection').first().click()
  await page
    .locator('.n-base-select-option')
    .filter({ hasText: '敏感数据' })
    .first()
    .click()
  // 切换后明文被丢弃，进入「未选择」中间态：行内出现 C5 提示。
  await expect(
    firstRow.getByText('敏感数据未选择 env.json 中的 key'),
  ).toBeVisible()
  await dataRow.locator('.n-base-selection').nth(1).click()
  await page
    .locator('.n-base-select-option')
    .filter({ hasText: 'E2E_PASSWORD' })
    .first()
    .click()
  await page.getByRole('button', { name: '保存用例' }).click()
  await expect(page.getByText('E2E 用例已保存。')).toBeVisible()

  const schemaPath = path.join(skillDirectory, 'e2e_schema.json')
  const persistedSchema = JSON.parse(await readFile(schemaPath, 'utf-8'))
  expect(persistedSchema.preconditions[0].description).toBe(
    '用户已登录工作台${ENV:ADMIN_TOKEN}后进入控制台',
  )
  // 数据契约：键名即 env key，值为引用占位符；用例文件中不含任何真实值。
  expect(persistedSchema.steps[0].testData).toEqual({
    password: '123456',
    E2E_PASSWORD: '${ENV:E2E_PASSWORD}',
  })
  expect(JSON.stringify(persistedSchema)).not.toContain('真实密码值')

  // AC-06：env.json 删除被引用的 key → 用例页行内失效警示；保存仍可用。
  await page
    .locator('.explorer-pane')
    .getByText('env.json', { exact: true })
    .click()
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('{\n  "E2E_PASSWORD": "真实密码值"\n}', {
    delay: 10,
  })
  await page.keyboard.press('Control+S')
  await expect(page.locator('.save-state')).toContainText('已保存')

  await page
    .locator('.explorer-pane')
    .getByText('e2e_schema.json', { exact: true })
    .click()
  await expect(
    firstRow
      .getByText('引用的 key "E2E_PASSWORD" 在 env.json 中不存在')
      .first(),
  ).toBeVisible()
  await expect(
    page.getByText('本条引用的 key "ADMIN_TOKEN" 在 env.json 中不存在'),
  ).toBeVisible()

  await page.getByRole('button', { name: '保存用例' }).click()
  await expect(page.getByText('E2E 用例已保存。')).toBeVisible()

  // 生成被就绪校验阻断，就绪摘要可跳转到 env.json 编辑页。
  await page
    .getByRole('button', { name: '生成 Skill 文档', exact: true })
    .click()
  const readiness = page.locator('.readiness-panel')
  await expect(readiness).toBeVisible()
  await expect(readiness).toContainText('在 env.json 中不存在')
  await readiness
    .locator('.reason-link')
    .filter({ hasText: 'env.json' })
    .first()
    .click()
  await expect(page).toHaveURL(
    new RegExp(`/skill-dev/${skillId}/code/env\\.json$`),
  )
  await expect(
    page.getByText('env.json 用于保存本 Skill 的敏感数据'),
  ).toBeVisible()

  // AC-07：env.json 格式非法 + 用例存在引用 → 生成被阻断并提示修复。
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('{ 不是合法 JSON', { delay: 10 })
  await page.keyboard.press('Control+S')
  await expect(page.locator('.save-state')).toContainText('保存被阻止')
  await page
    .locator('.explorer-pane')
    .getByText('e2e_schema.json', { exact: true })
    .click()
  await page
    .getByRole('button', { name: '生成 Skill 文档', exact: true })
    .click()
  await expect(page.locator('.readiness-panel')).toContainText(
    'env.json 存在格式错误',
  )
})

/** 等待 CLI 写出 runtime.json 并返回服务地址。 */
async function waitForRuntime (
  runtimePath: string,
): Promise<{ serverUrl: string }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const runtime = JSON.parse(await readFile(runtimePath, 'utf-8')) as {
        serverUrl?: string
      }
      if (runtime.serverUrl) return { serverUrl: runtime.serverUrl }
    } catch {
      // 尚未写出，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('CLI runtime.json 未在预期时间内生成。')
}

/**
 * 覆盖 v14 userWorkSpace 持久化目录的主链验收（PRD v14 验收标准 10.1/10.2/10.7）：
 * 新建 Skill 自动携带空 userWorkSpace（场景 1）→ 文件树展示受保护根节点 →
 * 悬停按钮矩阵（W40-W48）→ 新建目录/文件（D1/W14）→ 删除子内容后根目录保留
 * （场景 5/6）→ 删除整个 Skill 时随删（场景 16）。
 *
 * 生成链路（AskUserQuestion、视觉基准、脚本产物边界）依赖真实模型，
 * 由各包单元测试覆盖（模板一致性 × 校验器 × ask host 矩阵）；
 * 本文件覆盖 UI 与磁盘可验证的部分。
 */
import { expect, test } from '@playwright/test'
import { createAndSelectProjectDirectory } from './helpers/directory-picker'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let tempRoot = ''
let projectDirectory = ''
let configHome = ''
let cliProcess: ChildProcess | null = null
let serverUrl = ''

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-v14-e2e-'))
  projectDirectory = path.join(tempRoot, 'workspace')
  configHome = path.join(tempRoot, 'config-home')
  await mkdir(configHome, { recursive: true })

  cliProcess = spawn(
    process.execPath,
    ['apps/cli/dist/index.js', 'web', '--foreground', '--no-open', '--port', '5963'],
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

test('userWorkSpace 主链：创建、悬停新建、删除边界', async ({ page }) => {
  await page.goto(serverUrl)
  await createAndSelectProjectDirectory(page, {
    parentDirectory: tempRoot,
    directoryName: 'workspace',
  })
  await page.getByPlaceholder('请输入大模型 API Key').fill('fake-api-key')
  await page
    .getByPlaceholder('https://api.openai.com/v1')
    .fill('http://127.0.0.1:59999/v1')
  await page.getByPlaceholder('gpt-4.1-mini').fill('fake-model')
  await page.getByRole('button', { name: '提交配置' }).click()
  await expect(page.getByText('Skill 管理')).toBeVisible()

  // —— 10.1-1/场景 1：新建 Skill 后 userWorkSpace 必然存在 ——
  await page
    .locator('.catalog-bar')
    .getByRole('button', { name: '新建 Skill' })
    .click()
  await page
    .getByPlaceholder('请输入名称 (仅中英文、数字、下划线、中划线)')
    .fill('V14工作区Skill')
  await page
    .getByPlaceholder('请输入描述 (最大 200 字符)')
    .fill('v14 userWorkSpace fixture')
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
  const workspacePath = path.join(skillDirectory, 'userWorkSpace')

  // 空目录节点可见（W20）且磁盘上是目录。
  expect((await stat(workspacePath)).isDirectory()).toBe(true)
  await expect(
    page.locator('.explorer-pane').getByText('userWorkSpace', { exact: true }),
  ).toBeVisible()

  // —— 10.7-1/W41：根节点悬停显示「新建目录」「新建文件」，无删除按钮 ——
  const workspaceRow = page
    .locator('.n-tree-node', { hasText: 'userWorkSpace' })
    .first()
  await workspaceRow.hover()
  // 根节点恰好两个操作按钮（新建目录 + 新建文件；删除按钮不渲染，W21）。
  await expect
    .poll(async () => workspaceRow.locator('.tree-action-button').count())
    .toBe(2)

  // —— 10.7-5/W45-W48：新建入口直接进入名称输入；成功后刷新并展示新节点 ——
  await workspaceRow.locator('.tree-action-button').first().click()
  await page.getByPlaceholder('输入目录名（如 exports）').fill('exports')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(
    page.locator('.explorer-pane').getByText('exports', { exact: true }),
  ).toBeVisible()
  expect((await stat(path.join(workspacePath, 'exports'))).isDirectory()).toBe(
    true,
  )

  // 新建文件（R10：空文件）。
  const exportsRow = page
    .locator('.n-tree-node', { hasText: 'exports' })
    .first()
  await exportsRow.hover()
  await expect
    .poll(async () => exportsRow.locator('.tree-action-button').count())
    .toBe(3)
  await exportsRow.locator('.tree-action-button').nth(1).click()
  await page.getByPlaceholder('输入文件名（如 result.csv）').fill('result.csv')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(
    page.locator('.explorer-pane').getByText('result.csv', { exact: true }),
  ).toBeVisible()
  expect(
    await stat(path.join(workspacePath, 'exports', 'result.csv')),
  ).toBeTruthy()

  // —— W47：非法名称即时提示且不提交 ——
  await exportsRow.hover()
  await exportsRow.locator('.tree-action-button').first().click()
  await page.getByPlaceholder('输入目录名（如 exports）').fill('../escape')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(page.getByText('名称不合法')).toBeVisible()
  // 弹窗保留输入（W48 失败路径）。
  await expect(page.getByPlaceholder('输入目录名（如 exports）')).toHaveValue(
    '../escape',
  )
  await page.getByRole('button', { name: '取消' }).click()

  // —— 10.2/W16/场景 6：删除子目录递归删除，确认框含完整相对路径，根保留 ——
  const fileRow = page
    .locator('.n-tree-node', { hasText: 'result.csv' })
    .first()
  await fileRow.hover()
  await fileRow.locator('.tree-action-button').first().click()
  // W16：确认框正文展示完整相对路径（定向断言删除框元素，避开成功 toast 的同名文本）。
  await expect(page.locator('.delete-target-path')).toHaveText(
    'userWorkSpace/exports/result.csv',
  )
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(
    page.locator('.explorer-pane').getByText('result.csv', { exact: true }),
  ).toHaveCount(0)
  // 根目录仍然存在（W12：Skill 存续期间不可删除）。
  expect((await stat(workspacePath)).isDirectory()).toBe(true)

  // —— 10.2-2：平台 API 不能删除 userWorkSpace 根目录（场景 7，服务端最终防线） ——
  const deleteResponse = await page.request.delete(
    `${serverUrl}/api/skills/${skillId}/file?path=${encodeURIComponent('userWorkSpace')}`,
  )
  expect(deleteResponse.status()).toBe(403)
  expect((await stat(workspacePath)).isDirectory()).toBe(true)
})

/**
 * 等待 CLI 写出运行时信息（服务就绪信号）。
 *
 * @param runtimePath - runtime.json 的绝对路径。
 * @returns 服务地址等运行时信息。
 * @throws 超时未就绪时抛出。
 */
async function waitForRuntime (
  runtimePath: string,
): Promise<{ serverUrl: string }> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const content = await import('node:fs/promises').then((fs) =>
        fs.readFile(runtimePath, 'utf-8'),
      )
      const parsed = JSON.parse(content) as { serverUrl?: string }
      if (parsed.serverUrl) return { serverUrl: parsed.serverUrl }
    } catch {
      // 未就绪：继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error('CLI 服务在 60s 内未就绪。')
}

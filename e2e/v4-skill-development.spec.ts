import { expect, test } from '@playwright/test'
import { createAndSelectProjectDirectory } from './helpers/directory-picker'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
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

let tempRoot = ''
let projectDirectory = ''
let configHome = ''
let cliProcess: ChildProcess | null = null
let fakeModelServer: Server | null = null
let fakeModelUrl = ''
let serverUrl = ''
const modelRequests: string[] = []

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-v4-e2e-'))
  projectDirectory = path.join(tempRoot, 'workspace')
  configHome = path.join(tempRoot, 'config-home')
  await mkdir(configHome, { recursive: true })
  fakeModelServer = createFakeModelServer()
  const fakeAddress = await listen(fakeModelServer)
  fakeModelUrl = `http://127.0.0.1:${fakeAddress.port}/v1`

  cliProcess = spawn(
    process.execPath,
    ['apps/cli/dist/index.js', 'web', '--foreground', '--no-open', '--port', '5937'],
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
  const runtimePath = path.join(configHome, 'e2e_assistant', 'runtime.json')
  const runtime = await waitForRuntime(runtimePath)
  serverUrl = runtime.serverUrl
})

test.afterAll(async () => {
  // 必须先等 CLI 真正退出再删临时目录：它会保持 SQLite 会话文件（sessions.db*）打开，
  // 进程未退出时删除会因文件占用（Windows 上表现为 EBUSY）而失败。
  await stopCliProcess()
  await closeServer(fakeModelServer)
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

test('creates, edits, saves, and chats inside a Skill', async ({
  page,
  request,
}, testInfo) => {
  await page.goto(serverUrl)
  await createAndSelectProjectDirectory(page, {
    parentDirectory: tempRoot,
    directoryName: 'workspace',
  })
  await page.getByPlaceholder('请输入大模型 API Key').fill('fake-api-key')
  await page.getByPlaceholder('https://api.openai.com/v1').fill(fakeModelUrl)
  await page.getByPlaceholder('gpt-4.1-mini').fill('fake-model')
  await page.getByRole('button', { name: '提交配置' }).click()
  await expect(page.getByText('Skill 管理')).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileMenuTrigger = page.getByRole('button', { name: '打开工作台导航' })
  await expect(mobileMenuTrigger).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await mobileMenuTrigger.click()
  await expect(page.getByText('工作台导航', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('工作台导航', { exact: true })).toBeHidden()
  await expect(mobileMenuTrigger).toBeFocused()

  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(mobileMenuTrigger).toBeHidden()
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })

  await page
    .locator('.catalog-bar')
    .getByRole('button', { name: '新建 Skill' })
    .click()
  await page
    .getByPlaceholder('请输入名称 (仅中英文、数字、下划线、中划线)')
    .fill('测试Skill')
  await page.getByPlaceholder('请输入描述 (最大 200 字符)').fill('E2E fixture')
  await page.getByRole('button', { name: '确认' }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/e2e-test-case$/)
  await expect(page.getByRole('heading', { name: '测试Skill' })).toBeVisible()
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/chat$/)
  const initialComposer = page.getByPlaceholder(
    '输入消息，Enter 发送，Shift+Enter 换行',
  )
  await expect(initialComposer).toBeFocused()
  await initialComposer.fill('保留这段待发送内容')

  const chatPanel = page.locator('.chat-panel')
  const emptyComposerShell = page.locator('.composer-shell')
  const [emptyPanelBox, emptyComposerBox] = await Promise.all([
    chatPanel.boundingBox(),
    emptyComposerShell.boundingBox(),
  ])
  expect(emptyPanelBox).not.toBeNull()
  expect(emptyComposerBox).not.toBeNull()
  expect(emptyComposerBox!.width).toBeLessThanOrEqual(
    emptyPanelBox!.width * 0.69,
  )
  expect(emptyComposerBox!.y).toBeGreaterThan(
    emptyPanelBox!.y + emptyPanelBox!.height * 0.35,
  )
  expect(emptyComposerBox!.y).toBeLessThan(
    emptyPanelBox!.y + emptyPanelBox!.height * 0.72,
  )

  const skillId = new URL(page.url()).pathname.split('/')[2]
  const skillDirectoryName = (await readdir(projectDirectory)).find((name) =>
    name.endsWith(skillId),
  )
  expect(skillDirectoryName).toBeTruthy()
  const sourcePath = path.join(projectDirectory, skillDirectoryName!, 'main.ts')
  const secondarySourcePath = path.join(
    projectDirectory,
    skillDirectoryName!,
    'helpers.ts',
  )
  await Promise.all([
    writeFile(sourcePath, 'export const value = 1\n', 'utf-8'),
    writeFile(secondarySourcePath, 'export const helper = true\n', 'utf-8'),
  ])

  await page.getByRole('button', { name: '刷新' }).click()
  await page.getByText('main.ts', { exact: true }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/code\?path=main\.ts$/)
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('export const value = 2')
  await page.getByRole('button', { name: '保存' }).click()
  await expect
    .poll(async () => await readFile(sourcePath, 'utf-8'))
    .toContain('value = 2')

  await page.getByText('helpers.ts', { exact: true }).click()
  await expect(page).toHaveURL(
    /\/skill-dev\/[a-z0-9]{9}\/code\?path=helpers\.ts$/,
  )
  await expect(
    page.locator(
      '.skill-workspace-panel-enter-active, .skill-workspace-panel-leave-active',
    ),
  ).toHaveCount(0)
  await page.getByText('main.ts', { exact: true }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/code\?path=main\.ts$/)
  await expect(
    page.locator(
      '.skill-workspace-panel-enter-active, .skill-workspace-panel-leave-active',
    ),
  ).toHaveCount(0)

  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page).toHaveURL(/\/skill-dev\/[a-z0-9]{9}\/chat$/)
  await expect(initialComposer).toBeFocused()
  await page.screenshot({
    path: testInfo.outputPath('workspace-transition.png'),
    fullPage: true,
    animations: 'allow',
  })
  await expect(initialComposer).toHaveValue('保留这段待发送内容')
  await initialComposer.fill('请检查当前文件')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('button', { name: '同意并发送' }).click()
  await expect(page.getByText('Hello from fake model')).toBeVisible()
  expect(modelRequests.at(-1)).toContain('value = 2')

  const [messagePanelBox, dockedComposerBox] = await Promise.all([
    chatPanel.boundingBox(),
    page.locator('.composer-shell').boundingBox(),
  ])
  expect(messagePanelBox).not.toBeNull()
  expect(dockedComposerBox).not.toBeNull()
  expect(dockedComposerBox!.width).toBeLessThanOrEqual(
    messagePanelBox!.width * 0.69,
  )
  expect(
    Math.round(
      messagePanelBox!.y +
      messagePanelBox!.height -
      (dockedComposerBox!.y + dockedComposerBox!.height),
    ),
  ).toBeGreaterThanOrEqual(14)
  expect(
    Math.round(
      messagePanelBox!.y +
      messagePanelBox!.height -
      (dockedComposerBox!.y + dockedComposerBox!.height),
    ),
  ).toBeLessThanOrEqual(18)

  const userMessage = page.locator('.message.user').last()
  const assistantMessage = page.locator('.message.assistant').last()
  await expect(userMessage).toHaveCSS('border-top-left-radius', '18px')
  await expect(userMessage).not.toHaveCSS('border-top-width', '0px')
  await expect(assistantMessage).toHaveCSS('border-top-width', '0px')
  await expect(assistantMessage).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await page.screenshot({
    path: testInfo.outputPath('chat-interface.png'),
    fullPage: true,
  })

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reducedMotionDurations = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'skill-workspace-panel-enter-active'
    document.body.append(probe)
    const durations = getComputedStyle(probe)
      .transitionDuration.split(',')
      .map((value) => value.trim())
      .map((value) =>
        value.endsWith('ms')
          ? Number.parseFloat(value)
          : Number.parseFloat(value) * 1000,
      )
    probe.remove()
    return durations
  })
  expect(reducedMotionDurations.every((duration) => duration <= 0.02)).toBe(
    true,
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  const skillDevelopmentUrl = page.url()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(skillDevelopmentUrl)
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.locator('.explorer-pane')).toBeHidden()
  const [mobilePanelBox, mobileComposerBox] = await Promise.all([
    page.locator('.chat-panel').boundingBox(),
    page.locator('.composer-shell').boundingBox(),
  ])
  expect(mobilePanelBox).not.toBeNull()
  expect(mobileComposerBox).not.toBeNull()
  expect(mobileComposerBox!.width).toBeGreaterThanOrEqual(
    mobilePanelBox!.width - 28,
  )
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: testInfo.outputPath('chat-interface-mobile.png'),
    fullPage: true,
  })

  await page.getByRole('button', { name: '← 返回' }).click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.getByRole('heading', { name: '测试Skill' })).toBeVisible()
  await page.getByPlaceholder('搜索名称、ID 或描述').fill('不存在的 Skill')
  await expect(page.getByText('没有匹配的 Skill')).toBeVisible()
  await page.getByRole('button', { name: '清除搜索' }).click()
  await expect(page.getByRole('heading', { name: '测试Skill' })).toBeVisible()

  const serverOrigin = new URL(page.url()).origin
  const unknownApiResponse = await page.request.get(
    `${serverOrigin}/api/not-found`,
  )
  expect(unknownApiResponse.status()).toBe(404)
  expect((await unknownApiResponse.json()).code).toBe('API_NOT_FOUND')

  const directConfigResponse = await request.get(`${serverOrigin}/api/config`)
  expect(directConfigResponse.status()).toBe(200)

  const hostileOriginResponse = await page.request.get(
    `${serverOrigin}/api/config`,
    {
      headers: { Origin: 'https://attacker.example' },
    },
  )
  expect(hostileOriginResponse.status()).toBe(200)
})

function createFakeModelServer (): Server {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    modelRequests.push(Buffer.concat(chunks).toString('utf-8'))
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write(
      `data: ${JSON.stringify({ id: 'chunk-1', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'Hello from fake model' }, finish_reason: null }] })}\n\n`,
    )
    response.write(
      `data: ${JSON.stringify({ id: 'chunk-2', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
    )
    response.end('data: [DONE]\n\n')
  })
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

async function waitForRuntime (runtimePath: string): Promise<{
  serverUrl: string
}> {
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

/**
 * 终止 CLI 进程并等待其真正退出。
 *
 * 进程退出前会一直占用工作区内的 SQLite 会话文件，直接删除临时目录会失败。
 *
 * @returns 进程已退出（或被强制结束）后兑现的 Promise。
 * @throws 不抛出异常；等待超时后强制结束进程。
 */
async function stopCliProcess (): Promise<void> {
  const target = cliProcess
  if (!target || target.killed) return

  const exited = new Promise<void>((resolve) =>
    target.once('exit', () => resolve()),
  )
  target.kill('SIGTERM')

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
  ])

  if (timedOut && !target.killed) {
    target.kill('SIGKILL')
    await exited
  }
}

function closeServer (server: Server | null): Promise<void> {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

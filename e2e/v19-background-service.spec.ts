/**
 * v19 后台服务化端到端验收（PRD AC-01 / AC-03 / AC-04）。
 *
 * 覆盖 e2e 层可验证的部分：
 *   1. `e2e_assistant start --no-open` 快速返回且退出码 0，记录 mode 为 background、pid 存活；
 *   2. 服务地址可访问（前端仍挂载在同一地址）；
 *   3. `e2e_assistant log` 输出包含服务启动文案；
 *   4. `e2e_assistant stop` 后进程消失、记录被清理；
 *   5. 启动器所在会话结束后服务仍在（后台服务脱离终端的核心性质）。
 *
 * 每步都用 APPDATA/XDG_CONFIG_HOME 隔离配置目录（既有范式），端口选高位未占端口。
 */
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CLI_ENTRY = 'apps/cli/dist/index.js'
const SERVICE_PORT = '5971'

let tempRoot = ''
let configHome = ''
let serverUrl = ''
let servicePid = 0

/** 以 CLI 入口执行一条命令并收集输出。 */
async function runCli (
  argumentsList: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argumentsList], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        APPDATA: configHome,
        XDG_CONFIG_HOME: configHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('exit', (code) => resolve({ stdout, stderr, exitCode: code }))
  })
}

/** 读运行态记录；文件不存在或不可解析时返回 null。 */
async function readRuntime (): Promise<{
  pid?: number
  port?: number
  serverUrl?: string
  mode?: string
  shutdownToken?: string
} | null> {
  try {
    return JSON.parse(
      await readFile(path.join(configHome, 'e2e_assistant', 'runtime.json'), 'utf-8'),
    )
  } catch {
    return null
  }
}

test.beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-v19-e2e-'))
  configHome = path.join(tempRoot, 'config-home')
  await mkdir(configHome, { recursive: true })
})

test.afterAll(async () => {
  // 兜底清理：测试中途失败时也尽量不留后台服务。
  if (servicePid) {
    try {
      process.kill(servicePid, 'SIGKILL')
    } catch {
      // 已退出即忽略。
    }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

test('后台启动 → 访问 → 日志 → 优雅停止（AC-01 / AC-03 / AC-04）', async () => {
  // 1) 后台启动：命令自身快速返回且退出码 0（G1）。
  const startResult = await runCli([
    'start',
    '--no-open',
    '--port',
    SERVICE_PORT,
  ])
  expect(startResult.exitCode).toBe(0)
  expect(startResult.stdout).toContain('started in the background')
  expect(startResult.stdout).toContain('e2e_assistant stop')

  const runtime = await readRuntime()
  expect(runtime?.mode).toBe('background')
  expect(runtime?.pid).toBeGreaterThan(0)
  expect(typeof runtime?.shutdownToken).toBe('string')

  servicePid = Number(runtime?.pid)
  serverUrl = String(runtime?.serverUrl)

  // 记录中的 pid 指向仍在运行的进程。
  expect(() => process.kill(servicePid, 0)).not.toThrow()

  // 2) 服务地址可访问：工作台页面仍挂载在同一地址上。
  const pageResponse = await fetch(serverUrl)
  expect(pageResponse.status).toBe(200)
  expect(await pageResponse.text()).toContain('<div id="app">')

  // 健康探测确认身份，且响应者就是记录中的进程。
  const healthResponse = await fetch(`${serverUrl}/health`)
  expect(healthResponse.status).toBe(200)
  expect(await healthResponse.json()).toMatchObject({
    status: 'ok',
    pid: servicePid,
    version: 6,
  })

  // 3) 日志：能看到服务启动产生的行。
  const logResult = await runCli(['log', '-n', '50'])
  expect(logResult.exitCode).toBe(0)
  expect(logResult.stdout.length).toBeGreaterThan(0)

  // 4) 重复 start：复用而不派生第二个进程（场景 2）。
  const reuseResult = await runCli([
    'start',
    '--no-open',
    '--port',
    SERVICE_PORT,
  ])
  expect(reuseResult.exitCode).toBe(0)
  expect(reuseResult.stdout).toContain('already running')
  expect((await readRuntime())?.pid).toBe(servicePid)

  // 5) 优雅停止：进程消失、记录被清理、退出码 0（AC-04）。
  const stopResult = await runCli(['stop'])
  expect(stopResult.exitCode).toBe(0)
  expect(stopResult.stdout).toContain('已优雅停止')

  await expect
    .poll(() => isProcessAlive(servicePid), { timeout: 10_000 })
    .toBe(false)
  expect(await readRuntime()).toBeNull()
  servicePid = 0
})

test('关闭启动器所在会话后服务仍在（场景 7 / AC-01 第 3 条）', async () => {
  // 用一个中间进程拉起启动器：中间进程退出（模拟关掉终端）后，
  // 后台服务必须仍然可达——这是「起完就走」的核心性质。
  const launcherOutput = await runCliThroughIntermediateShell([
    'start',
    '--no-open',
    '--port',
    String(Number(SERVICE_PORT) + 1),
  ])

  const runtime = await readRuntime()
  expect(runtime?.mode).toBe('background')
  expect(launcherOutput).toContain('started in the background')

  const pid = Number(runtime?.pid)
  servicePid = pid

  // 启动器进程已退出（runCliThroughIntermediateShell 只在它退出后返回），
  // 但服务仍在监听。
  await expect
    .poll(() => isProcessAlive(pid), { timeout: 10_000 })
    .toBe(true)
  const healthResponse = await fetch(`${runtime?.serverUrl}/health`)
  expect(healthResponse.status).toBe(200)

  // 通过 log / stop 管理它：证明脱离终端后仍可管理。
  const logResult = await runCli(['log', '-n', '10'])
  expect(logResult.exitCode).toBe(0)

  const stopResult = await runCli(['stop'])
  expect(stopResult.exitCode).toBe(0)
  await expect
    .poll(() => isProcessAlive(pid), { timeout: 10_000 })
    .toBe(false)
  servicePid = 0
})

/**
 * 用中间进程拉起启动器并等中间进程退出，模拟「关掉终端」。
 *
 * 与 runCli 的区别：这里显式声明中间进程，返回时保证它已退出——
 * 服务若绑定在启动器进程上就会一并消失，测试据此区分真后台与假后台。
 */
async function runCliThroughIntermediateShell (
  argumentsList: string[],
): Promise<string> {
  const intermediate = spawn(
    process.execPath,
    ['-e', buildIntermediateScript(argumentsList)],
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
  let stdout = ''
  intermediate.stdout.on('data', (chunk) => (stdout += String(chunk)))
  // 中间进程必须真正退出后才继续（否则测的就不是「终端已关」）。
  await new Promise<void>((resolve) => intermediate.once('exit', () => resolve()))

  return stdout
}

/**
 * 构造中间进程脚本：同步执行 CLI 并把输出转发到自己的 stdout。
 *
 * @param argumentsList - CLI 参数。
 * @returns 可供 `node -e` 执行的脚本文本。
 */
function buildIntermediateScript (argumentsList: string[]): string {
  const serializedArguments = JSON.stringify(argumentsList)

  return [
    "const { spawnSync } = require('node:child_process')",
    `const result = spawnSync(process.execPath, [${JSON.stringify(CLI_ENTRY)}, ...${serializedArguments}], {`,
    '  cwd: process.cwd(),',
    '  env: process.env,',
    '  encoding: "utf-8",',
    '})',
    'process.stdout.write(result.stdout ?? "")',
    'process.stderr.write(result.stderr ?? "")',
  ].join('\n')
}

function isProcessAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

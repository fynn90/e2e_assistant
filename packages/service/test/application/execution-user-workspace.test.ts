/**
 * 执行链路的 userWorkSpace 集成测试（v14，技术方案 §7.3 / 12.4-2/3/4）。
 *
 * 用 fake testRunner 与 fake chromium 走通 `createTestExecutionService().start()`
 * 的真实编排路径，固化三条 PRD 验收点（此前仅靠代码审查、无测试）：
 *   - W11：userWorkSpace 不可用时执行 precheck 明确失败（EXECUTION_PRECHECK_FAILED）；
 *   - B11/W38：run 请求的 snapshotRoot 与 userWorkspacePath 都指向 <skillRoot>/userWorkSpace；
 *   - W18/W19：执行结束后 userWorkSpace 根目录与既有产物零改动（平台不自动清理）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createSkill,
  E2E_SCHEMA_FILE_NAME,
  USER_WORKSPACE_DIRECTORY_NAME,
} from '@fynn90-e2e_assistant/skill-manager'
import type {
  IChromiumInstaller,
  IChromiumStatus,
  ITestRunRequest,
  ITestRunner,
  ITestRunResult,
} from '@fynn90-e2e_assistant/playwright-engine'
import { createTestExecutionService } from '../../src/application/test-execution/execution-service'
import { createGenerationTaskRegistry } from '../../src/generation-runtime'

let rootDir = ''

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'authine-exec-uw-'))
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

/** 已安装状态的 fake Chromium 检测器（跳过真实安装，J7 直接就绪）。 */
const fakeChromium: IChromiumInstaller = {
  async detect (): Promise<IChromiumStatus> {
    return { installed: true, executablePath: '/fake/chromium' }
  },
  async install (): Promise<IChromiumStatus> {
    return { installed: true, executablePath: '/fake/chromium' }
  },
}

/**
 * 构造一个含 test() 的最小脚本，通过 J2「至少一条测试」校验。
 * 不引用 process.env，避免触发 J4 的 env 声明校验。
 */
const MINIMAL_SPEC = `
import { test, expect } from '@playwright/test'
test('占位用例', async ({ page }) => {
  await test.step('step_1', async () => {
    await expect(page).toHaveTitle(/x/)
  })
})
`

/**
 * 创建可执行 Skill 夹具：Skill + test.spec.ts + 合法 baseUrl + userWorkSpace 预置产物。
 *
 * @param workspaceSeed - 预先写入 userWorkSpace 的相对路径与内容（用于零改动断言）。
 * @returns skillId、skillRoot 与捕获 run 请求的 fake runner。
 */
async function createExecutableSkill (
  workspaceSeed: Array<{ relativePath: string; content: string }> = [],
): Promise<{
  skillId: string
  skillRoot: string
  capturedRequests: ITestRunRequest[]
}> {
  const { skillManifest, skillDirectoryPath } = await createSkill({
    rootDir,
    title: '执行链路夹具',
    description: 'v14 userWorkSpace 集成测试。',
  })
  const skillId = skillManifest.id
  const skillRoot = skillDirectoryPath

  // 脚本与目标 URL 是 J1/J2/J5 的输入；直接落盘最省夹具。
  await writeFile(path.join(skillRoot, 'test.spec.ts'), MINIMAL_SPEC, 'utf-8')
  const schemaPath = path.join(skillRoot, E2E_SCHEMA_FILE_NAME)
  const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as {
    baseUrl: string
  }
  schema.baseUrl = 'http://127.0.0.1:1/'
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8')

  // 预置 userWorkSpace 产物：执行后必须逐字不变（W18/W19）。
  for (const seed of workspaceSeed) {
    const absolute = path.join(
      skillRoot,
      USER_WORKSPACE_DIRECTORY_NAME,
      seed.relativePath,
    )
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, seed.content, 'utf-8')
  }

  const capturedRequests: ITestRunRequest[] = []
  const fakeRunner: ITestRunner = {
    async run (request: ITestRunRequest): Promise<ITestRunResult> {
      capturedRequests.push(request)
      return {
        status: 'passed',
        durationMs: 5,
        exitCode: 0,
        // 空报告：parseTestReportData 对缺省 suites 安全降级为 0 条。
        jsonReport: { stats: { duration: 5 } },
        workspace: {
          path: path.join(os.tmpdir(), 'fake-run-workspace'),
          async cleanup () {
            // fake 工作区不触盘；真实清理只针对运行工作区，绝不碰 userWorkSpace。
          },
        },
      }
    },
  }

  return { skillId, skillRoot, capturedRequests }
}

/**
 * 创建注入了 fake 依赖的执行服务。
 * @param runner - fake testRunner。
 * @returns 执行服务实例。
 */
function createService (runner: ITestRunner) {
  return createTestExecutionService({
    taskRegistry: createGenerationTaskRegistry(),
    chromium: fakeChromium,
    testRunner: runner,
  })
}

/**
 * 轮询等待执行进入终态（driveExecution 是 start 之后的异步流程）。
 * @param service - 执行服务。
 * @param executionId - 执行 ID。
 * @returns 终态状态。
 */
async function waitForTerminal (
  service: ReturnType<typeof createService>,
  executionId: string,
) {
  await vi.waitFor(
    () => {
      const status = service.snapshot(executionId)?.status
      expect(['completed', 'failed', 'interrupted']).toContain(status)
    },
    { timeout: 5000, interval: 30 },
  )
  return service.snapshot(executionId)?.status
}

describe('执行链路 userWorkSpace precheck（W11）', () => {
  it('userWorkSpace 被同名文件占用时执行明确失败', async () => {
    const { skillManifest } = await createSkill({
      rootDir,
      title: '占用夹具',
      description: 'userWorkSpace 被占用。',
    })
    const skillId = skillManifest.id
    // 把 userWorkSpace 目录替换为同名普通文件 → strict 补建判定 OCCUPIED。
    const directoryName = (await readdir(rootDir)).find((name) =>
      name.endsWith(skillId),
    )
    const skillRoot = path.join(rootDir, directoryName!)
    await rm(path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME), {
      recursive: true,
      force: true,
    })
    await writeFile(
      path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME),
      'occupied',
      'utf-8',
    )

    const runner: ITestRunner = { run: vi.fn() }
    const service = createService(runner)
    const result = await service.start({ rootDir, skillId })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues[0]).toMatchObject({
        code: 'EXECUTION_PRECHECK_FAILED',
      })
      expect(result.issues[0].message).toContain('userWorkSpace 不可用')
    }
    // precheck 阶段即拦截，绝不进入引擎执行。
    expect(runner.run).not.toHaveBeenCalled()
  })
})

describe('执行链路 userWorkSpace 注入（B11/W38）', () => {
  it('run 请求的 snapshotRoot 与 userWorkspacePath 均指向 <skillRoot>/userWorkSpace', async () => {
    const { skillId, skillRoot, capturedRequests } =
      await createExecutableSkill()
    const runner: ITestRunner = {
      run: vi.fn(async (request: ITestRunRequest): Promise<ITestRunResult> => {
        capturedRequests.push(request)
        return {
          status: 'passed',
          durationMs: 5,
          exitCode: 0,
          jsonReport: { stats: { duration: 5 } },
          workspace: { path: skillRoot, async cleanup () { } },
        }
      }),
    }
    const service = createService(runner)

    const start = await service.start({ rootDir, skillId })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    await waitForTerminal(service, start.executionId)

    const expected = path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME)
    expect(capturedRequests).toHaveLength(1)
    // B11：视觉快照根 = userWorkSpace（snapshotPathTemplate 据此生成）。
    expect(capturedRequests[0].snapshotRoot).toBe(expected)
    // W38：注入子进程 SKILL_USER_WORKSPACE 的绝对路径根。
    expect(capturedRequests[0].userWorkspacePath).toBe(expected)
  })
})

describe('执行链路 userWorkSpace 零改动（W18/W19）', () => {
  it('执行成功后 userWorkSpace 根目录与既有产物逐字保留', async () => {
    const seed = [
      { relativePath: 'baselines/keep.png', content: 'BASELINE_BYTES' },
    ]
    const { skillId, skillRoot, capturedRequests } =
      await createExecutableSkill(seed)
    const service = createService({
      run: async (request) => {
        capturedRequests.push(request)
        return {
          status: 'passed',
          durationMs: 5,
          exitCode: 0,
          jsonReport: { stats: { duration: 5 } },
          workspace: { path: skillRoot, async cleanup () { } },
        }
      },
    })

    const start = await service.start({ rootDir, skillId })
    expect(start.ok).toBe(true)
    if (!start.ok) return
    const status = await waitForTerminal(service, start.executionId)
    expect(status).toBe('completed')

    // 根目录仍在（W18：清理/成功均不得删除根目录）。
    const workspaceRoot = path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME)
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true)
    // 既有产物内容逐字不变（W19：不自动清空）。
    const kept = await readFile(
      path.join(workspaceRoot, 'baselines/keep.png'),
      'utf-8',
    )
    expect(kept).toBe('BASELINE_BYTES')
  })
})

/**
 * 执行服务关闭协作测试（v19 §4.2 第 1 步 / AC-04）。
 *
 * `abortAllAndWait` 是服务关闭序列的第一步：中止在跑任务，等待它们按 v11 的
 * 「已中断」语义收敛（尽力生成报告），但等待有上限——关闭不能被卡住的任务拖死。
 *
 * 沿用执行链路的既有夹具手法（真实 Skill 目录 + fake runner / chromium），
 * 走通真实编排路径而非替身。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createSkill,
  E2E_SCHEMA_FILE_NAME,
} from '@authine-e2e-agent/skill-manager'
import type {
  IChromiumInstaller,
  IChromiumStatus,
  ITestRunner,
  ITestRunResult,
} from '@authine-e2e-agent/playwright-engine'
import { createTestExecutionService } from '../../src/application/test-execution/execution-service'
import { createGenerationTaskRegistry } from '../../src/generation-runtime'

let rootDir = ''

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'authine-exec-abort-'))
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

/** 已安装状态的 fake Chromium 检测器（跳过真实安装，J7 直接就绪）。 */
const fakeChromium: IChromiumInstaller = {
  async detect(): Promise<IChromiumStatus> {
    return { installed: true, executablePath: '/fake/chromium' }
  },
  async install(): Promise<IChromiumStatus> {
    return { installed: true, executablePath: '/fake/chromium' }
  },
}

/** 通过 J2「至少一条测试」且不引用 process.env 的最小脚本。 */
const MINIMAL_SPEC = `
import { test, expect } from '@playwright/test'
test('占位用例', async ({ page }) => {
  await expect(page).toHaveTitle(/x/)
})
`

/**
 * 创建可执行 Skill 夹具（脚本 + 合法 baseUrl）。
 *
 * @returns skillId。
 */
async function createExecutableSkill(): Promise<string> {
  const { skillManifest, skillDirectoryPath } = await createSkill({
    rootDir,
    title: '中止链路夹具',
    description: 'v19 abortAllAndWait 测试。',
  })

  await writeFile(
    path.join(skillDirectoryPath, 'test.spec.ts'),
    MINIMAL_SPEC,
    'utf-8',
  )
  const schemaPath = path.join(skillDirectoryPath, E2E_SCHEMA_FILE_NAME)
  const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as {
    baseUrl: string
  }
  schema.baseUrl = 'http://127.0.0.1:1/'
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8')

  return skillManifest.id
}

/**
 * 构造以「永不结束」方式运行的 runner，并把传入的取消信号暴露给测试。
 *
 * @param onSignal - 每次 run 被调用时收到该次执行的取消信号。
 * @returns fake 执行器。
 */
function createHangingRunner(
  onSignal: (signal: AbortSignal | undefined) => void,
): ITestRunner {
  return {
    async run(request): Promise<ITestRunResult> {
      onSignal(request.signal)
      // 永不兑现也不理会 signal：模拟卡死的 playwright 子进程。
      return await new Promise<never>(() => {})
    },
  }
}

describe('abortAllAndWait', () => {
  it('无在跑任务时立即返回', async () => {
    const service = createTestExecutionService({
      taskRegistry: createGenerationTaskRegistry(),
      chromium: fakeChromium,
      testRunner: createHangingRunner(() => {
        throw new Error('本用例不应发起执行。')
      }),
    })
    const startedAt = Date.now()

    await service.abortAllAndWait({ waitMs: 5000 })

    // 无任务时不等待整个 waitMs：关闭速度不能被未发生的收敛拖慢。
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('中止在跑任务，并在其收敛后立即返回（不必等满 waitMs）', async () => {
    const skillId = await createExecutableSkill()
    let abortSignal: AbortSignal | undefined
    const service = createTestExecutionService({
      taskRegistry: createGenerationTaskRegistry(),
      chromium: fakeChromium,
      // 收到中止信号才结束，模拟引擎的正常中断路径。
      testRunner: {
        async run(request): Promise<ITestRunResult> {
          abortSignal = request.signal
          return await new Promise<never>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () =>
              reject(new Error('execution interrupted')),
            )
          })
        },
      },
    })

    const started = await service.start({ rootDir, skillId })
    expect(started.ok).toBe(true)

    const startedAt = Date.now()
    await service.abortAllAndWait({ waitMs: 5000 })

    expect(abortSignal?.aborted).toBe(true)
    // 收敛后立即返回：实际耗时远小于 waitMs 上限。
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })

  it('任务不理会中止时按 waitMs 超时返回，不阻塞关闭', async () => {
    const skillId = await createExecutableSkill()
    const service = createTestExecutionService({
      taskRegistry: createGenerationTaskRegistry(),
      chromium: fakeChromium,
      testRunner: createHangingRunner(() => undefined),
    })

    const started = await service.start({ rootDir, skillId })
    expect(started.ok).toBe(true)

    const startedAt = Date.now()
    await service.abortAllAndWait({ waitMs: 300 })
    const elapsed = Date.now() - startedAt

    expect(elapsed).toBeGreaterThanOrEqual(250)
    expect(elapsed).toBeLessThan(3000)
  })
})

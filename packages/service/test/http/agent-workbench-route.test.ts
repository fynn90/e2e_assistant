/**
 * `/api/agent/sessions/:sessionId/actions/:actionId` 的路由级测试（v16）。
 *
 * 路由只负责 HTTP 语义，因此这里只锁三件事：端点确实挂在预期路径上、
 * 业务参数（覆盖确认）被透传给服务、**业务拒绝走 200 信封而非 HTTP 错误**
 * ——`{ ok: false, message }` 是「操作没做成」的业务结果，前端要把它当提示
 * 展示而不是当请求失败重试。
 *
 * 业务判定本身（互斥、缺口、覆盖确认、就绪校验）在
 * `test/application/workbench-service.test.ts` 覆盖，不在本文件重复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentWorkRuntimeRegistry } from '../../src/agent-runtime'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'
import type { IAgentWorkbenchService } from '../../src/application/agent-workbench/workbench-service'

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-workbench-route-'))
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config-home')
  process.env.APPDATA = path.join(tempRoot, 'app-data')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  // Windows 上 sqlite 的 -shm/-wal 句柄可能延迟释放，清理失败不视为测试失败
  // （临时目录随后由系统回收）。
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
})

/** 写入平台配置，让 requirePlatformConfig 能读到工作区与模型设置。 */
async function initializePlatformConfig (): Promise<void> {
  const projectDirectory = path.join(tempRoot, 'workspace')
  const configDirectory = path.join(tempRoot, 'app-data', 'e2e_assistant')
  await mkdir(projectDirectory, { recursive: true })
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    path.join(configDirectory, 'config.json'),
    JSON.stringify({
      projectDirectory,
      llmApiKey: 'fake-key',
      llmApiBaseUrl: 'https://llm.example.test/v1',
      llmModelName: 'fake-model',
    }),
    'utf8',
  )
}

/** 构造一个记录调用参数、固定返回给定业务结果的工作台服务替身。 */
function createWorkbenchStub (result: { ok: boolean; message: string }): {
  service: IAgentWorkbenchService
  runAction: ReturnType<typeof vi.fn>
} {
  const runAction = vi.fn(async () => result)
  const service = {
    createCatalogHost: () => ({}) as never,
    createTestRunnerHost: () => ({}) as never,
    createActionHost: () => ({}) as never,
    runAction,
  } as unknown as IAgentWorkbenchService
  return { service, runAction }
}

/** 创建带工作台服务替身的应用（其余依赖用最小替身）。 */
function createApp (service: IAgentWorkbenchService) {
  return createHttpApp({
    chatRuntimeFactory () {
      throw new Error('Chat runtime should not run.')
    },
    chatConcurrencyGate: new ChatConcurrencyGate(),
    workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
    logger: { request () { }, error () { } },
    workbenchService: service,
  })
}

describe('动作卡片端点', () => {
  it('业务拒绝以 200 + { ok: false } 返回（不是 HTTP 错误）', async () => {
    await initializePlatformConfig()
    const { service, runAction } = createWorkbenchStub({
      ok: false,
      message: '当前用例已有生成或执行任务正在运行，请等待其结束。',
    })
    const app = createApp(service)

    const response = await app.request(
      '/api/agent/sessions/session-1/actions/action-1',
      { method: 'POST', body: JSON.stringify({ confirmOverwrite: true }) },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      success: boolean
      data: { ok: boolean; message: string }
    }
    expect(body.success).toBe(true)
    expect(body.data.ok).toBe(false)
    expect(body.data.message).toContain('已有生成或执行任务')
    // 覆盖确认（GEN-10）与路径参数被透传给服务。
    expect(runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        actionId: 'action-1',
        confirmOverwrite: true,
      }),
    )
  })

  it('受理成功时返回 ok: true 与说明', async () => {
    await initializePlatformConfig()
    const { service, runAction } = createWorkbenchStub({
      ok: true,
      message: '已发起执行。',
    })
    const app = createApp(service)

    const response = await app.request(
      '/api/agent/sessions/session-9/actions/action-9',
      { method: 'POST', body: JSON.stringify({}) },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { ok: boolean; message: string }
    }
    expect(body.data).toEqual({ ok: true, message: '已发起执行。' })
    // 未提供 confirmOverwrite 时不应臆造该字段。
    expect(runAction).toHaveBeenCalledWith(
      expect.not.objectContaining({ confirmOverwrite: expect.anything() }),
    )
  })
})

/**
 * v17 新增端点的路由级测试。
 *
 * 与上一组同口径：只锁「端点挂在预期路径」「参数被透传」
 * 「业务拒绝走 200 信封而非 HTTP 错误」。业务判定本身在各自的
 * 服务测试里覆盖，不在这里重复。
 */
describe('提案端点（v17）', () => {
  /** 建一个记录调用的提案服务替身。 */
  function createProposalStub () {
    const apply = vi.fn(async () => ({ ok: true, message: '已应用' }))
    const cancel = vi.fn(async () => ({ ok: true }))
    return {
      service: { apply, cancel } as never,
      apply,
      cancel,
    }
  }

  it('apply 把 envValues 原样透传（值不落事件、只进这一条请求）', async () => {
    await initializePlatformConfig()
    const stub = createProposalStub()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
      proposalService: stub.service,
    })

    const response = await app.request(
      '/api/agent/sessions/s1/proposals/p1/apply',
      {
        method: 'POST',
        body: JSON.stringify({ envValues: { E2E_PASSWORD: 'secret' } }),
      },
    )

    expect(response.status).toBe(200)
    expect(stub.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        proposalId: 'p1',
        envValues: { E2E_PASSWORD: 'secret' },
      }),
    )
  })

  it('apply 不带 envValues 时不臆造该字段', async () => {
    await initializePlatformConfig()
    const stub = createProposalStub()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
      proposalService: stub.service,
    })

    await app.request('/api/agent/sessions/s1/proposals/p1/apply', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    expect(stub.apply).toHaveBeenCalledWith(
      expect.not.objectContaining({ envValues: expect.anything() }),
    )
  })

  it('cancel 不触发 apply（取消与确认是两条独立路径）', async () => {
    await initializePlatformConfig()
    const stub = createProposalStub()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
      proposalService: stub.service,
    })

    await app.request('/api/agent/sessions/s1/proposals/p1/cancel', {
      method: 'POST',
      body: JSON.stringify({}),
    })

    expect(stub.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', proposalId: 'p1' }),
    )
    expect(stub.apply).not.toHaveBeenCalled()
  })

})

describe('连续执行端点（v17）', () => {
  it('confirm / cancel / stop 分别落到对应方法', async () => {
    await initializePlatformConfig()
    const confirm = vi.fn(async () => ({ ok: true }))
    const cancel = vi.fn(() => ({ ok: true }))
    const stop = vi.fn(() => ({ ok: true }))
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
      batchService: { confirm, cancel, stop } as never,
    })

    for (const action of ['confirm', 'cancel', 'stop'] as const) {
      const response = await app.request(
        `/api/agent/sessions/s1/batches/b1/${action}`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      expect(response.status).toBe(200)
    }

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    // 三个端点都拿到正确的路径参数。
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', batchId: 'b1' }),
    )
  })
})

describe('建议问题端点（v17 H1）', () => {
  it('把服务返回的建议原样下发', async () => {
    await initializePlatformConfig()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
      suggestionService: {
        suggest: async () => ['看看最近失败的用例', '你能做什么？'],
      } as never,
    })

    const response = await app.request('/api/agent/suggestions')
    const body = (await response.json()) as {
      data: { suggestions: string[] }
    }
    expect(body.data.suggestions).toEqual(['看看最近失败的用例', '你能做什么？'])
  })

  it('未注入服务时用默认实现：空工作区退回通用示例（不报错）', async () => {
    await initializePlatformConfig()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('should not run')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: createAgentWorkRuntimeRegistry(),
      logger: { request () { }, error () { } },
    })

    const response = await app.request('/api/agent/suggestions')

    // 空态建议绝不能让页面变成错误页（H1 末句）——即便工作区为空/不可读，
    // 也要给出一组可用的通用示例。
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { suggestions: string[] }
    }
    expect(body.data.suggestions.length).toBeGreaterThanOrEqual(2)
    expect(body.data.suggestions).toContain('你能做什么？')
  })
})

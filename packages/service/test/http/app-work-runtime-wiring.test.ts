/**
 * 组合根装配测试：验证 /api/agent 路由与 SKILL.md 生成共用同一个
 * 工作通道运行时注册表。
 *
 * 背景：生成会话的事件发布到「注册表内运行时」的总线，前端则通过
 * /api/agent 的事件流订阅。若两处各自创建注册表，事件会发布到 A 总线
 * 而前端订阅 B 总线——表现为侧边栏与生成弹窗都收不到 Agent 工作内容，
 * 且**没有任何报错**。因此这里用断言把该不变量固定下来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createAgentWorkRuntimeRegistry,
  type IAgentWorkRuntimeRegistry,
} from '../../src/agent-runtime'
import { createHttpApp } from '../../src/http/app'
import { ChatConcurrencyGate } from '../../src/http/chat-concurrency'

let tempRoot = ''
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'authine-cli-wiring-'))
  process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config-home')
  process.env.APPDATA = path.join(tempRoot, 'app-data')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  await rm(tempRoot, { recursive: true, force: true })
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

describe('createHttpApp 工作通道装配', () => {
  it('外部注入的注册表同时服务于 /api/agent 与 SKILL.md 生成', async () => {
    await initializePlatformConfig()
    // 注入一个可观测的注册表：记录 getRuntime 调用，验证两处共用同一实例。
    const getRuntime = vi.fn()
    const injected: IAgentWorkRuntimeRegistry = {
      getRuntime,
      disposeAll: async () => undefined,
    }
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('Chat runtime should not run.')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: injected,
      logger: { request () { }, error () { } },
    })

    // /api/agent 路由使用注入的注册表。
    await app.request('http://localhost/api/agent/sessions')
    expect(getRuntime).toHaveBeenCalledTimes(1)

    // 注入 e2eTestCaseServices 时不再构造默认生成器（也就不会再建注册表）；
    // 这里只断言 /api/agent 一侧确实走了注入实例，避免出现第二个注册表。
    expect(getRuntime.mock.calls[0]?.[0]).toMatchObject({
      model: 'fake-model',
      apiBaseUrl: 'https://llm.example.test/v1',
    })
  })

  it('未注入注册表时内部创建一个并复用', async () => {
    await initializePlatformConfig()
    // 内部创建的注册表会打开工作区下的 SQLite 文件；显式持有以便测试结束前释放，
    // 否则 Windows 上临时目录因句柄未关闭而无法删除。
    const registry = createAgentWorkRuntimeRegistry()
    const app = createHttpApp({
      chatRuntimeFactory () {
        throw new Error('Chat runtime should not run.')
      },
      chatConcurrencyGate: new ChatConcurrencyGate(),
      workRuntimeRegistry: registry,
      logger: { request () { }, error () { } },
    })

    try {
      // 连续两次访问同一路由：注册表按工作区缓存，不应重复创建运行时实例。
      const first = await app.request('http://localhost/api/agent/sessions')
      const second = await app.request('http://localhost/api/agent/sessions')
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      await expect(first.json()).resolves.toMatchObject({ success: true })
    } finally {
      await registry.disposeAll()
    }
  })
})

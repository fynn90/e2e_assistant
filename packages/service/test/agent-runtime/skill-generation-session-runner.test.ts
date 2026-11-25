/**
 * 生成会话运行器（infra 适配器）的单元测试。
 *
 * 适配器是「应用层端口」与「agent-work 运行时」之间的桥：
 * 本用例用可控的 fake 运行时替换真实运行时，聚焦适配器自身的契约——
 * 会话种类、标题、守卫的透传，取消传播，以及无论成败都释放会话。
 */
import { describe, expect, it, vi } from 'vitest'
import type { IAgentTaskHandle } from '@authine-e2e-agent/agent'
import type { IToolGuard } from '@authine-e2e-agent/agent'
import type { TAgentSessionKind } from '@authine-e2e-agent/types'
import {
  createSkillGenerationSessionRunner,
  type IAgentWorkRuntime,
  type IAgentWorkRuntimeRegistry,
} from '../../src/agent-runtime'

/** 一次 sendMessage 调用的记录（便于断言适配器透传了什么）。 */
interface ISentMessage {
  sessionId?: string
  message: string
  kind?: TAgentSessionKind
  title?: string
  plugins?: { toolGuard?: IToolGuard }
}

/**
 * 构造可控的 fake 运行时。
 *
 * @param options.resultError - 让本轮以该错误结束（模拟模型失败）。
 * @param options.hang - 让本轮永不结束（模拟长任务，用于取消场景）。
 * @returns fake 运行时与调用记录。
 */
function createFakeRuntime(
  options: { resultError?: string; hang?: boolean } = {},
): {
  runtime: IAgentWorkRuntime
  sent: ISentMessage[]
  aborted: string[]
  released: string[]
} {
  const sent: ISentMessage[] = []
  const aborted: string[] = []
  const released: string[] = []

  const runtime = {
    bus: {} as IAgentWorkRuntime['bus'],
    sendMessage(input: ISentMessage) {
      sent.push(input)
      const result = options.hang
        ? new Promise<never>(() => undefined)
        : Promise.resolve(
            options.resultError ? { errorMessage: options.resultError } : {},
          )
      return {
        sessionId: input.sessionId ?? 'generated',
        handle: { result } as unknown as IAgentTaskHandle,
      }
    },
    abort(sessionId: string) {
      aborted.push(sessionId)
      return true
    },
    answerInteraction: () => false,
    async releaseSession(sessionId: string) {
      released.push(sessionId)
    },
    listSessions: () => [],
    listBlocks: () => [],
    async dispose() {},
  } as unknown as IAgentWorkRuntime

  return { runtime, sent, aborted, released }
}

/** 构造只返回指定运行时的注册表替身。 */
function createRegistryStub(
  runtime: IAgentWorkRuntime,
): IAgentWorkRuntimeRegistry {
  return {
    getRuntime: () => runtime,
    async disposeAll() {},
  }
}

/** 生成会话的固定输入。 */
const runInput = {
  sessionId: 'generation-1',
  prompt: '请先调用 load_skill…',
  title: '生成 SKILL.md',
  toolGuard: { id: 'guard' } as IToolGuard,
}

describe('生成会话运行器', () => {
  it('以 generation 种类发送会话，并透传标题、prompt 与工具守卫', async () => {
    const { runtime, sent } = createFakeRuntime()
    const runner = createSkillGenerationSessionRunner(
      createRegistryStub(runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )

    const result = await runner.run(runInput, {
      signal: new AbortController().signal,
    })

    expect(result).toEqual({})
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      sessionId: 'generation-1',
      message: '请先调用 load_skill…',
      kind: 'generation',
      title: '生成 SKILL.md',
    })
    expect(sent[0]?.plugins?.toolGuard).toBe(runInput.toolGuard)
  })

  it('模型侧返回错误时透出错误信息', async () => {
    const { runtime } = createFakeRuntime({ resultError: '模型拒绝服务' })
    const runner = createSkillGenerationSessionRunner(
      createRegistryStub(runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )

    await expect(
      runner.run(runInput, { signal: new AbortController().signal }),
    ).resolves.toEqual({ errorMessage: '模型拒绝服务' })
  })

  it('无论成败都释放会话，避免任务句柄与内存状态滞留', async () => {
    const ok = createFakeRuntime()
    const okRunner = createSkillGenerationSessionRunner(
      createRegistryStub(ok.runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )
    await okRunner.run(runInput, { signal: new AbortController().signal })
    expect(ok.released).toEqual(['generation-1'])

    const failing = createFakeRuntime({ resultError: '失败' })
    const failingRunner = createSkillGenerationSessionRunner(
      createRegistryStub(failing.runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )
    await failingRunner.run(runInput, { signal: new AbortController().signal })
    expect(failing.released).toEqual(['generation-1'])
  })

  it('取消信号触发运行时中止，并以 GENERATION_CANCELLED 结束', async () => {
    const { runtime, aborted } = createFakeRuntime({ hang: true })
    const runner = createSkillGenerationSessionRunner(
      createRegistryStub(runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )
    const controller = new AbortController()

    const pending = runner.run(runInput, { signal: controller.signal })
    // 等适配器完成订阅后触发取消。
    await vi.waitFor(() => expect(aborted).toHaveLength(0))
    controller.abort()

    await expect(pending).rejects.toMatchObject({
      code: 'GENERATION_CANCELLED',
    })
  })

  it('取消后不再残留中止监听', async () => {
    const { runtime } = createFakeRuntime()
    const runner = createSkillGenerationSessionRunner(
      createRegistryStub(runtime),
      {
        workspace: '/workspace',
        model: 'm',
        apiBaseUrl: 'https://example.test/v1',
        apiKey: 'k',
      },
    )
    const controller = new AbortController()
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

    await runner.run(runInput, { signal: controller.signal })
    // 正常结束时同样移除监听，避免信号对象长期持有闭包。
    controller.abort()

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

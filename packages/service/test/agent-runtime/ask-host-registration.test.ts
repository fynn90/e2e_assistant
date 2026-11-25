/**
 * 工作运行时对 AskUserQuestion 宿主的注册/注销契约测试。
 *
 * 提问能力对所有跑在工作运行时上的会话开放（普通 Chat / SKILL.md 生成 /
 * Playwright 生成），注册点因此在 `sendMessage`、注销点在 `releaseSession`，
 * 而不是各条生成路由。本文件锁定三条不变量：
 *   1. **时序**：注册必须发生在 `agentService.chat` 之前——Agent 的工具列表在
 *      会话创建时装配，配置工厂按 sessionId 查注册表，晚了工具就缺席；
 *   2. 续轮与重复注册不产生副作用（覆盖同一 sessionId 即可）；
 *   3. `releaseSession` 与 `dispose` 都注销干净，避免注册表残留指向已释放的宿主。
 *
 * 只替换 AgentService（避免真实模型配置与 SQLite 上下文库）；事件总线、工作块
 * 存储、交互注册表与 ask host 全部用真实实现——本测试要验证的正是真实注册表的
 * 状态变化。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * hoisted 观测点：mock 工厂在模块求值期就要用到，故用 vi.hoisted 提前建立。
 *
 * observations 在 chat 被调用时追加一条，记录「调用瞬间该 sessionId 是否已登记
 * 宿主」——这就是时序不变量的断言依据。
 */
const harness = vi.hoisted(() => ({
  observations: [] as Array<{
    sessionId: string | undefined
    hostRegisteredAtCallTime: boolean
  }>,
  /**
   * 每次 chat 调用的操作类型与装配情况（v16）。
   *
   * 用于锁定「工作台会话的续轮必须仍是 workbench 类型」：装配只在会话首建生效，
   * 若运行时不在会话上记住它，后续轮次（用户续轮、平台注入的解读轮次）会被
   * 当成普通 chat，而 `getOrCreate` 会因类型不一致直接抛错。
   */
  chatCalls: [] as Array<{
    sessionId: string | undefined
    operateType: string | undefined
    hasWorkbench: boolean
  }>,
  /** 由测试注入：查询注册表的实现（不能直接 import，避免 hoist 期循环）。 */
  lookupHost: undefined as ((sessionId: string) => unknown) | undefined,
  /** 置为 true 时让 chat 抛错，用于验证「宿主已登记但事件桥接未挂」的清理。 */
  chatThrows: false,
}))

vi.mock('@charlie_deng/e2e-assistant-agent', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@charlie_deng/e2e-assistant-agent')>()

  /** AgentService 的最小替身：只实现工作运行时用到的四个成员。 */
  class FakeAgentService {
    chat (
      _message: string,
      options: {
        sessionId?: string
        operateType?: string
        workbench?: unknown
      },
    ) {
      void _message
      const sessionId = options.sessionId
      harness.chatCalls.push({
        sessionId,
        operateType: options.operateType,
        hasWorkbench: options.workbench !== undefined,
      })
      harness.observations.push({
        sessionId,
        // 关键断言点：配置工厂正是在 chat 内部按 sessionId 查注册表装配工具的。
        hostRegisteredAtCallTime:
          sessionId !== undefined &&
          harness.lookupHost !== undefined &&
          harness.lookupHost(sessionId) !== undefined,
      })

      if (harness.chatThrows) {
        throw new Error('模型配置不可用')
      }

      return {
        loop: { subscribe: () => () => undefined },
        result: Promise.resolve({ messages: [] }),
        abort: () => undefined,
      }
    }

    getTask () {
      return undefined
    }

    async removeTask () {
      /* 无任务可移除 */
    }

    async dispose () {
      /* 无资源可释放 */
    }
  }

  return { ...actual, AgentService: FakeAgentService }
})

// mock 之后再 import：此时 runtime 模块拿到的 AgentService 已是替身，
// 而 askUserRegistry 仍是真实单例（上面用 ...actual 保留了原导出）。
const { askUserRegistry } = await import('@charlie_deng/e2e-assistant-agent')
const { createAgentWorkRuntime } =
  await import('../../src/agent-runtime/agent-work-runtime')

/** 每个用例一个独立临时工作区，避免 SQLite 文件互相干扰。 */
let workspace = ''
let runtime: ReturnType<typeof createAgentWorkRuntime> | undefined

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'authine-ask-host-'))
  harness.observations = []
  harness.chatCalls = []
  harness.chatThrows = false
  harness.lookupHost = (sessionId) => askUserRegistry.get(sessionId)
})

afterEach(async () => {
  // 必须先释放运行时再删目录：WorkBlockStore 的 SQLite 句柄未关闭时，
  // Windows 上临时目录会因 EBUSY 删不掉。
  await runtime?.dispose()
  runtime = undefined
  harness.lookupHost = undefined
  harness.chatThrows = false
  vi.clearAllMocks()
  await rm(workspace, { recursive: true, force: true })
})

/**
 * 建一个工作运行时并记入 afterEach 的释放清单。
 *
 * @returns 运行时实例（模型配置为占位值，AgentService 已被替换为替身）。
 */
function openRuntime (): ReturnType<typeof createAgentWorkRuntime> {
  const opened = createAgentWorkRuntime({
    workspace,
    model: 'fake-model',
    apiBaseUrl: 'https://llm.example.test/v1',
    apiKey: 'fake-key',
  })
  runtime = opened
  return opened
}

describe('工作运行时的 AskUserQuestion 宿主注册', () => {
  it('普通 Chat 会话（kind 缺省）在 chat 调用前就已登记宿主', () => {
    const { sessionId } = openRuntime().sendMessage({
      message: '帮我看看这个页面',
    })

    expect(harness.observations).toHaveLength(1)
    // 时序不变量：chat 被调用的那一刻宿主已就位，配置工厂才能装配出提问工具。
    expect(harness.observations[0]?.hostRegisteredAtCallTime).toBe(true)
    expect(harness.observations[0]?.sessionId).toBe(sessionId)
    expect(askUserRegistry.get(sessionId)).toBeDefined()
  })

  it('生成会话（kind=generation）同样获得提问能力', () => {
    const { sessionId } = openRuntime().sendMessage({
      message: '请生成 Playwright 脚本',
      kind: 'generation',
      title: '生成 Playwright 脚本',
    })

    expect(harness.observations[0]?.hostRegisteredAtCallTime).toBe(true)
    expect(askUserRegistry.get(sessionId)).toBeDefined()
  })

  it('未显式传 sessionId 时为自动生成的 ID 登记宿主', () => {
    const { sessionId } = openRuntime().sendMessage({ message: '你好' })

    expect(sessionId).toBeTruthy()
    expect(askUserRegistry.get(sessionId)).toBeDefined()
  })

  it('续轮重复注册是安全的，宿主始终可用', () => {
    const opened = openRuntime()
    const first = opened.sendMessage({
      message: '第一轮',
      sessionId: 'stable-session',
    })
    const second = opened.sendMessage({
      message: '第二轮',
      sessionId: 'stable-session',
    })

    expect(second.sessionId).toBe(first.sessionId)
    expect(harness.observations).toHaveLength(2)
    // 两轮都在 chat 前完成注册（第二轮是覆盖，不是缺席）。
    expect(
      harness.observations.every((entry) => entry.hostRegisteredAtCallTime),
    ).toBe(true)
    expect(askUserRegistry.get('stable-session')).toBeDefined()
  })

  it('releaseSession 注销宿主，避免同 ID 会话复活时拿到已释放实例', async () => {
    const opened = openRuntime()
    const { sessionId } = opened.sendMessage({
      message: '生成任务',
      kind: 'generation',
    })
    expect(askUserRegistry.get(sessionId)).toBeDefined()

    await opened.releaseSession(sessionId)
    expect(askUserRegistry.get(sessionId)).toBeUndefined()
  })

  it('chat 抛错时（宿主已登记、事件桥接未挂）dispose 仍注销该宿主', async () => {
    // 宿主登记发生在 agentService.chat 之前，事件桥接挂接在其之后。若 chat 抛错，
    // 会话就处于「已登记宿主但不在 wiredSessions」的中间态——dispose 必须靠
    // askHostSessions 而非 wiredSessions 才能清掉它，否则注册表残留指向已释放的运行时。
    const opened = openRuntime()
    harness.chatThrows = true

    expect(() =>
      opened.sendMessage({
        message: '会话创建失败',
        sessionId: 'half-open-session',
      }),
    ).toThrow(/模型配置不可用/)

    // 中间态：宿主确实已登记。
    expect(askUserRegistry.get('half-open-session')).toBeDefined()

    await opened.dispose()
    expect(askUserRegistry.get('half-open-session')).toBeUndefined()
    runtime = undefined
  })

  /**
   * v16 回归：工作台会话的**续轮**必须仍是 workbench 类型。
   *
   * 缺陷形态：装配只在会话首建时生效（`getOrCreate` 对已存在会话提前返回），
   * 若运行时不在会话上记住它，第二、三次 `sendMessage` 就拿不到 workbench 字段，
   * 被当成普通 chat——而 `AgentTaskRunner.getOrCreate` 见到「已是 workbench 的会话
   * 被要求以 chat 复用」会直接抛错。生产上表现为**执行结束后的解读轮次永不发生**
   * （RUN-10 落空），且异常会冒泡回执行服务的 finalize。
   */
  it('工作台会话续轮保持 workbench 类型（装配被记住，不会退化成 chat）', async () => {
    const opened = openRuntime()
    const assembly = {
      systemPromptSection: '## 工作台规则',
      tools: [],
      toolGuard: { id: 'workbench-guard' },
    }

    const { sessionId } = opened.sendMessage({
      message: '帮我跑一下云7登录的测试',
      workbench: assembly as never,
    })

    // 首轮：workbench 类型，且装配随创建参数传入。
    expect(harness.chatCalls).toHaveLength(1)
    expect(harness.chatCalls[0]).toMatchObject({
      operateType: 'workbench',
      hasWorkbench: true,
    })

    // 续轮（用户追加消息）：**不再传装配**，运行时必须自己记住它。
    opened.sendMessage({ sessionId, message: '再跑一次' })
    expect(harness.chatCalls).toHaveLength(2)
    expect(harness.chatCalls[1]).toMatchObject({
      sessionId,
      operateType: 'workbench',
      hasWorkbench: true,
    })

    // 平台注入的解读轮次与用户续轮走同一条路径，因此同样保持 workbench。
    opened.sendMessage({ sessionId, message: '【平台通知】本次执行已结束' })
    expect(harness.chatCalls[2]).toMatchObject({
      sessionId,
      operateType: 'workbench',
      hasWorkbench: true,
    })
  })

  it('普通会话续轮仍是 chat 类型（工作台记忆不串到其他会话）', () => {
    const opened = openRuntime()
    const { sessionId } = opened.sendMessage({ message: '你好' })

    opened.sendMessage({ sessionId, message: '继续' })

    for (const call of harness.chatCalls) {
      expect(call.operateType).toBe('chat')
      expect(call.hasWorkbench).toBe(false)
    }
  })

  it('dispose 清理所有已登记宿主（未走完 releaseSession 的会话也不残留）', async () => {
    const opened = openRuntime()
    const leaked = opened.sendMessage({ message: '未释放的会话' })
    expect(askUserRegistry.get(leaked.sessionId)).toBeDefined()

    await opened.dispose()
    expect(askUserRegistry.get(leaked.sessionId)).toBeUndefined()
    // dispose 已执行，afterEach 不再重复释放（否则 SQLite 已关闭会报错）。
    runtime = undefined
  })
})

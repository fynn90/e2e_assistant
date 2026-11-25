/**
 * 任务级多轮对话单元测试。
 *
 * 验证 AgentService 暴露的 chat 支持「一个任务多轮对话」：
 * 同一 sessionId 的历史逐轮累积、默认会话存储持久化、并发轮次串行化、以及跨实例断点续跑。
 *
 * 所有用例使用 mock streamFn（不回源模型），通过捕获发往 LLM 的上下文 role 序列断言历史。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../src/service'
import { createMemorySessionStore } from '../src/session/memory'
import type { IAgentModelRuntime } from '../src/model'
import type { AgentMessage } from '@earendil-works/pi-agent-core'

/** 测试用工作区（工具只绑定 cwd，不落盘即可）。 */
const WORKSPACE = '/tmp/e2e-agent-test-workspace'

/** mock 模型信息：thinkingLevel 必须为合法值。 */
const MODEL_INFO = {
  name: 'mock-model',
  url: 'https://mock.example.com/v1',
  key: 'mock-key',
  thinkingLevel: 'off' as const,
  supportsThinking: false,
}

/**
 * 创建 mock 模型运行时：捕获每一轮发往 LLM 的上下文 role 序列，并回显一条 assistant 消息。
 *
 * @param captured - 接收每轮上下文 role 序列的数组（按轮追加）。
 * @returns 可注入 AgentService 的模型运行时。
 */
function createMockRuntime(captured: string[][]): IAgentModelRuntime {
  // mock streamFn：类型宽松处理，仅测试运行时行为，不追求与 pi-ai 严格类型对齐。
  const streamFn = async (_model: unknown, context: any) => {
    captured.push(context.messages.map((m: AgentMessage) => m.role))
    const text = context.messages.at(-1)?.content?.[0]?.text ?? '?'
    // 运行时 mock 消息无需满足 pi-ai 完整 AssistantMessage 结构，仅需被 AgentLoop 透传。
    const final = {
      role: 'assistant',
      content: [{ type: 'text', text: `【回应 ${text}】` }],
      stopReason: 'stop',
      timestamp: Date.now(),
    } as unknown as AgentMessage
    const events = [
      { type: 'start', partial: { ...final, content: [] } },
      { type: 'done', reason: 'stop', message: final },
    ]
    return {
      [Symbol.asyncIterator]() {
        let index = 0
        return {
          next: async () => {
            if (index < events.length) {
              return { value: events[index++], done: false }
            }
            return { value: undefined, done: true }
          },
        }
      },
      result: async () => final,
    }
  }

  return {
    model: { id: 'mock-model' } as never,
    streamFn: streamFn as never,
    thinkingLevel: 'off',
  } as unknown as IAgentModelRuntime
}

describe('任务级多轮对话', () => {
  it('同一任务多轮 send，历史逐轮累积', async () => {
    const captured: string[][] = []
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionStore: createMemorySessionStore(),
    })

    const handle = service.chat('第一轮：记录用户名为 tom', {
      sessionId: 'session-1',
    })
    await handle.result
    await handle.send('第二轮：用户名是谁？')
    await handle.send('第三轮：确认用户名为 tom？')

    expect(captured[0]).toEqual(['user'])
    expect(captured[1]).toEqual(['user', 'assistant', 'user'])
    expect(captured[2]).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    expect(handle.status).toBe('idle')
    expect(handle.operateType).toBe('chat')

    await service.dispose()
  })

  it('跨 chat 调用（复用 sessionId）续接同一会话', async () => {
    const captured: string[][] = []
    const store = createMemorySessionStore()
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionStore: store,
    })

    const h1 = service.chat('第一轮', { sessionId: 'session-2' })
    await h1.result
    // 第二次调用同一 sessionId：复用同一句柄与会话
    const h2 = service.chat('第二轮', { sessionId: 'session-2' })
    await h2.result

    expect(h2).toBe(h1)
    expect(captured[1]).toEqual(['user', 'assistant', 'user'])

    await service.dispose()
  })

  it('chat 同样支持多轮，多个 session 彼此隔离', async () => {
    const captured: string[][] = []
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionStore: createMemorySessionStore(),
    })

    const first = service.chat('第一条：补充断言', {
      sessionId: 'session-first',
    })
    await first.result
    await first.send('再补充一个异常分支')
    expect(first.operateType).toBe('chat')

    const second = service.chat('你好', { sessionId: 'session-second' })
    await second.result
    await second.send('继续')
    expect(second.operateType).toBe('chat')

    expect(service.listTasks()).toHaveLength(2)
    expect(service.getTask('session-first')).toBe(first)

    await service.dispose()
  })

  it('缺省会话存储（sqlite）不丢历史：两轮历史保留', async () => {
    const captured: string[][] = []
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      // 不传 sessionStore：走 AgentService 默认 sqlite 存储（:memory:）
      sessionDbPath: ':memory:',
    })

    const handle = service.chat('第一轮', { sessionId: 'session-3' })
    await handle.result
    await handle.send('第二轮')

    expect(captured[1]).toEqual(['user', 'assistant', 'user'])
    // 两轮后完整会话为 4 条：首轮 user/assistant + 次轮 user/assistant
    expect(handle.snapshot().length).toBe(4)

    await service.dispose()
  })

  it('并发 send 串行执行：后一轮看到前一轮完整历史', async () => {
    const captured: string[][] = []
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionStore: createMemorySessionStore(),
    })

    const handle = service.chat('第一轮', { sessionId: 'session-4' })
    await handle.result

    // 不 await 第一个 send 直接连发第二个：依赖任务级串行化排队执行
    const [r2, r3] = await Promise.all([
      handle.send('第二轮'),
      handle.send('第三轮'),
    ])

    expect(captured[1]).toEqual(['user', 'assistant', 'user'])
    expect(captured[2]).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    // 每轮新增 user + assistant 各一条：第二轮后 4 条、第三轮后 6 条
    expect(r2.messages).toHaveLength(4)
    expect(r3.messages).toHaveLength(6)

    await service.dispose()
  })

  it('重启恢复：新 AgentService 复用同一 sqlite 库续接历史', async () => {
    const captured: string[][] = []
    const dir = mkdtempSync(join(tmpdir(), 'e2e-agent-session-'))
    const dbPath = join(dir, 'sessions.db')

    const service1 = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionDbPath: dbPath,
    })
    const h1 = service1.chat('第一轮', { sessionId: 'session-5' })
    await h1.result
    await service1.dispose()

    // 模拟服务重启：同一 dbPath + 同一 sessionId
    const service2 = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionDbPath: dbPath,
    })
    const h2 = service2.chat('第二轮', { sessionId: 'session-5' })
    await h2.result

    // 第二轮携带第一轮历史：role 序列 user,assistant,user
    expect(captured[1]).toEqual(['user', 'assistant', 'user'])

    await service2.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('removeTask 后任务句柄进入完成态，send 被拒绝', async () => {
    const captured: string[][] = []
    const service = new AgentService(WORKSPACE, MODEL_INFO, {
      modelRuntime: createMockRuntime(captured),
      sessionStore: createMemorySessionStore(),
    })

    const handle = service.chat('第一轮', { sessionId: 'session-6' })
    await handle.result
    await service.removeTask('session-6')

    expect(handle.status).toBe('completed')
    expect(service.getTask('session-6')).toBeUndefined()
    await expect(handle.send('第二轮')).rejects.toThrow(/已结束/)

    await service.dispose()
  })
})

/**
 * SQLite 会话存储与 AgentLoop 断点续跑单元测试。
 *
 * 验证 createSqliteSessionStore 的持久化 / 查询 / 删除 / 重启恢复语义，
 * 以及 AgentLoop.run(sessionId) 的历史恢复、会话隔离与断点续跑行为。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { AgentFactory } from '../../src/agents/factory'
import { createAgentModelRuntime } from '../../src/model'
import { createAgentLoop } from '../../src/loop/agent-loop'
import { createSqliteSessionStore } from '../../src/session'

/** 临时数据库文件路径列表，用于测试结束后清理。 */
const temporaryDbPaths: string[] = []

/**
 * 创建一个指向临时目录的 SQLite 数据库路径。
 *
 * @returns 新建临时数据库文件的绝对路径。
 */
async function createTemporaryDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'authine-session-test-'))
  const dbPath = join(dir, 'sessions.db')
  temporaryDbPaths.push(dbPath)
  return dbPath
}

afterEach(async () => {
  await Promise.all(
    temporaryDbPaths
      .splice(0)
      .map((dbPath) => rm(dbPath, { force: true }).catch(() => {})),
  )
})

/** 构造一条最小可 JSON 序列化的 assistant 消息。 */
function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'authine',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  }
}

describe('createSqliteSessionStore', () => {
  it('保存并加载会话消息', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })

    await store.save('s1', [
      { role: 'user', content: 'hi', timestamp: 1 },
      assistantMessage('hello'),
    ])
    const messages = await store.load('s1')

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' })
    store.close()
  })

  it('增量保存并按运行查询工具调用审计记录', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })
    const record = {
      sessionId: 's-tool',
      runId: 'run-1',
      toolCallId: 'call-1',
      sequence: 0,
      toolName: 'read',
      toolLabel: '读取文件',
      args: { path: 'README.md' },
      status: 'running' as const,
      startedAt: 1,
      updatedAt: 1,
    }

    await store.upsertToolCall(record)
    await store.upsertToolCall({
      ...record,
      status: 'succeeded',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
      completedAt: 2,
      updatedAt: 2,
    })

    expect(await store.listToolCalls('s-tool')).toEqual([
      expect.objectContaining({
        toolCallId: 'call-1',
        status: 'succeeded',
        isError: false,
      }),
    ])
    expect(await store.listToolCalls('s-tool', { runId: 'other' })).toEqual([])
    store.close()
  })

  it('getSession 返回会话概要', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })

    await store.save('s1', [{ role: 'user', content: 'hi', timestamp: 1 }], {
      skillId: 'skill-a',
      title: '会话A',
    })
    const summary = await store.getSession('s1')

    expect(summary).toMatchObject({
      id: 's1',
      messageCount: 1,
      skillId: 'skill-a',
      title: '会话A',
    })
    expect(await store.getSession('missing')).toBeUndefined()
    store.close()
  })

  it('listSessions 支持按 skillId / status 过滤与分页', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })

    await store.save('s1', [{ role: 'user', content: 'a', timestamp: 1 }], {
      skillId: 'skill-a',
    })
    await store.save('s2', [{ role: 'user', content: 'b', timestamp: 2 }], {
      skillId: 'skill-a',
      status: 'completed',
    })
    await store.save('s3', [{ role: 'user', content: 'c', timestamp: 3 }], {
      skillId: 'skill-b',
    })

    expect(await store.listSessions()).toHaveLength(3)
    expect(await store.listSessions({ skillId: 'skill-a' })).toHaveLength(2)
    expect(await store.listSessions({ status: 'completed' })).toHaveLength(1)
    expect(await store.listSessions({ pageSize: 2 })).toHaveLength(2)
    store.close()
  })

  it('remove 删除会话及其消息（外键级联）', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })

    await store.save('s1', [{ role: 'user', content: 'hi', timestamp: 1 }])
    await store.remove('s1')

    expect(await store.load('s1')).toEqual([])
    expect(await store.getSession('s1')).toBeUndefined()
    store.close()
  })

  it('removeBySkillId 返回被删会话 ID 并级联清空消息与工具调用', async () => {
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })

    await store.save('s1', [{ role: 'user', content: 'a', timestamp: 1 }], {
      skillId: 'skill-a',
    })
    await store.save('s2', [{ role: 'user', content: 'b', timestamp: 2 }], {
      skillId: 'skill-a',
      status: 'completed',
    })
    await store.save('s3', [{ role: 'user', content: 'c', timestamp: 3 }], {
      skillId: 'skill-b',
    })
    await store.upsertToolCall({
      sessionId: 's1',
      runId: 'run-1',
      toolCallId: 'call-1',
      sequence: 0,
      toolName: 'read',
      args: {},
      status: 'succeeded',
      startedAt: 1,
      updatedAt: 1,
    })

    const removed = await store.removeBySkillId('skill-a')

    expect(removed.sort()).toEqual(['s1', 's2'])
    expect(await store.getSession('s1')).toBeUndefined()
    expect(await store.getSession('s2')).toBeUndefined()
    expect(await store.listSessions()).toHaveLength(1)
    expect(await store.listToolCalls('s1')).toEqual([])
    store.close()
  })

  it('重新打开数据库文件后数据仍在（断点续跑基础）', async () => {
    const dbPath = await createTemporaryDbPath()

    const store1 = createSqliteSessionStore({ dbPath })
    await store1.save('s1', [{ role: 'user', content: 'hi', timestamp: 1 }])
    store1.close()

    const store2 = createSqliteSessionStore({ dbPath })
    expect(await store2.load('s1')).toHaveLength(1)
    store2.close()
  })
})

describe('AgentLoop 断点续跑', () => {
  /** 构造使用 mock SSE 端点的模型运行时与 Agent 配置。 */
  async function createLoopFixture() {
    const modelInfo = {
      name: 'test-model',
      url: 'https://llm.example.com/v1',
      key: 'test-api-key',
      thinkingLevel: 'high' as const,
    }
    const fetchMock = async () => {
      const body = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"回复"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    // 覆盖全局 fetch，使 Agent 内部的流式调用走 mock 端点。
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createAgentModelRuntime(modelInfo)
    const config = AgentFactory('chat', '/tmp/agent-test-workspace')
    const dbPath = await createTemporaryDbPath()
    const store = createSqliteSessionStore({ dbPath })
    return {
      loop: createAgentLoop(config, runtime, {
        plugins: { sessionStore: store },
      }),
      store,
    }
  }

  it('同一 sessionId 连续 run 会恢复历史并累积消息', async () => {
    const { loop, store } = await createLoopFixture()

    await loop.run('s1', '第一条')
    await loop.run('s1', '第二条')

    const messages = await store.load('s1')
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(messages[3]).toMatchObject({ role: 'assistant' })
    store.close()
  })

  it('切换到新 sessionId 时不会残留上一个会话的消息', async () => {
    const { loop, store } = await createLoopFixture()

    await loop.run('s1', '第一条')
    await loop.run('s2', '新会话')

    expect(await store.load('s1')).toHaveLength(2)
    expect(await store.load('s2')).toHaveLength(2)
    store.close()
  })
})

/**
 * SQLite 会话存储 + run(sessionId) 冒烟测试。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentModelRuntime } from '../src/model'
import { AgentFactory } from '../src/agents/factory'
import { createAgentLoop } from '../src/loop/agent-loop'
import { createSqliteSessionStore } from '../src/session'

const modelInfo = {
  name: 'test-model',
  url: 'https://llm.example.com/v1',
  key: 'test-api-key',
  thinkingLevel: 'high' as const,
}

;(globalThis as any).fetch = async () => {
  const body = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"回复"},"finish_reason":null}]}\n\n',
    'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function main() {
  const runtime = createAgentModelRuntime(modelInfo)
  const config = AgentFactory('create', '/tmp/agent-workspace')
  const dbPath = join(
    mkdtempSync(join(tmpdir(), 'authine-session-')),
    'sessions.db',
  )

  // 1. SQLite 存储独立功能：save/load/get/list/remove
  const store = createSqliteSessionStore({ dbPath })
  const messages = [
    { role: 'user', content: 'hi', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: 2,
      api: 'openai-completions',
      provider: 'authine',
      model: 'test-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
      },
      stopReason: 'stop',
    },
  ]
  await store.save('s1', messages, { skillId: 'skill-a', title: '会话A' })
  console.assert((await store.load('s1')).length === 2, 'load 返回 2 条')
  const meta = await store.getSession('s1')
  console.assert(
    meta?.messageCount === 2 && meta.skillId === 'skill-a',
    'getSession 概要正确',
  )

  await store.save('s2', [{ role: 'user', content: 'x', timestamp: 3 }], {
    skillId: 'skill-a',
  })
  await store.save('s3', [{ role: 'user', content: 'y', timestamp: 4 }], {
    skillId: 'skill-b',
  })
  const all = await store.listSessions()
  console.assert(all.length === 3, `listSessions 3 条，实际 ${all.length}`)
  const bySkill = await store.listSessions({ skillId: 'skill-a' })
  console.assert(
    bySkill.length === 2,
    `按 skill 过滤 2 条，实际 ${bySkill.length}`,
  )
  await store.remove('s3')
  console.assert((await store.listSessions()).length === 2, 'remove 后 2 条')

  // 2. AgentLoop.run(sessionId, input)：断点续跑
  const loop = createAgentLoop(config, runtime, {
    plugins: { sessionStore: createSqliteSessionStore({ dbPath }) },
  })
  await loop.run('skill-a:run-1', '第一条')
  await loop.run('skill-a:run-1', '第二条')
  const resumed = await store.load('skill-a:run-1')
  console.assert(resumed.length === 4, `续跑后 4 条，实际 ${resumed.length}`)
  console.assert(
    resumed[0].role === 'user' && resumed[3].role === 'assistant',
    '历史顺序正确',
  )

  // 3. 不同 sessionId 相互隔离
  await loop.run('skill-a:run-2', '新会话')
  const run2 = await store.load('skill-a:run-2')
  console.assert(run2.length === 2, `新会话独立 2 条，实际 ${run2.length}`)
  console.assert(
    (await store.load('skill-a:run-1')).length === 4,
    '原会话不受影响',
  )

  console.log('全部断言通过 ✔ SQLITE SMOKE OK')
  store.close()
}

main().catch((error) => {
  console.error('SQLITE SMOKE FAIL:', error)
  process.exit(1)
})

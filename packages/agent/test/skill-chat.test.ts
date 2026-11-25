/**
 * Skill Chat 运行时（SSE 桥接）单元测试。
 *
 * 通过 stub 全局 fetch 返回 OpenAI Chat Completions 兼容的 SSE 流，
 * 验证 createSkillChatRuntime 把 AgentService 事件流正确翻译为
 * TSkillChatEvent（delta / complete），并在流结束后释放运行时。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISkillChatMessage } from '@authine-e2e-agent/types'
import { createSkillChatRuntime } from '../src/service/skill-chat'

/** 测试用工作区（工具只绑定 cwd，不落盘即可）。 */
const WORKSPACE = '/tmp/e2e-agent-test-workspace'

/** 构造一个最小 Skill 详情。 */
const skill = {
  id: 'a1b2c3d4e',
  title: '登录用例',
  description: '验证登录流程',
  version: '1.0.0',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  readOnly: false,
}

/** 构造 mock SSE 响应体：先输出文本增量，再 stop。 */
function mockSseBody(text: string): string {
  return [
    `data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\n`,
    'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSkillChatRuntime', () => {
  it('把对话历史跑一轮并翻译为 delta / complete 事件', async () => {
    // 覆盖全局 fetch，使内建 AgentService 的模型调用走 mock SSE 端点。
    const fetchMock = vi.fn(async () => {
      return new Response(mockSseBody('你好，我可以帮你修改测试用例'), {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createSkillChatRuntime({
      workspace: WORKSPACE,
      apiKey: 'test-key',
      apiBaseUrl: 'https://llm.example.com/v1',
      model: 'test-model',
    })

    const messages: ISkillChatMessage[] = [
      { role: 'user', content: '帮我改一下这个断言' },
    ]
    const stream = await runtime.open({
      skill,
      fileTreeSummary: JSON.stringify({ kind: 'file', name: 'SKILL.md' }),
      messages,
    })

    expect(stream.historyTruncated).toBe(false)
    expect(stream.currentFileTruncated).toBe(false)
    expect(stream.currentFile).toBeUndefined()

    const events: { type: string; text?: string }[] = []
    for await (const event of stream.events) {
      events.push(event)
    }

    const deltas = events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text ?? '')
      .join('')
    expect(deltas).toContain('你好')
    expect(events.some((e) => e.type === 'complete')).toBe(true)
    // 流结束后运行时已释放（内建 AgentService 被 dispose）
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  it('历史超长时标记 historyTruncated 并给上下文告警', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(mockSseBody('ok'), {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createSkillChatRuntime({
      workspace: WORKSPACE,
      apiKey: 'test-key',
      apiBaseUrl: 'https://llm.example.com/v1',
      model: 'test-model',
    })

    // v12-pre：单条上限已提到 240_000（与引擎快照上限对齐），
    // 因此这里必须超过新上限才能触发单条截断。
    const longMessage: ISkillChatMessage = {
      role: 'user',
      content: 'a'.repeat(250_000),
    }
    const stream = await runtime.open({
      skill,
      fileTreeSummary: '',
      messages: [longMessage, { role: 'user', content: '最后一条' }],
    })

    expect(stream.historyTruncated).toBe(true)
    expect(stream.contextWarnings.length).toBeGreaterThan(0)

    // 消费完事件流后运行时释放
    const events: unknown[] = []
    for await (const event of stream.events) {
      events.push(event)
    }
    await runtime.close()
  })

  it('对话历史为空时 open 抛错', async () => {
    const runtime = createSkillChatRuntime({
      workspace: WORKSPACE,
      apiKey: 'test-key',
      apiBaseUrl: 'https://llm.example.com/v1',
      model: 'test-model',
    })

    await expect(
      runtime.open({ skill, fileTreeSummary: '', messages: [] }),
    ).rejects.toThrow(/不能为空/)
    await runtime.close()
  })
})

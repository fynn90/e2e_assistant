/**
 * Agent 工具调用闭环与审计持久化测试。
 *
 * 本文件使用 pi-agent-core 的真实 AgentLoop：模拟模型先请求工具、收到 toolResult 后再输出文本，
 * 验证工具执行、结果回注、工具事件、会话审计记录和安全展示投影构成完整闭环。
 */

import { describe, expect, it } from 'vitest'
import { Type } from 'typebox'
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from '@earendil-works/pi-agent-core'
import { createAgentLoop } from '../../src/loop/agent-loop'
import type { IAgentModelRuntime } from '../../src/model'
import { createMemorySessionStore } from '../../src/session/memory'

/** 测试工具的参数 Schema。 */
const echoParameters = Type.Object({
  value: Type.String(),
  apiKey: Type.Optional(Type.String()),
})

/**
 * 构建满足 pi-ai 最小运行需求的 assistant 消息。
 *
 * @param content - 文本或工具调用内容块。
 * @param stopReason - 模型停止原因。
 * @returns 供 mock stream 返回的 assistant 消息。
 */
function assistantMessage(
  content: unknown[],
  stopReason: 'toolUse' | 'stop',
): AgentMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  } as AgentMessage
}

/**
 * 将一条最终 assistant 消息包装成 AgentLoop 可消费的最小流。
 *
 * @param message - 本次模型调用的最终消息。
 * @returns 简化的 AssistantMessageEventStream 测试替身。
 */
function completedStream(message: AgentMessage) {
  const reason = (message as { stopReason: 'toolUse' | 'stop' }).stopReason
  const events = [
    { type: 'start', partial: { ...message, content: [] } },
    { type: 'done', reason, message },
  ]
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        next: async () =>
          index < events.length
            ? { value: events[index++], done: false }
            : { value: undefined, done: true },
      }
    },
    result: async () => message,
  }
}

/**
 * 创建工具调用闭环所需的模型运行时。
 *
 * @param receivedContexts - 收集每次发给模型的上下文，用于验证 toolResult 回注。
 * @returns 能先请求 echo、再读取工具结果完成回复的运行时。
 */
function createToolRuntime(
  receivedContexts: AgentMessage[][],
): IAgentModelRuntime {
  const streamFn = async (
    _model: unknown,
    context: { messages: AgentMessage[] },
  ) => {
    receivedContexts.push(context.messages)
    const last = context.messages.at(-1)
    if (last?.role === 'toolResult') {
      return completedStream(
        assistantMessage([{ type: 'text', text: '已收到工具结果' }], 'stop'),
      )
    }
    return completedStream(
      assistantMessage(
        [
          {
            type: 'toolCall',
            id: 'tool-call-1',
            name: 'echo',
            arguments: { value: 'hello', apiKey: 'private-key' },
          },
        ],
        'toolUse',
      ),
    )
  }

  return {
    model: { id: 'test-model' } as never,
    streamFn: streamFn as never,
    thinkingLevel: 'off',
  } as unknown as IAgentModelRuntime
}

describe('AgentLoop 工具调用闭环', () => {
  it('执行工具、把 toolResult 回注模型、持久化审计记录并生成脱敏展示', async () => {
    const receivedContexts: AgentMessage[][] = []
    const events: AgentEvent[] = []
    const store = createMemorySessionStore()
    let executions = 0
    const echoTool: AgentTool<typeof echoParameters> = {
      name: 'echo',
      label: '回显工具',
      description: '回显测试参数。',
      parameters: echoParameters,
      executionMode: 'sequential',
      async execute(_toolCallId, parameters, _signal, onUpdate) {
        executions += 1
        onUpdate?.({
          content: [{ type: 'text', text: '处理中' }],
          details: { progress: 50 },
        })
        return {
          content: [{ type: 'text', text: `结果：${parameters.value}` }],
          details: {
            apiKey: parameters.apiKey,
            nested: { token: 'inner-secret' },
          },
        }
      },
    }
    const loop = createAgentLoop(
      { systemPrompt: 'test', tools: [echoTool] },
      createToolRuntime(receivedContexts),
      { plugins: { sessionStore: store } },
    )
    loop.subscribe((event: AgentEvent) => {
      events.push(event)
    })

    const result = await loop.run('session-tool-chain', '请调用回显工具')
    const records = await store.listToolCalls('session-tool-chain')

    expect(executions).toBe(1)
    expect(receivedContexts).toHaveLength(2)
    expect(receivedContexts[1].at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tool-call-1',
      toolName: 'echo',
      isError: false,
    })
    expect(
      result.messages.some((message) => message.role === 'toolResult'),
    ).toBe(true)
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'tool_execution_start',
        'tool_execution_update',
        'tool_execution_end',
      ]),
    )

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      runId: result.runId,
      toolCallId: 'tool-call-1',
      toolName: 'echo',
      status: 'succeeded',
      isError: false,
    })
    expect(records[0].result).toMatchObject({
      details: { apiKey: 'private-key' },
    })

    // 运行结束后 Loop 的临时投影已释放；审计记录的展示投影由存储读取后统一生成。
    const { toToolCallView } = await import('../../src/tool-trace/projector')
    const view = toToolCallView(records[0])
    expect(view.arguments).toMatchObject({ apiKey: '[已脱敏]' })
    expect(view.result).toMatchObject({
      details: { apiKey: '[已脱敏]', nested: { token: '[已脱敏]' } },
    })
  })
})

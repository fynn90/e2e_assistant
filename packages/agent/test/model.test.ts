/**
 * 模型运行时工厂单元测试。
 *
 * 本模块验证 IModelInfo 到 pi-ai OpenAI Chat Completions 运行时的映射、思考能力
 * 降级策略，以及 Provider 使用配置密钥发起流式请求的行为。
 */

import type { Context, FetchFunction } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { createAgentModelRuntime } from '../src/model'

/** 用于构造稳定测试输入的 OpenAI Chat Completions 兼容模型配置。 */
const modelInfo = {
  name: 'test-model',
  url: 'https://llm.example.com/v1',
  key: 'test-api-key',
  thinkingLevel: 'high' as const,
}

/** 测试模型请求使用的最小 pi-ai 上下文。 */
const context: Context = {
  messages: [
    {
      role: 'user',
      content: '你好',
      timestamp: 0,
    },
  ],
}

describe('createAgentModelRuntime', () => {
  it('创建默认关闭思考能力的 OpenAI 兼容模型', () => {
    const runtime = createAgentModelRuntime(modelInfo)

    expect(runtime.model).toMatchObject({
      id: 'test-model',
      name: 'test-model',
      api: 'openai-completions',
      provider: 'authine-openai-compatible',
      baseUrl: 'https://llm.example.com/v1',
      reasoning: false,
      // v12-pre：声明图片输入能力，browser_screenshot 的截图才能到达模型。
      input: ['text', 'image'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 100_000_000,
      maxTokens: 65_536,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    })
    expect(runtime.thinkingLevel).toBe('off')
    expect(JSON.stringify(runtime.model)).not.toContain(modelInfo.key)
  })

  it('仅在显式声明时启用 reasoning_effort 与请求思考等级', () => {
    const runtime = createAgentModelRuntime({
      ...modelInfo,
      supportsThinking: true,
    })

    expect(runtime.model.reasoning).toBe(true)
    expect(runtime.model.compat?.supportsReasoningEffort).toBe(true)
    expect(runtime.model.thinkingLevelMap).toMatchObject({
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
    expect(runtime.thinkingLevel).toBe('high')
  })

  it('通过认证闭包使用配置密钥调用兼容端点', async () => {
    const runtime = createAgentModelRuntime(modelInfo)
    const fetchMock: FetchFunction = vi.fn(async (input, init) => {
      expect(String(input)).toBe('https://llm.example.com/v1/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer test-api-key',
      )
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'test-model',
        stream: true,
      })

      return new Response(
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{"content":"完成"},"finish_reason":null}]}\n\n' +
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    })

    const stream = await runtime.streamFn(runtime.model, context, {
      fetch: fetchMock,
    })
    const events = []
    for await (const event of stream) {
      events.push(event)
    }

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events.some((event) => event.type === 'done')).toBe(true)
  })
})

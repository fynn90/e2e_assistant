/**
 * 客户端事件翻译器的单元测试。
 *
 * 覆盖：思考/内容增量游标、工具 → tool/command 事件、
 * 文件类工具的 file_change 旁路事件、运行生命周期（turn）事件、
 * 未闭合块的收尾。
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { TAgentClientEventDraft } from '@charlie_deng/e2e-assistant-types'
import { ClientEventTranslator } from '../src/harness/client-events'

/** 构造一条助手流式消息（内容为累计全量）。 */
function assistantMessage (
  blocks: Array<{ type: string; text?: string; thinking?: string }>,
): AgentMessage {
  return { role: 'assistant', content: blocks } as unknown as AgentMessage
}

/** 拉平事件数组，便于断言。 */
function flat (
  result: TAgentClientEventDraft[] | null,
): TAgentClientEventDraft[] {
  return result ?? []
}

describe('ClientEventTranslator', () => {
  it('运行开始产出 turn begin + status，结束产出 turn end + status idle', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })

    const start = translator.onRunStart({
      runId: 'r1',
      startedAt: Date.now(),
      sessionId: 's1',
      input: '帮我写测试',
    })
    expect(start).toHaveLength(2)
    expect(start[0]).toMatchObject({
      type: 'turn',
      phase: 'begin',
      runId: 'r1',
      inputPreview: '帮我写测试',
      sessionId: 's1',
    })
    expect(start[1]).toMatchObject({ type: 'status', activity: 'thinking' })

    const end = translator.onRunEnd({ runId: 'r1', messages: [] })
    const turnEnd = end.find((event) => event.type === 'turn')
    expect(turnEnd).toMatchObject({ phase: 'end', outcome: 'succeeded' })
    expect(
      end.some((event) => event.type === 'status' && event.activity === 'idle'),
    ).toBe(true)
  })

  it('配置 inputPreviewOverride 时用它替代输入文本（系统任务型会话的标题来源）', () => {
    const translator = new ClientEventTranslator({
      sessionId: 's1',
      inputPreviewOverride: '生成 SKILL.md',
    })

    const start = translator.onRunStart({
      runId: 'r1',
      startedAt: Date.now(),
      sessionId: 's1',
      // 真实生成任务的输入是含完整用例数据的长 prompt，不应作为会话标题
      input: '请先调用 load_skill...{"testCase":{...很长的数据...}}',
    })

    expect(start[0]).toMatchObject({
      type: 'turn',
      phase: 'begin',
      inputPreview: '生成 SKILL.md',
    })
  })

  it('未配置覆盖文案时沿用输入文本', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })

    const start = translator.onRunStart({
      runId: 'r1',
      startedAt: Date.now(),
      sessionId: 's1',
      input: '帮我写测试',
    })

    expect(start[0]).toMatchObject({ inputPreview: '帮我写测试' })
  })

  it('消息流式更新：思考与文本分别维护增量游标', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    // 第一次更新：只有思考。
    const first = flat(
      translator.translate({
        type: 'message_update',
        message: assistantMessage([{ type: 'thinking', thinking: '先分析' }]),
        assistantMessageEvent: {} as never,
      }),
    )
    expect(
      first.some((e) => e.type === 'thinking' && e.phase === 'begin'),
    ).toBe(true)
    expect(
      first.some(
        (e) =>
          e.type === 'thinking' && e.phase === 'append' && e.text === '先分析',
      ),
    ).toBe(true)

    // 第二次更新：思考变长（增量流出）+ 开始出现文本。
    const second = flat(
      translator.translate({
        type: 'message_update',
        message: assistantMessage([
          { type: 'thinking', thinking: '先分析需求' },
          { type: 'text', text: '好的' },
        ]),
        assistantMessageEvent: {} as never,
      }),
    )
    const thinkingAppend = second.filter(
      (e) => e.type === 'thinking' && e.phase === 'append',
    )
    expect(thinkingAppend).toHaveLength(1)
    expect(thinkingAppend[0].text).toBe('需求')
    expect(
      second.some((e) => e.type === 'content' && e.phase === 'begin'),
    ).toBe(true)
    expect(
      second.some(
        (e) =>
          e.type === 'content' && e.phase === 'append' && e.text === '好的',
      ),
    ).toBe(true)

    // 消息结束：两个块都被闭合。
    const closed = flat(
      translator.translate({
        type: 'message_end',
        message: assistantMessage([
          { type: 'thinking', thinking: '先分析需求' },
          { type: 'text', text: '好的' },
        ]),
      }),
    )
    expect(closed.some((e) => e.type === 'thinking' && e.phase === 'end')).toBe(
      true,
    )
    expect(closed.some((e) => e.type === 'content' && e.phase === 'end')).toBe(
      true,
    )
  })

  it('文件写入工具：tool 事件 + file_change 旁路事件成对出现', () => {
    const translator = new ClientEventTranslator({
      sessionId: 's1',
      workspace: '/nonexistent-workspace',
    })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    const started = flat(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'write',
        args: { path: 'tests/login.spec.ts', content: '...' },
      }),
    )
    const toolBegin = started.find((e) => e.type === 'tool')
    expect(toolBegin).toMatchObject({
      phase: 'begin',
      tool: {
        category: 'file',
        // action 是客户端选图标的依据（category 只管配色），必须随 begin 下发
        action: 'write',
        title: '写入文件',
        subtitle: 'tests/login.spec.ts',
      },
    })
    expect(
      started.some((e) => e.type === 'status' && e.activity === 'tool_running'),
    ).toBe(true)

    const ended = flat(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'write',
        result: { content: [{ type: 'text', text: '写入成功' }], details: {} },
        isError: false,
      }),
    )
    expect(
      ended.some(
        (e) =>
          e.type === 'tool' && e.phase === 'end' && e.status === 'succeeded',
      ),
    ).toBe(true)
    // 工作区下不存在该文件 → write 视为新建。
    const change = ended.find((e) => e.type === 'file_change')
    expect(change).toMatchObject({
      operation: 'create',
      path: 'tests/login.spec.ts',
    })
  })

  it('bash 工具翻译为 command 事件并提取退出码', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    const started = flat(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'npx playwright test' },
      }),
    )
    expect(started[0]).toMatchObject({
      type: 'command',
      phase: 'begin',
      command: 'npx playwright test',
    })

    const updated = flat(
      translator.translate({
        type: 'tool_execution_update',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'npx playwright test' },
        partialResult: {
          content: [{ type: 'text', text: '5 passed' }],
          details: {},
        },
      }),
    )
    expect(updated[0]).toMatchObject({
      type: 'command',
      phase: 'append',
      stream: 'stdout',
      text: '5 passed',
    })

    const ended = flat(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: { content: [], details: { exitCode: 0 } },
        isError: false,
      }),
    )
    expect(ended[0]).toMatchObject({
      type: 'command',
      phase: 'end',
      exitCode: 0,
    })
  })

  it('todo_write 工具翻译为 todo 块并携带完整清单', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    const started = flat(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'todo_write',
        args: {
          items: [
            { id: 's1', content: '登录并确认跳转', status: 'in_progress' },
            { id: 's2', content: '打开模板列表', status: 'pending' },
            {
              id: 's3',
              content: '打开预览弹框',
              status: 'completed',
              activeForm: '已确认',
            },
          ],
        },
      }),
    )

    // 清单在 start 即整体下发（整体替换语义，无 append 阶段）。
    expect(started[0]).toMatchObject({ type: 'todo', phase: 'begin' })
    const todo = started[0] as Extract<TAgentClientEventDraft, { type: 'todo' }>
    expect(todo.items.map((item) => item.status)).toEqual([
      'in_progress',
      'pending',
      'completed',
    ])
    // 内容与 activeForm 经安全预览保留。
    expect(todo.items[0]).toMatchObject({ content: '登录并确认跳转' })
    expect(todo.items[2]).toMatchObject({ activeForm: '已确认' })
    // 状态条给出进度文案。
    expect(started[1]).toMatchObject({ type: 'status', label: '任务清单 1/3' })
  })

  it('todo_write 结束时不重复产出块事件', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    translator.translate({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'todo_write',
      args: { items: [{ id: 's1', content: '步骤一', status: 'pending' }] },
    })

    const ended = flat(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'todo_write',
        result: {
          content: [{ type: 'text', text: '清单已更新' }],
          details: {},
        },
        isError: false,
      }),
    )

    // 成功结束不再产出任何事件：清单已在 start 整体下发，重复下发会让时间线出现两块。
    expect(ended).toHaveLength(0)
  })

  it('todo 清单缺少必要字段时按空清单兜底，不产生非法结构', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    const started = flat(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'todo_write',
        args: {
          items: [{ content: '   ' }, { status: 'pending' }, '不是对象'],
        },
      }),
    )

    const todo = started[0] as Extract<TAgentClientEventDraft, { type: 'todo' }>
    // 空白内容与非对象条目都被丢弃，避免渲染出空气泡。
    expect(todo.items).toEqual([])
  })

  it('截图工具把图片引用带入 tool 块的 end 事件', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    translator.translate({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'browser_screenshot',
      args: { selector: '#canvas' },
    })

    const ended = flat(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'browser_screenshot',
        result: {
          content: [
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            { type: 'text', text: '已截取元素「#canvas」' },
          ],
          details: {
            width: 800,
            height: 600,
            mimeType: 'image/png',
            skipped: false,
            image: {
              url: '/api/skills/abc123456/exploration/sess_1/1758400000000-00.png',
              mimeType: 'image/png',
              width: 800,
              height: 600,
            },
          },
        },
        isError: false,
      }),
    )

    expect(ended[0]).toMatchObject({
      type: 'tool',
      phase: 'end',
      image: {
        url: '/api/skills/abc123456/exploration/sess_1/1758400000000-00.png',
        width: 800,
        height: 600,
      },
    })
    // 事件里不能出现 base64 字节：图片只以引用形式下发。
    expect(JSON.stringify(ended)).not.toContain('aGVsbG8=')
  })

  it('截图结果为错误时不携带图片引用', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })

    translator.translate({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'browser_screenshot',
      args: {},
    })

    const ended = flat(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'browser_screenshot',
        result: {
          content: [{ type: 'text', text: '截图失败' }],
          details: {
            width: 0,
            height: 0,
            skipped: true,
            image: {
              url: '/x.png',
              mimeType: 'image/png',
              width: 1,
              height: 1,
            },
          },
        },
        isError: true,
      }),
    )

    expect(ended[0]).toMatchObject({
      type: 'tool',
      phase: 'end',
      status: 'failed',
    })
    expect((ended[0] as { image?: unknown }).image).toBeUndefined()
  })

  it('运行结束时收尾未闭合的工具块为失败态', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })
    translator.translate({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'read',
      args: { path: 'a.ts' },
    })

    const end = translator.onRunEnd({
      runId: 'r1',
      messages: [],
      errorMessage: 'network error',
    })
    const toolEnd = end.find((e) => e.type === 'tool' && e.phase === 'end')
    expect(toolEnd).toMatchObject({ status: 'failed' })
    const turnEnd = end.find((e) => e.type === 'turn')
    expect(turnEnd).toMatchObject({
      outcome: 'failed',
      errorMessage: 'network error',
    })
  })

  it('未知事件类型不产生事件', () => {
    const translator = new ClientEventTranslator({ sessionId: 's1' })
    translator.onRunStart({ runId: 'r1', startedAt: Date.now() })
    expect(
      translator.translate({ type: 'agent_start' } as AgentEvent),
    ).toBeNull()
    expect(
      translator.translate({ type: 'turn_start' } as AgentEvent),
    ).toBeNull()
  })
})

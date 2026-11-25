/**
 * Agent 工作台 store 的单元测试。
 *
 * 覆盖：事件归并（begin/append/end 原位更新）、seq 幂等去重、
 * 状态条与文件变更旁路分发、待回答交互的进出。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TAgentClientEvent } from '@charlie_deng/e2e-assistant-types'
import { useAgentWorkStore } from '../../src/stores/agent-work'
import type {
  ICommandTimelineItem,
  IContentTimelineItem,
  IInteractionTimelineItem,
} from '../../src/modules/agent-work/timeline'

/** 会话列表接口替身：只关心「有没有被重新拉取」。 */
const listAgentSessions = vi.hoisted(() => vi.fn(async () => []))

vi.mock('../../src/services/agent-work-api', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/agent-work-api')>()
  return { ...actual, listAgentSessions }
})

/** 构造一条最小事件（信封字段按序填充）。 */
function eventOf<
  T extends Omit<
    TAgentClientEvent,
    'sessionId' | 'blockId' | 'timestamp' | 'seq'
  >,
> (seq: number, blockId: string, payload: T): TAgentClientEvent {
  return {
    sessionId: 's1',
    blockId,
    timestamp: Date.now(),
    seq,
    ...payload,
  } as TAgentClientEvent
}

describe('agent-work store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useAgentWorkStore()
    store.sessionId = 's1'
  })

  it('归并内容块的 begin/append/end：原位更新同一组件', () => {
    const store = useAgentWorkStore()

    store.applyEvent(
      eventOf(1, 't1', {
        type: 'turn',
        phase: 'begin',
        runId: 'r1',
        inputPreview: '你好',
      }),
    )
    store.applyEvent(
      eventOf(2, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    store.applyEvent(
      eventOf(3, 'c1', { type: 'content', phase: 'append', text: '你好' }),
    )
    store.applyEvent(
      eventOf(4, 'c1', { type: 'content', phase: 'append', text: '，世界' }),
    )
    store.applyEvent(eventOf(5, 'c1', { type: 'content', phase: 'end' }))

    expect(store.items).toHaveLength(2)
    const content = store.items[1] as IContentTimelineItem
    expect(content.kind).toBe('content')
    expect(content.text).toBe('你好，世界')
    expect(content.status).toBe('done')
    expect(store.lastSeq).toBe(5)
  })

  it('seq 幂等：重复或乱序的旧事件直接丢弃', () => {
    const store = useAgentWorkStore()

    store.applyEvent(
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    store.applyEvent(
      eventOf(2, 'c1', { type: 'content', phase: 'append', text: '你好' }),
    )
    // 断线补发导致的重复事件与迟到旧事件。
    store.applyEvent(
      eventOf(2, 'c1', { type: 'content', phase: 'append', text: '你好' }),
    )
    store.applyEvent(
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )

    const content = store.items[0] as IContentTimelineItem
    expect(content.text).toBe('你好')
  })

  it('命令块：stdout/stderr 分流累积，退出码驱动成败状态', () => {
    const store = useAgentWorkStore()

    store.applyEvent(
      eventOf(1, 'cmd1', {
        type: 'command',
        phase: 'begin',
        command: 'npx playwright test',
      }),
    )
    store.applyEvent(
      eventOf(2, 'cmd1', {
        type: 'command',
        phase: 'append',
        stream: 'stdout',
        text: '5 passed',
      }),
    )
    store.applyEvent(
      eventOf(3, 'cmd1', {
        type: 'command',
        phase: 'append',
        stream: 'stderr',
        text: 'warn: slow',
      }),
    )
    store.applyEvent(
      eventOf(4, 'cmd1', {
        type: 'command',
        phase: 'end',
        exitCode: 0,
        durationMs: 8200,
      }),
    )

    const command = store.items[0] as ICommandTimelineItem
    expect(command.stdout).toBe('5 passed')
    expect(command.stderr).toBe('warn: slow')
    expect(command.exitCode).toBe(0)
    expect(command.status).toBe('done')
  })

  it('旁路事件：status 驱动状态条，file_change 进入文件变更信号', () => {
    const store = useAgentWorkStore()

    store.applyEvent(
      eventOf(1, 'status', {
        type: 'status',
        activity: 'tool_running',
        label: '打开网页',
      }),
    )
    expect(store.activity).toBe('tool_running')
    expect(store.activityLabel).toBe('打开网页')
    expect(store.items).toHaveLength(0)

    store.applyEvent(
      eventOf(2, 'file:a.ts', {
        type: 'file_change',
        operation: 'create',
        path: 'tests/a.ts',
        sourceBlockId: 'b9',
      }),
    )
    expect(store.fileChanges).toHaveLength(1)
    expect(store.fileChanges[0].path).toBe('tests/a.ts')
    expect(store.items).toHaveLength(0)
  })

  it('交互块：pending 进入待回答列表，end 后移出并定格', () => {
    const store = useAgentWorkStore()

    store.applyEvent(
      eventOf(1, 'i1', {
        type: 'interaction',
        phase: 'begin',
        interaction: {
          interactionId: 'int-1',
          kind: 'choice',
          title: '点哪个按钮？',
          options: [{ value: 'login', label: '登录' }],
        },
      }),
    )
    expect(store.pendingInteractions).toHaveLength(1)

    store.applyEvent(
      eventOf(2, 'i1', {
        type: 'interaction',
        phase: 'end',
        interactionId: 'int-1',
        answer: 'login',
        answeredBy: 'user',
      }),
    )
    expect(store.pendingInteractions).toHaveLength(0)

    const interaction = store.items[0] as IInteractionTimelineItem
    expect(interaction.status).toBe('answered')
    expect(interaction.answer).toBe('login')
  })

  /**
   * 会话列表的状态是**服务端字段**，只在拉取的那一刻定格。若不在一轮结束时
   * 重新拉取，列表会一直显示「运行中」——对话明明已经结束，左侧却还转着。
   */
  it('一轮结束（activity 回落 idle）时刷新会话列表', () => {
    const store = useAgentWorkStore()
    listAgentSessions.mockClear()

    // 真实顺序：turn begin → status(thinking)（活动态由此进入）。
    store.applyEvent(
      eventOf(1, 't1', {
        type: 'turn',
        phase: 'begin',
        runId: 'r1',
        inputPreview: '跑一下测试',
      }),
    )
    store.applyEvent(
      eventOf(2, 'status', { type: 'status', activity: 'thinking' }),
    )
    expect(store.activity).not.toBe('idle')
    expect(listAgentSessions).not.toHaveBeenCalled()

    // 轮次收尾：turn end + status(idle)。
    store.applyEvent(
      eventOf(3, 't1', {
        type: 'turn',
        phase: 'end',
        runId: 'r1',
        outcome: 'completed',
      }),
    )
    store.applyEvent(eventOf(4, 'status', { type: 'status', activity: 'idle' }))

    expect(store.activity).toBe('idle')
    expect(listAgentSessions).toHaveBeenCalledTimes(1)
  })

  it('轮次进行中的事件不触发列表刷新（避免一轮内反复请求）', () => {
    const store = useAgentWorkStore()
    listAgentSessions.mockClear()

    store.applyEvent(
      eventOf(1, 't1', {
        type: 'turn',
        phase: 'begin',
        runId: 'r1',
        inputPreview: '跑一下',
      }),
    )
    store.applyEvent(
      eventOf(2, 'status', { type: 'status', activity: 'thinking' }),
    )
    store.applyEvent(
      eventOf(3, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    store.applyEvent(
      eventOf(4, 'c1', { type: 'content', phase: 'append', text: '好的' }),
    )
    // 新一轮开始（activity 仍是 thinking，不是 idle）也不刷新。
    store.applyEvent(
      eventOf(5, 'status', { type: 'status', activity: 'writing' }),
    )

    expect(listAgentSessions).not.toHaveBeenCalled()
  })

  it('非当前会话的事件被忽略', () => {
    const store = useAgentWorkStore()
    const foreign = {
      ...eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown' as const,
      }),
      sessionId: 'other',
    }
    store.applyEvent(foreign as TAgentClientEvent)
    expect(store.items).toHaveLength(0)
    expect(store.lastSeq).toBe(0)
  })
})

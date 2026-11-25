/**
 * 会话事件总线与工作块存储的单元测试。
 *
 * 覆盖：seq 单调分配与重启恢复、断线补发（afterSeq）、
 * 取消订阅、物化落盘（内容累积 / 会话状态流转 / 瞬态事件忽略）。
 */
import { describe, expect, it } from 'vitest'
import type {
  TAgentClientEvent,
  TAgentClientEventDraft,
} from '@fynn90-e2e_assistant/types'
import { createSessionEventBus } from '../../src/agent-runtime/session-event-bus'
import { createWorkBlockStore } from '../../src/agent-runtime/work-block-store'

/** 构造一条最小内容块事件草稿。 */
function contentDraft (
  sessionId: string,
  blockId: string,
  text: string,
): TAgentClientEventDraft {
  return {
    sessionId,
    blockId,
    timestamp: Date.now(),
    type: 'content',
    phase: 'append',
    text,
  }
}

describe('SessionEventBus', () => {
  it('为同一会话分配单调递增的 seq', () => {
    const bus = createSessionEventBus({
      blockStore: createWorkBlockStore({ dbPath: ':memory:' }),
    })
    const first = bus.publish(contentDraft('s1', 'b1', 'a'))
    const second = bus.publish(contentDraft('s1', 'b1', 'b'))
    const other = bus.publish(contentDraft('s2', 'b2', 'x'))

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(other.seq).toBe(1)
    expect(bus.currentSeq('s1')).toBe(2)
  })

  it('订阅时按 afterSeq 补发缺口后进入实时推送', () => {
    const bus = createSessionEventBus({
      blockStore: createWorkBlockStore({ dbPath: ':memory:' }),
    })
    bus.publish(contentDraft('s1', 'b1', 'a'))
    bus.publish(contentDraft('s1', 'b1', 'b'))

    const received: TAgentClientEvent[] = []
    bus.subscribe('s1', 1, (event) => received.push(event))
    bus.publish(contentDraft('s1', 'b1', 'c'))

    // 补发 seq=2，实时收到 seq=3；seq=1 不重发。
    expect(received.map((event) => event.seq)).toEqual([2, 3])
  })

  it('取消订阅后不再接收事件', () => {
    const bus = createSessionEventBus({
      blockStore: createWorkBlockStore({ dbPath: ':memory:' }),
    })
    const received: TAgentClientEvent[] = []
    const unsubscribe = bus.subscribe('s1', undefined, (event) =>
      received.push(event),
    )

    bus.publish(contentDraft('s1', 'b1', 'a'))
    unsubscribe()
    bus.publish(contentDraft('s1', 'b1', 'b'))

    expect(received).toHaveLength(1)
  })

  it('新总线从物化存储恢复 seq，保证重启后序号连续', () => {
    const blockStore = createWorkBlockStore({ dbPath: ':memory:' })
    const first = createSessionEventBus({ blockStore })
    first.publish(contentDraft('s1', 'b1', 'a'))
    first.publish(contentDraft('s1', 'b1', 'b'))

    // 模拟进程重启：同一存储新建总线，序号从 2 继续。
    const second = createSessionEventBus({ blockStore })
    const event = second.publish(contentDraft('s1', 'b1', 'c'))
    expect(event.seq).toBe(3)
  })
})

describe('WorkBlockStore', () => {
  it('物化轮次与内容块：文本累积、会话状态流转', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    const bus = createSessionEventBus({ blockStore: store })

    bus.publish({
      sessionId: 's1',
      blockId: 'turn1',
      timestamp: Date.now(),
      type: 'turn',
      phase: 'begin',
      runId: 'r1',
      inputPreview: '帮我写一个登录测试',
    })
    bus.publish({
      sessionId: 's1',
      blockId: 'c1',
      timestamp: Date.now(),
      type: 'content',
      phase: 'begin',
      contentType: 'markdown',
    })
    bus.publish(contentDraft('s1', 'c1', '你好'))
    bus.publish(contentDraft('s1', 'c1', '，世界'))
    bus.publish({
      sessionId: 's1',
      blockId: 'c1',
      timestamp: Date.now(),
      type: 'content',
      phase: 'end',
    })
    bus.publish({
      sessionId: 's1',
      blockId: 'turn1',
      timestamp: Date.now(),
      type: 'turn',
      phase: 'end',
      runId: 'r1',
      outcome: 'succeeded',
    })

    const blocks = store.listBlocks('s1')
    expect(blocks).toHaveLength(2)

    const content = blocks.find((block) => block.blockId === 'c1')
    expect(content?.kind).toBe('content')
    expect(content?.status).toBe('done')
    expect(content?.payload.text).toBe('你好，世界')

    const sessions = store.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title).toBe('帮我写一个登录测试')
    expect(sessions[0].status).toBe('idle')
  })

  it('瞬态事件（status / file_change / heartbeat）不落盘', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    const bus = createSessionEventBus({ blockStore: store })

    bus.publish({
      sessionId: 's1',
      blockId: 'status',
      timestamp: Date.now(),
      type: 'status',
      activity: 'thinking',
    })
    bus.publish({
      sessionId: 's1',
      blockId: 'file:a.ts',
      timestamp: Date.now(),
      type: 'file_change',
      operation: 'create',
      path: 'a.ts',
    })

    expect(store.listBlocks('s1')).toHaveLength(0)
    // 瞬态事件不产生物化块，但 seq 仍被推进（序号连续性不受存储影响）。
    expect(bus.currentSeq('s1')).toBe(2)
  })

  it('交互块 pending 状态持久化，end 后定格为 answered', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    const bus = createSessionEventBus({ blockStore: store })

    bus.publish({
      sessionId: 's1',
      blockId: 'i1',
      timestamp: Date.now(),
      type: 'interaction',
      phase: 'begin',
      interaction: {
        interactionId: 'int-1',
        kind: 'choice',
        title: '选择要点击的按钮',
        options: [
          { value: 'login', label: '登录' },
          { value: 'register', label: '注册' },
        ],
      },
    })

    let interaction = store.listBlocks('s1')[0]
    expect(interaction.status).toBe('pending')

    bus.publish({
      sessionId: 's1',
      blockId: 'i1',
      timestamp: Date.now(),
      type: 'interaction',
      phase: 'end',
      interactionId: 'int-1',
      answer: 'login',
      answeredBy: 'user',
    })

    interaction = store.listBlocks('s1')[0]
    expect(interaction.status).toBe('answered')
    expect(interaction.payload.answer).toBe('login')
  })
})

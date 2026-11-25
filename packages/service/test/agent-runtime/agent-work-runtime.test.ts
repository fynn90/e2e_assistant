/**
 * 工作块存储的会话种类（kind）单元测试。
 *
 * 覆盖：种类声明与默认值、按种类过滤会话列表、事件推进不覆写种类、
 * 以及未注册会话的兜底行为——这些是「生成任务不污染工作台会话列表」的依据。
 */
import { describe, expect, it } from 'vitest'
import type { TAgentClientEvent } from '@charlie_deng/e2e-assistant-types'
import { createWorkBlockStore } from '../../src/agent-runtime/work-block-store'

/** 自增序号：store.applyEvent 要求事件带 seq（总线发布时分配）。 */
let nextSeq = 1

/** 构造一条最小内容块事件（用于推进会话行）。 */
function contentEvent (sessionId: string, text: string): TAgentClientEvent {
  return {
    sessionId,
    blockId: 'block-1',
    seq: nextSeq++,
    timestamp: Date.now(),
    type: 'content',
    phase: 'append',
    text,
  }
}

/** 构造一条轮次开始事件（带输入预览，用于验证标题来源）。 */
function turnBeginEvent (
  sessionId: string,
  inputPreview: string,
): TAgentClientEvent {
  return {
    sessionId,
    blockId: 'turn-1',
    seq: nextSeq++,
    timestamp: Date.now(),
    type: 'turn',
    phase: 'begin',
    runId: 'run-1',
    inputPreview,
  }
}

/** 构造一条待办块事件（v12-pre，整体替换语义）。 */
function todoEvent (
  sessionId: string,
  items: Array<{
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
  }>,
): TAgentClientEvent {
  return {
    sessionId,
    blockId: 'todo-1',
    seq: nextSeq++,
    timestamp: Date.now(),
    type: 'todo',
    phase: 'begin',
    items,
  }
}

describe('WorkBlockStore 待办块物化（v12-pre）', () => {
  it('待办事件物化为 todo 块并在历史查询可见', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('s1', 'generation')

    store.applyEvent(
      todoEvent('s1', [
        { id: 'step_1', content: '登录', status: 'in_progress' },
        { id: 'step_2', content: '打开列表', status: 'pending' },
      ]),
    )

    const blocks = store.listBlocks('s1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'todo',
      status: 'done',
      payload: {
        items: [
          { id: 'step_1', content: '登录', status: 'in_progress' },
          { id: 'step_2', content: '打开列表', status: 'pending' },
        ],
      },
    })
  })

  it('同一块的后续事件整体替换清单（不累积）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('s1', 'generation')

    store.applyEvent(
      todoEvent('s1', [{ id: 'step_1', content: '登录', status: 'pending' }]),
    )
    store.applyEvent(
      todoEvent('s1', [{ id: 'step_1', content: '登录', status: 'completed' }]),
    )

    const blocks = store.listBlocks('s1')
    // 同一 blockId 只有一行，且 payload 是最后一次的完整清单。
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.payload.items).toEqual([
      { id: 'step_1', content: '登录', status: 'completed' },
    ])
  })
})

describe('WorkBlockStore 会话种类', () => {
  it('报告卡片物化为 workbench_report 块（v16 RPT-2/RPT-3）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('report-1', 'chat')
    store.applyEvent({
      sessionId: 'report-1',
      blockId: 'blk_report_exec-1',
      seq: nextSeq++,
      timestamp: Date.now(),
      type: 'workbench_report',
      phase: 'begin',
      executionId: 'exec-1',
      skillId: 'abc123456',
      skillTitle: '云7登录',
      taskStatus: 'completed',
      summary: { total: 1, passed: 1, failed: 0, runId: 'r1' },
    } as TAgentClientEvent)

    const blocks = store.listBlocks('report-1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'workbench_report',
      status: 'done',
      payload: {
        executionId: 'exec-1',
        taskStatus: 'completed',
        summary: { total: 1, passed: 1, runId: 'r1' },
      },
    })
    store.close()
  })

  it('声明 kind 后可按种类过滤会话列表', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('chat-1', 'chat')
    store.registerSession('gen-1', 'generation')
    store.applyEvent(contentEvent('chat-1', 'a'))
    store.applyEvent(contentEvent('gen-1', 'b'))

    expect(
      store
        .listSessions()
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual(['chat-1', 'gen-1'])
    expect(
      store.listSessions({ kind: 'chat' }).map((session) => session.sessionId),
    ).toEqual(['chat-1'])
    expect(
      store
        .listSessions({ kind: 'generation' })
        .map((session) => session.sessionId),
    ).toEqual(['gen-1'])
    store.close()
  })

  it('会话种类出现在返回的会话概要中', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('gen-2', 'generation')
    store.applyEvent(contentEvent('gen-2', 'x'))

    expect(store.listSessions()[0]?.kind).toBe('generation')
    store.close()
  })

  it('后续事件不覆写已声明的种类', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('gen-3', 'generation')
    // 多个事件依次推进会话行，kind 应保持不变（事件驱动 upsert 不触碰 kind）。
    store.applyEvent(contentEvent('gen-3', 'a'))
    store.applyEvent(turnBeginEvent('gen-3', '生成 SKILL.md'))
    store.applyEvent(contentEvent('gen-3', 'b'))

    const session = store
      .listSessions()
      .find((item) => item.sessionId === 'gen-3')
    expect(session?.kind).toBe('generation')
    expect(session?.title).toBe('生成 SKILL.md')
    store.close()
  })

  it('未声明种类的会话按事件到达即建行，默认种类为 chat', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    // 直接落事件而不先 registerSession：模拟既有调用路径与旧行为。
    store.applyEvent(contentEvent('implicit-1', 'a'))

    expect(store.listSessions()[0]?.kind).toBe('chat')
    store.close()
  })

  it('重复声明种类以最后一次为准', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('s-1', 'chat')
    store.registerSession('s-1', 'generation')

    expect(store.listSessions()[0]?.kind).toBe('generation')
    store.close()
  })
})

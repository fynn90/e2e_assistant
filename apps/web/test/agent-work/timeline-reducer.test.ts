/**
 * 工作时间线归约器的纯函数单元测试。
 *
 * 覆盖：各类事件的建块 / 补块、seq 幂等去重、旁路事件分流、
 * 历史块还原（blockToTimelineItem）——这些是工作台与生成弹窗共用的语义，
 * 因此独立于 store 与组件测试。
 */
import { describe, expect, it } from 'vitest'
import type {
  IAgentWorkBlock,
  TAgentClientEvent,
} from '@charlie_deng/e2e-assistant-types'
import {
  applyEventToTimeline,
  blockToTimelineItem,
  clearTimeline,
  createTimelineState,
  resetWithBlocks,
  type ITimelineState,
} from '../../src/modules/agent-work/timeline'

/**
 * 分发式 Omit：对联合类型的每个成员分别 Omit。
 *
 * 直接对联合用 Omit 会把各分支折叠成一个成员，导致载荷字段全部丢失。
 */
type TDistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

/** 事件载荷（剥离信封字段后的判别联合）。 */
type TEventPayload = TDistributiveOmit<
  TAgentClientEvent,
  'sessionId' | 'seq' | 'blockId' | 'timestamp'
>

/**
 * 构造一条带完整信封的事件。
 *
 * @param seq - 事件序号（决定幂等去重行为）。
 * @param blockId - 工作块 ID。
 * @param payload - 事件载荷（不含信封字段）。
 * @returns 可直接交由归约器处理的事件。
 * @throws 不抛出异常。
 */
function eventOf (
  seq: number,
  blockId: string,
  payload: TEventPayload,
): TAgentClientEvent {
  return {
    sessionId: 's1',
    blockId,
    seq,
    timestamp: 1000 + seq,
    ...payload,
  } as TAgentClientEvent
}

/** 应用一串事件并返回归约状态。 */
function reduce (
  events: TAgentClientEvent[],
  state = createTimelineState(),
): ITimelineState {
  for (const event of events) applyEventToTimeline(state, event)
  return state
}

describe('工作台报告卡片（v16）', () => {
  it('报告块建为独立的 workbench_report 项，与执行卡片平级', () => {
    const state = reduce([
      eventOf(1, 'task-1', {
        type: 'workbench_task',
        phase: 'begin',
        taskId: 'exec-1',
        taskKind: 'execution',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        status: 'completed',
        startedAt: 1000,
        executionId: 'exec-1',
      }),
      eventOf(2, 'report-1', {
        type: 'workbench_report',
        phase: 'begin',
        executionId: 'exec-1',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        taskStatus: 'completed',
        summary: { total: 1, passed: 1, failed: 0, runId: 'r1' },
      }),
    ])

    // 两张平级卡片，顺序即 seq：执行卡片在前、报告卡片在后。
    expect(state.items).toHaveLength(2)
    expect(state.items[0]).toMatchObject({ kind: 'workbench_task' })
    expect(state.items[1]).toMatchObject({
      kind: 'workbench_report',
      executionId: 'exec-1',
      taskStatus: 'completed',
      status: 'done',
      summary: { total: 1, passed: 1, failed: 0, runId: 'r1' },
    })
  })

  it('历史块还原：报告卡片从物化 payload 复原（LOG-2）', () => {
    const block: IAgentWorkBlock = {
      sessionId: 's1',
      blockId: 'report-1',
      seq: 2,
      runId: 'r1',
      kind: 'workbench_report',
      status: 'done',
      payload: {
        executionId: 'exec-1',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        taskStatus: 'completed',
        summary: { total: 2, passed: 2, failed: 0, runId: 'r2' },
      },
      createdAt: 1,
      updatedAt: 1,
    }

    expect(blockToTimelineItem(block)).toMatchObject({
      kind: 'workbench_report',
      executionId: 'exec-1',
      taskStatus: 'completed',
      summary: { total: 2, passed: 2, runId: 'r2' },
    })
  })
})

describe('时间线归约器', () => {
  it('思考块：begin 建块，append 累积文本，end 定型并记录耗时', () => {
    const state = reduce([
      eventOf(1, 't1', { type: 'thinking', phase: 'begin' }),
      eventOf(2, 't1', { type: 'thinking', phase: 'append', text: '先看用例' }),
      eventOf(3, 't1', {
        type: 'thinking',
        phase: 'append',
        text: '，再写文档',
      }),
      eventOf(4, 't1', { type: 'thinking', phase: 'end', durationMs: 1200 }),
    ])

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'thinking',
      blockId: 't1',
      status: 'done',
      text: '先看用例，再写文档',
      durationMs: 1200,
    })
  })

  it('工具块：begin 建块，append 追加进度，end 记录摘要与成败', () => {
    const state = reduce([
      eventOf(1, 'b1', {
        type: 'tool',
        phase: 'begin',
        tool: {
          category: 'skill',
          action: 'skill',
          title: '加载技能',
          subtitle: 'test_case_Skill_document',
          toolName: 'load_skill',
        },
      }),
      eventOf(2, 'b1', { type: 'tool', phase: 'append', text: '读取中' }),
      eventOf(3, 'b1', {
        type: 'tool',
        phase: 'end',
        status: 'succeeded',
        summary: '已加载',
        durationMs: 30,
      }),
    ])

    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      category: 'skill',
      title: '加载技能',
      subtitle: 'test_case_Skill_document',
      toolName: 'load_skill',
      text: '读取中',
      summary: '已加载',
      status: 'done',
    })
  })

  it('工具块失败时状态为 failed', () => {
    const state = reduce([
      eventOf(1, 'b1', {
        type: 'tool',
        phase: 'begin',
        tool: {
          category: 'file',
          action: 'write',
          title: '写入文件',
          toolName: 'write',
        },
      }),
      eventOf(2, 'b1', {
        type: 'tool',
        phase: 'end',
        status: 'failed',
        summary: '被守卫拦截',
        durationMs: 5,
      }),
    ])

    expect(state.items[0]).toMatchObject({
      status: 'failed',
      summary: '被守卫拦截',
    })
  })

  it('待办块：begin 携带完整清单，再次到达时整体替换', () => {
    const state = reduce([
      eventOf(1, 'todo1', {
        type: 'todo',
        phase: 'begin',
        items: [
          { id: 's1', content: '登录', status: 'in_progress' },
          { id: 's2', content: '打开列表', status: 'pending' },
        ],
      }),
      // 第二次更新（新块）：整体替换语义，时间线保留两块以便回看计划演进。
      eventOf(2, 'todo2', {
        type: 'todo',
        phase: 'begin',
        items: [
          { id: 's1', content: '登录', status: 'completed' },
          { id: 's2', content: '打开列表', status: 'in_progress' },
        ],
      }),
    ])

    expect(state.items).toHaveLength(2)
    expect(state.items[0]).toMatchObject({
      kind: 'todo',
      items: [
        { id: 's1', status: 'in_progress' },
        { id: 's2', status: 'pending' },
      ],
    })
    expect(state.items[1]).toMatchObject({
      kind: 'todo',
      items: [
        { id: 's1', status: 'completed' },
        { id: 's2', status: 'in_progress' },
      ],
    })
  })

  it('待办块：同一 blockId 的后续事件原地替换清单', () => {
    const state = reduce([
      eventOf(1, 'todo1', {
        type: 'todo',
        phase: 'begin',
        items: [{ id: 's1', content: '登录', status: 'pending' }],
      }),
      eventOf(2, 'todo1', {
        type: 'todo',
        phase: 'begin',
        items: [{ id: 's1', content: '登录', status: 'completed' }],
      }),
    ])

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'todo',
      items: [{ id: 's1', status: 'completed' }],
    })
  })

  it('工具块的图片引用在 end 事件到达后挂到项上', () => {
    const state = reduce([
      eventOf(1, 'b1', {
        type: 'tool',
        phase: 'begin',
        tool: {
          category: 'browser',
          action: 'screenshot',
          title: '页面截图',
          toolName: 'browser_screenshot',
        },
      }),
      eventOf(2, 'b1', {
        type: 'tool',
        phase: 'end',
        status: 'succeeded',
        summary: '已截取',
        durationMs: 120,
        image: {
          url: '/api/skills/abc123456/exploration/s1/1758400000000-00.png',
          mimeType: 'image/png',
          width: 800,
          height: 600,
        },
      }),
    ])

    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      image: {
        url: '/api/skills/abc123456/exploration/s1/1758400000000-00.png',
        width: 800,
        height: 600,
      },
    })
  })

  it('内容块：begin 建块，append 累积，end 定型', () => {
    const state = reduce([
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
      eventOf(2, 'c1', { type: 'content', phase: 'append', text: '你好' }),
      eventOf(3, 'c1', { type: 'content', phase: 'append', text: '，世界' }),
      eventOf(4, 'c1', { type: 'content', phase: 'end' }),
    ])

    expect(state.items[0]).toMatchObject({
      kind: 'content',
      contentType: 'markdown',
      text: '你好，世界',
      status: 'done',
    })
  })

  it('命令块：stdout / stderr 分流，退出码驱动成败', () => {
    const state = reduce([
      eventOf(1, 'cmd', {
        type: 'command',
        phase: 'begin',
        command: 'npx playwright test',
      }),
      eventOf(2, 'cmd', {
        type: 'command',
        phase: 'append',
        stream: 'stdout',
        text: '5 passed',
      }),
      eventOf(3, 'cmd', {
        type: 'command',
        phase: 'append',
        stream: 'stderr',
        text: 'warn',
      }),
      eventOf(4, 'cmd', {
        type: 'command',
        phase: 'end',
        exitCode: 0,
        durationMs: 900,
      }),
    ])

    expect(state.items[0]).toMatchObject({
      kind: 'command',
      stdout: '5 passed',
      stderr: 'warn',
      exitCode: 0,
      status: 'done',
    })
  })

  it('多个块按到达顺序排列，块内更新不新增项', () => {
    const state = reduce([
      eventOf(1, 'a', { type: 'thinking', phase: 'begin' }),
      eventOf(2, 'b', {
        type: 'tool',
        phase: 'begin',
        tool: {
          category: 'skill',
          action: 'skill',
          title: '加载技能',
          toolName: 'load_skill',
        },
      }),
      eventOf(3, 'a', { type: 'thinking', phase: 'end', durationMs: 10 }),
      eventOf(4, 'b', {
        type: 'tool',
        phase: 'end',
        status: 'succeeded',
        durationMs: 5,
      }),
    ])

    expect(state.items.map((item) => item.blockId)).toEqual(['a', 'b'])
    expect(state.items[0]).toMatchObject({ kind: 'thinking', status: 'done' })
    expect(state.items[1]).toMatchObject({ kind: 'tool', status: 'done' })
  })

  it('seq 幂等：重复或乱序的旧事件直接丢弃', () => {
    const state = reduce([
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
      eventOf(2, 'c1', { type: 'content', phase: 'append', text: '你好' }),
      // 重复与回退事件应被丢弃
      eventOf(2, 'c1', { type: 'content', phase: 'append', text: '你好' }),
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    ])

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ text: '你好' })
    expect(state.lastSeq).toBe(2)
  })

  it('旁路事件：status 驱动状态条，file_change 进入文件变更信号', () => {
    const state = reduce([
      eventOf(1, 'status', {
        type: 'status',
        activity: 'tool_running',
        label: '写入 SKILL.md',
      }),
      eventOf(2, 'fc', {
        type: 'file_change',
        operation: 'update',
        path: 'skill/SKILL.md',
      }),
    ])

    expect(state.activity).toBe('tool_running')
    expect(state.activityLabel).toBe('写入 SKILL.md')
    expect(state.items).toHaveLength(0) // 旁路事件不进时间线
    expect(state.fileChanges).toHaveLength(1)
    expect(state.fileChanges[0]).toMatchObject({
      operation: 'update',
      path: 'skill/SKILL.md',
    })
  })

  it('heartbeat 消耗序号但不产生任何可见项', () => {
    const state = reduce([
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
      eventOf(2, 'hb', { type: 'heartbeat' }),
    ])

    expect(state.items).toHaveLength(1)
    expect(state.lastSeq).toBe(2)
  })

  it('交互块：pending 进入时间线，end 后定格为已回答', () => {
    const state = reduce([
      eventOf(1, 'i1', {
        type: 'interaction',
        phase: 'begin',
        interaction: {
          interactionId: 'ask-1',
          kind: 'confirm',
          title: '是否覆盖 SKILL.md',
        },
      }),
    ])
    expect(state.items[0]).toMatchObject({
      kind: 'interaction',
      status: 'pending',
    })

    applyEventToTimeline(
      state,
      eventOf(2, 'i1', {
        type: 'interaction',
        phase: 'end',
        interactionId: 'ask-1',
        answer: 'yes',
        answeredBy: 'user',
      }),
    )
    expect(state.items[0]).toMatchObject({ status: 'answered', answer: 'yes' })
  })

  it('clearTimeline 就地清空，保持引用有效', () => {
    const state = reduce([
      eventOf(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    ])
    const itemsRef = state.items

    clearTimeline(state)

    // 原地清空：外部持有的数组引用仍有效（store 的响应式绑定依赖这点）
    expect(state.items).toBe(itemsRef)
    expect(state.items).toHaveLength(0)
    expect(state.lastSeq).toBe(0)
    expect(state.activity).toBe('idle')
  })

  it('resetWithBlocks 还原历史块并设置当前序号', () => {
    const state = createTimelineState()
    const blocks: IAgentWorkBlock[] = [
      {
        sessionId: 's1',
        blockId: 'h1',
        seq: 1,
        runId: 'r1',
        kind: 'thinking',
        status: 'done',
        payload: { text: '历史思考', durationMs: 800 },
        createdAt: 1,
        updatedAt: 2,
      },
      {
        sessionId: 's1',
        blockId: 'h2',
        seq: 2,
        runId: 'r1',
        kind: 'tool',
        status: 'done',
        payload: {
          category: 'file',
          title: '写入文件',
          subtitle: 'skill/SKILL.md',
          toolName: 'write',
        },
        createdAt: 2,
        updatedAt: 3,
      },
    ]

    resetWithBlocks(state, blocks, 9)

    expect(state.items).toHaveLength(2)
    expect(state.items[0]).toMatchObject({ kind: 'thinking', text: '历史思考' })
    expect(state.items[1]).toMatchObject({ kind: 'tool', title: '写入文件' })
    expect(state.lastSeq).toBe(9)

    // 历史恢复后，seq <= 9 的旧事件仍被幂等丢弃
    applyEventToTimeline(
      state,
      eventOf(9, 'h2', { type: 'tool', phase: 'append', text: 'x' }),
    )
    expect((state.items[1] as { text: string }).text).toBe('')
  })

  it('blockToTimelineItem 缺失字段时按缺省值兜底', () => {
    const item = blockToTimelineItem({
      sessionId: 's1',
      blockId: 'b1',
      seq: 1,
      runId: 'r1',
      kind: 'tool',
      status: 'done',
      payload: {},
      createdAt: 1,
      updatedAt: 1,
    })

    expect(item).toMatchObject({
      kind: 'tool',
      category: 'other',
      title: '',
      toolName: '',
      text: '',
    })
  })

  it('blockToTimelineItem 还原待办块，payload 非法时按空清单兜底', () => {
    const restored = blockToTimelineItem({
      sessionId: 's1',
      blockId: 'b1',
      seq: 1,
      runId: 'r1',
      kind: 'todo',
      status: 'done',
      payload: { items: [{ id: 's1', content: '登录', status: 'completed' }] },
      createdAt: 1,
      updatedAt: 1,
    })

    expect(restored).toMatchObject({
      kind: 'todo',
      items: [{ id: 's1', content: '登录', status: 'completed' }],
    })

    // items 非数组（脏数据）时不抛错，退化为空清单。
    const fallback = blockToTimelineItem({
      sessionId: 's1',
      blockId: 'b2',
      seq: 2,
      runId: 'r1',
      kind: 'todo',
      status: 'done',
      payload: { items: 'not-an-array' },
      createdAt: 1,
      updatedAt: 1,
    })
    expect(fallback).toMatchObject({ kind: 'todo', items: [] })
  })
})

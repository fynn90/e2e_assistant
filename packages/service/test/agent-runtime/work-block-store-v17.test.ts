/**
 * 工作块存储对 v17 两个新块的物化（§4.6 / §6.2 / §6.3）。
 *
 * 这一层是**历史回看的唯一数据来源**：卡片的状态变化靠「同一 blockId 重发」
 * 表达，存储若把块拆成两条，回看时用户会看到两张半截卡片；若漏物化某个字段，
 * 卡片会定格在 pending 或丢失人话对照。因此逐项锁定。
 */
import { describe, expect, it } from 'vitest'
import { createWorkBlockStore } from '../../src/agent-runtime/work-block-store'
import type { TAgentClientEvent } from '@fynn90-e2e_assistant/types'

/** 造一条带信封的事件。 */
function createEvent (
  payload: Record<string, unknown>,
  seq: number,
): TAgentClientEvent {
  return {
    sessionId: 'sess-1',
    seq,
    blockId: String(payload.__blockId),
    timestamp: 1000 + seq,
    ...payload,
  } as TAgentClientEvent
}

describe('workbench_view 的物化（v17）', () => {
  it('发布即终态，payload 整体物化（前端按 viewKind 窄化）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('sess-1', 'chat')

    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_view_1',
          type: 'workbench_view',
          phase: 'begin',
          viewId: 'view-1',
          viewKind: 'skill-list',
          skillId: null,
          payload: { rows: [{ skillId: 'a' }], total: 1 },
        },
        1,
      ),
    )

    const blocks = store.listBlocks('sess-1')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('workbench_view')
    expect(blocks[0]?.status).toBe('done')
    expect(blocks[0]?.payload.viewKind).toBe('skill-list')
    expect(blocks[0]?.payload.payload).toEqual({
      rows: [{ skillId: 'a' }],
      total: 1,
    })

    store.close()
  })

  it('同一 viewId 重发 → 原位更新（清单卡筛选后走这条路）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('sess-1', 'chat')

    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_view_1',
          type: 'workbench_view',
          phase: 'begin',
          viewId: 'view-1',
          viewKind: 'skill-list',
          skillId: null,
          payload: { rows: [], total: 0 },
        },
        1,
      ),
    )
    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_view_1',
          type: 'workbench_view',
          phase: 'begin',
          viewId: 'view-1',
          viewKind: 'skill-list',
          skillId: null,
          payload: { rows: [{ skillId: 'b' }], total: 1 },
        },
        2,
      ),
    )

    const blocks = store.listBlocks('sess-1')
    // **一个块**，不是两个（否则时间线上会出现两张清单卡）。
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.payload.payload).toEqual({
      rows: [{ skillId: 'b' }],
      total: 1,
    })

    store.close()
  })
})

describe('workbench_proposal 的物化（v17）', () => {
  it('创建时 pending，终态以同一 blockId 覆盖并带上原因', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('sess-1', 'chat')

    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_proposal_p1',
          type: 'workbench_proposal',
          phase: 'begin',
          proposalId: 'p1',
          proposalKind: 'report-cleanup',
          skillId: 'abc123456',
          skillTitle: '云7登录',
          label: '删除 6 份报告',
          description: '删除后不可撤销。',
          state: 'pending',
          changes: [{ target: '报告 1', op: 'remove' }],
          requiresModalConfirm: true,
        },
        1,
      ),
    )

    let block = store.listBlocks('sess-1')[0]
    expect(block?.kind).toBe('workbench_proposal')
    expect(block?.status).toBe('pending')
    expect(block?.payload.state).toBe('pending')
    // 二次弹框的规则字段必须落盘——回看时按钮的行为靠它。
    expect(block?.payload.requiresModalConfirm).toBe(true)

    // 终态：同 blockId 重发。
    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_proposal_p1',
          type: 'workbench_proposal',
          phase: 'begin',
          proposalId: 'p1',
          proposalKind: 'report-cleanup',
          skillId: 'abc123456',
          skillTitle: '云7登录',
          label: '删除 6 份报告',
          state: 'applied',
          requiresModalConfirm: true,
          resultMessage: '已删除 6 份报告。',
        },
        2,
      ),
    )

    block = store.listBlocks('sess-1')[0]
    expect(store.listBlocks('sess-1')).toHaveLength(1)
    expect(block?.status).toBe('done')
    expect(block?.payload.state).toBe('applied')
    expect(block?.payload.resultMessage).toBe('已删除 6 份报告。')

    store.close()
  })

  it('env-fill 只物化 key 与用途（**永不出现值**，D7）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('sess-1', 'chat')

    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_proposal_p2',
          type: 'workbench_proposal',
          phase: 'begin',
          proposalId: 'p2',
          proposalKind: 'env-fill',
          skillId: 'abc123456',
          skillTitle: '云7登录',
          label: '环境变量补齐',
          state: 'pending',
          envKeys: [{ key: 'E2E_PASSWORD', usage: '登录时填写' }],
          requiresModalConfirm: false,
        },
        1,
      ),
    )

    const serialized = JSON.stringify(store.listBlocks('sess-1'))
    expect(serialized).toContain('E2E_PASSWORD')
    // 契约里根本没有放值的字段——物化后的负载同样不可能有。
    expect(serialized).not.toContain('envValues')

    store.close()
  })
})

describe('workbench_task 的 batch 分支（v17）', () => {
  it('批次状态与条目清单一并物化（历史回看的汇总依赖它）', () => {
    const store = createWorkBlockStore({ dbPath: ':memory:' })
    store.registerSession('sess-1', 'chat')

    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_task_b1',
          type: 'workbench_task',
          phase: 'begin',
          taskId: 'b1',
          taskKind: 'batch',
          skillId: 'abc123456',
          skillTitle: '云7登录',
          status: 'running',
          startedAt: 1000,
          batchStatus: 'running',
          items: [
            { skillId: 'abc123456', skillTitle: 'A', status: 'passed' },
            { skillId: 'def123456', skillTitle: 'B', status: 'pending' },
          ],
          batchLimit: 10,
        },
        1,
      ),
    )

    let block = store.listBlocks('sess-1')[0]
    expect(block?.status).toBe('streaming')
    expect(block?.payload.batchStatus).toBe('running')
    expect(block?.payload.batchLimit).toBe(10)
    expect((block?.payload.items as unknown[]) ?? []).toHaveLength(2)

    // 终态：同一 blockId 更新为 completed。
    store.applyEvent(
      createEvent(
        {
          __blockId: 'blk_task_b1',
          type: 'workbench_task',
          phase: 'begin',
          taskId: 'b1',
          taskKind: 'batch',
          skillId: 'abc123456',
          skillTitle: '云7登录',
          status: 'completed',
          startedAt: 1000,
          batchStatus: 'completed',
          items: [
            { skillId: 'abc123456', skillTitle: 'A', status: 'passed' },
            { skillId: 'def123456', skillTitle: 'B', status: 'failed' },
          ],
          batchLimit: 10,
        },
        2,
      ),
    )

    block = store.listBlocks('sess-1')[0]
    expect(store.listBlocks('sess-1')).toHaveLength(1)
    expect(block?.status).toBe('done')
    expect(block?.payload.batchStatus).toBe('completed')

    store.close()
  })
})

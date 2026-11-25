/**
 * v17 卡片测试的共用构造器。
 *
 * 为什么抽成独立文件：`workbench_view` / `workbench_proposal` / `workbench_task(batch)`
 * 三种卡片被两组测试文件共用（`WorkbenchV17Views.test.ts` 与
 * `WorkbenchV17Cards.test.ts`），各自复制一份构造器会让字段口径随时间分叉
 * ——例如某天 `workspace` 里加了必填字段，只改一处就会让另一处静默失效。
 *
 * 构造器一律走**归约器的真实创建路径**（`createWorkbenchXxxItem`），而不是手写
 * 字面量对象：这样事件 → 项 的字段映射（含 v17 新增字段）顺带被锁住。
 */
import type { TAgentClientEvent } from '@charlie_deng/e2e-assistant-types'
import {
  createWorkbenchProposalItem,
  createWorkbenchTaskItem,
  createWorkbenchViewItem,
  type IWorkbenchProposalTimelineItem,
  type IWorkbenchTaskTimelineItem,
  type IWorkbenchViewTimelineItem,
} from '../../../src/modules/agent-work/timeline'

/**
 * 构造一条带完整信封的事件。
 *
 * @param seq - 事件序号。
 * @param blockId - 工作块 ID。
 * @param payload - 事件载荷（不含信封字段）。
 * @returns 可直接交由归约器或工厂处理的事件。
 * @throws 不抛出异常。
 */
export function eventOf<T extends { type: string; phase: 'begin' }> (
  seq: number,
  blockId: string,
  payload: T,
): TAgentClientEvent {
  return {
    sessionId: 's1',
    blockId,
    seq,
    timestamp: 1000 + seq,
    ...payload,
  } as unknown as TAgentClientEvent
}

/**
 * 构造视图卡片项。
 *
 * @param overrides - 需要覆盖的 viewKind 与载荷。
 * @returns 视图卡片项。
 * @throws 不抛出异常。
 */
export function createViewItem (
  overrides: {
    viewKind?: IWorkbenchViewTimelineItem['viewKind']
    payload?: Record<string, unknown>
  } = {},
): IWorkbenchViewTimelineItem {
  return createWorkbenchViewItem(
    eventOf(1, 'view-block-1', {
      type: 'workbench_view',
      phase: 'begin',
      viewId: 'view-1',
      viewKind: overrides.viewKind ?? 'capability',
      skillId: null,
      payload: overrides.payload ?? {},
    }) as never,
  )
}

/**
 * 构造提案卡片项。
 *
 * @param overrides - 需要覆盖的字段。
 * @returns 提案卡片项。
 * @throws 不抛出异常。
 */
export function createProposalItem (
  overrides: Partial<IWorkbenchProposalTimelineItem> = {},
): IWorkbenchProposalTimelineItem {
  return {
    ...createWorkbenchProposalItem(
      eventOf(2, 'proposal-block-1', {
        type: 'workbench_proposal',
        phase: 'begin',
        proposalId: 'proposal-1',
        proposalKind: 'case-change',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        label: '修改用例标题',
        state: 'pending',
        requiresModalConfirm: false,
      }) as never,
    ),
    ...overrides,
  }
}

/**
 * 构造 batch 任务卡片项（默认待确认态，两个条目一就绪一不就绪）。
 *
 * @param overrides - 需要覆盖的字段。
 * @returns 任务卡片项。
 * @throws 不抛出异常。
 */
export function createBatchItem (
  overrides: Partial<IWorkbenchTaskTimelineItem> = {},
): IWorkbenchTaskTimelineItem {
  return {
    ...createWorkbenchTaskItem(
      eventOf(3, 'task-block-1', {
        type: 'workbench_task',
        phase: 'begin',
        taskId: 'batch-1',
        taskKind: 'batch',
        skillId: 'abc123456',
        skillTitle: '连续执行',
        status: 'running',
        startedAt: 1000,
        batchStatus: 'awaiting-confirmation',
        batchLimit: 10,
        items: [
          {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            status: 'pending',
            readyCheck: { ok: true },
          },
          {
            skillId: 'abc123457',
            skillTitle: '结算',
            status: 'pending',
            readyCheck: { ok: false, reason: '缺少环境变量' },
          },
        ],
      }) as never,
    ),
    ...overrides,
  }
}

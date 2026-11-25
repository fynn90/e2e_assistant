/**
 * 工作时间线归约器：把客户端事件流归并为渲染友好的时间线状态。
 *
 * 本模块是纯函数实现（不依赖 Pinia / Vue 响应式），因此：
 *   - 可被 agent-work store（工作台 / 全局侧边栏）与生成弹窗并行复用；
 *   - 可独立单元测试，无需挂载组件或初始化 store。
 *
 * 归约规则：
 *   - 按 blockId 定位项：begin 插入新项，append / end 就地更新；
 *   - 按 seq 幂等：重复或乱序的旧事件直接丢弃（断线重连补发时依赖此规则）；
 *   - 旁路事件分流：status → 活动状态，file_change → 文件变更信号。
 */
import type {
  IAgentWorkBlock,
  TAgentActivity,
  TAgentClientEvent,
} from '@charlie_deng/e2e-assistant-types'
import {
  blockToTimelineItem,
  createCommandItem,
  createContentItem,
  createInteractionItem,
  createNoticeItem,
  createThinkingItem,
  createTodoItem,
  createToolItem,
  createTurnItem,
  patchCommandItem,
  patchContentItem,
  patchInteractionItem,
  patchThinkingItem,
  patchTodoItem,
  patchToolItem,
  patchTurnItem,
} from './item-factory'
import {
  createWorkbenchActionItem,
  createWorkbenchProposalItem,
  createWorkbenchReportItem,
  createWorkbenchTaskItem,
  createWorkbenchViewItem,
  patchWorkbenchActionItem,
  patchWorkbenchProposalItem,
  patchWorkbenchTaskItem,
  patchWorkbenchViewItem,
} from './workbench-item-factory'
import type { IFileChangeSignal, TWorkTimelineItem } from './types'

/** 文件变更信号的最大缓存条数。 */
const MAX_FILE_CHANGE_SIGNALS = 50

/**
 * 时间线归约状态。
 *
 * 该对象由调用方持有并**就地更新**（store 的响应式 state 或 composable 的内部状态）。
 * 归约函数只做原地修改（清空用 length = 0 / clear()，不重新赋值数组），
 * 这样调用方可以用一个普通对象暴露引用，而不会丢失引用绑定。
 */
export interface ITimelineState {
  /** 已归并的时间线项（按到达顺序，即 seq 升序）。 */
  items: TWorkTimelineItem[]
  /** blockId → items 下标（原位更新定位用）。 */
  itemIndex: Map<string, number>
  /** 已见最大事件序号（断线续传与幂等去重的依据）。 */
  lastSeq: number
  /** 状态条：当前活动。 */
  activity: TAgentActivity
  /** 状态条：活动文案。 */
  activityLabel?: string
  /** 最近的文件变更信号（文件树实时刷新用）。 */
  fileChanges: IFileChangeSignal[]
}

/**
 * 创建空的时间线归约状态。
 *
 * @returns 初始化完成的状态对象。
 * @throws 不抛出异常。
 */
export function createTimelineState (): ITimelineState {
  return {
    items: [],
    itemIndex: new Map<string, number>(),
    lastSeq: 0,
    activity: 'idle',
    activityLabel: undefined,
    fileChanges: [],
  }
}

/**
 * 用物化历史块重置状态（打开会话时恢复时间线）。
 *
 * @param state - 待重置的状态对象（就地修改）。
 * @param blocks - 服务端返回的历史工作块（按 seq 升序）。
 * @param currentSeq - 服务端当前最大事件序号。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
export function resetWithBlocks (
  state: ITimelineState,
  blocks: IAgentWorkBlock[],
  currentSeq: number,
): void {
  // 原地清空（不重新赋值数组）：保持调用方的引用绑定有效。
  state.items.length = 0
  state.itemIndex.clear()
  state.lastSeq = currentSeq
  state.activity = 'idle'
  state.activityLabel = undefined
  for (const block of blocks) {
    state.items.push(blockToTimelineItem(block))
    state.itemIndex.set(block.blockId, state.items.length - 1)
  }
}

/**
 * 清空时间线状态（关闭会话时调用）。
 *
 * @param state - 待清空的状态对象（就地修改）。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
export function clearTimeline (state: ITimelineState): void {
  state.items.length = 0
  state.itemIndex.clear()
  state.lastSeq = 0
  state.activity = 'idle'
  state.activityLabel = undefined
  state.fileChanges.length = 0
}

/**
 * 归并一条工作事件到时间线（幂等：seq <= lastSeq 直接丢弃）。
 *
 * @param state - 时间线状态（就地修改）。
 * @param event - 客户端工作事件。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
export function applyEventToTimeline (
  state: ITimelineState,
  event: TAgentClientEvent,
): void {
  if (event.seq <= state.lastSeq) return
  state.lastSeq = event.seq

  switch (event.type) {
    case 'status':
      state.activity = event.activity
      state.activityLabel = event.label
      return

    case 'file_change':
      state.fileChanges.unshift({
        seq: event.seq,
        operation: event.operation,
        path: event.path,
        newPath: event.newPath,
        sourceBlockId: event.sourceBlockId,
      })
      if (state.fileChanges.length > MAX_FILE_CHANGE_SIGNALS) {
        state.fileChanges.length = MAX_FILE_CHANGE_SIGNALS
      }
      return

    case 'heartbeat':
      return

    case 'turn':
      upsertItem(
        state,
        event.blockId,
        () => createTurnItem(event),
        (item) =>
          patchTurnItem(item as Parameters<typeof patchTurnItem>[0], event),
      )
      return

    case 'thinking':
      upsertItem(
        state,
        event.blockId,
        () => createThinkingItem(event),
        (item) =>
          patchThinkingItem(
            item as Parameters<typeof patchThinkingItem>[0],
            event,
          ),
      )
      return

    case 'content':
      upsertItem(
        state,
        event.blockId,
        () => createContentItem(event),
        (item) =>
          patchContentItem(
            item as Parameters<typeof patchContentItem>[0],
            event,
          ),
      )
      return

    case 'tool':
      upsertItem(
        state,
        event.blockId,
        () => createToolItem(event),
        (item) =>
          patchToolItem(item as Parameters<typeof patchToolItem>[0], event),
      )
      return

    case 'todo':
      upsertItem(
        state,
        event.blockId,
        () => createTodoItem(event),
        (item) =>
          patchTodoItem(item as Parameters<typeof patchTodoItem>[0], event),
      )
      return

    case 'command':
      upsertItem(
        state,
        event.blockId,
        () => createCommandItem(event),
        (item) =>
          patchCommandItem(
            item as Parameters<typeof patchCommandItem>[0],
            event,
          ),
      )
      return

    case 'interaction':
      upsertItem(
        state,
        event.blockId,
        () => createInteractionItem(event),
        (item) =>
          patchInteractionItem(
            item as Parameters<typeof patchInteractionItem>[0],
            event,
          ),
      )
      return

    case 'notice':
      upsertItem(
        state,
        event.blockId,
        () => createNoticeItem(event),
        () => undefined,
      )
      return

    case 'workbench_action':
      // 动作卡片的 begin 与状态更新同形：统一走 create + patch，
      // 后者在状态变化时整体覆盖文案与状态（服务端重发同一 blockId）。
      upsertItem(
        state,
        event.blockId,
        () => createWorkbenchActionItem(event),
        (item) =>
          patchWorkbenchActionItem(
            item as Parameters<typeof patchWorkbenchActionItem>[0],
            event,
          ),
      )
      return

    case 'workbench_task':
      upsertItem(
        state,
        event.blockId,
        () => createWorkbenchTaskItem(event),
        (item) =>
          patchWorkbenchTaskItem(
            item as Parameters<typeof patchWorkbenchTaskItem>[0],
            event,
          ),
      )
      return

    case 'workbench_report':
      // 报告卡片只发布一次、不做增量更新，故 patch 与 create 同义
      //（重复事件由文件头的 seq 幂等判据挡掉）。
      upsertItem(
        state,
        event.blockId,
        () => createWorkbenchReportItem(event),
        () => undefined,
      )
      return

    case 'workbench_view':
      // 只读视图卡（v17）：发布即终态；同一 viewId 重发（清单卡筛选后）
      // 整体覆盖载荷，卡片原位刷新（技术方案 §4.1 末注）。
      upsertItem(
        state,
        event.blockId,
        () => createWorkbenchViewItem(event),
        (item) =>
          patchWorkbenchViewItem(
            item as Parameters<typeof patchWorkbenchViewItem>[0],
            event,
          ),
      )
      return

    case 'workbench_proposal':
      // 提案卡（v17）：与动作卡片同构——pending 时可操作，终态以同一
      // proposalId 重发事件、整体覆盖状态与结果说明。
      upsertItem(
        state,
        event.blockId,
        () => createWorkbenchProposalItem(event),
        (item) =>
          patchWorkbenchProposalItem(
            item as Parameters<typeof patchWorkbenchProposalItem>[0],
            event,
          ),
      )
      return
  }
}

/**
 * 插入或更新时间线项（按 blockId 定位）。
 *
 * @param state - 时间线状态（就地修改）。
 * @param blockId - 工作块 ID。
 * @param create - 块不存在时创建新项。
 * @param patch - 块存在时就地更新。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
export function upsertItem (
  state: ITimelineState,
  blockId: string,
  create: () => TWorkTimelineItem,
  patch: (item: TWorkTimelineItem) => void,
): void {
  const index = state.itemIndex.get(blockId)
  if (index === undefined) {
    const item = create()
    patch(item)
    state.items.push(item)
    state.itemIndex.set(blockId, state.items.length - 1)
    return
  }
  patch(state.items[index]!)
}

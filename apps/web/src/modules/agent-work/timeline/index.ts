/**
 * 工作时间线模块统一出口。
 *
 * 归约逻辑（types / item-factory / reducer）与订阅封装（useAgentWorkTimeline）
 * 独立于 Agent 工作台 store，供工作台、全局侧边栏与生成弹窗并行复用。
 */
export type {
  ICommandTimelineItem,
  IContentTimelineItem,
  IFileChangeSignal,
  IInteractionTimelineItem,
  INoticeTimelineItem,
  IThinkingTimelineItem,
  ITodoTimelineItem,
  IToolTimelineItem,
  ITurnTimelineItem,
  IWorkbenchActionTimelineItem,
  IWorkbenchProposalTimelineItem,
  IWorkbenchReportTimelineItem,
  IWorkbenchTaskTimelineItem,
  IWorkbenchViewTimelineItem,
  TWorkConnection,
  TWorkTimelineItem,
} from './types'
export {
  applyEventToTimeline,
  clearTimeline,
  createTimelineState,
  resetWithBlocks,
  type ITimelineState,
} from './reducer'
export { blockToTimelineItem } from './item-factory'
export {
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
export {
  useAgentWorkTimeline,
  type IUseAgentWorkTimeline,
  type IUseAgentWorkTimelineOptions,
} from './useAgentWorkTimeline'

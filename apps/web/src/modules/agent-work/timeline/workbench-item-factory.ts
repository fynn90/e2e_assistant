/**
 * 工作台卡片时间线项的工厂集合（v16 动作 / 任务 / 报告，v17 视图 / 提案）。
 *
 * 为什么从 `item-factory.ts` 拆出来：基础块（思考 / 内容 / 工具 / 命令 …）的
 * 创建与更新与工作台卡片**没有共同的变化原因**——后者随卡片协议（v16 → v17）
 * 演进，前者几乎不动。混在一个文件里既突破单文件行数上限，也让每次加一张卡
 * 都要去改基础块所在的文件。
 *
 * 全部为纯函数（不触达 store / DOM），供归约器与单元测试直接复用：
 *   - createXxxItem：块的 begin 事件到达时创建项；
 *   - patchXxxItem：同一 blockId 的状态更新事件到达时就地更新项。
 */
import type {
  IAgentWorkBlock,
  IAgentWorkbenchTaskSummary,
  IBatchItem,
  ICaseRepairEvidence,
  IEnvKeyOperation,
  IProposalChange,
  TAgentClientEvent,
  TAgentWorkbenchAction,
  TAgentWorkbenchActionState,
  TAgentWorkbenchProposalKind,
  TAgentWorkbenchProposalState,
  TAgentWorkbenchTaskKind,
  TAgentWorkbenchTaskStatus,
  TAgentWorkbenchViewKind,
  TBatchStatus,
} from '@authine-e2e-agent/types'
import type {
  IWorkbenchActionTimelineItem,
  IWorkbenchProposalTimelineItem,
  IWorkbenchReportTimelineItem,
  IWorkbenchTaskTimelineItem,
  IWorkbenchViewTimelineItem,
  TWorkTimelineItem,
} from './types'

/** 按事件类型取对应的判别联合分支。 */
type TEventOf<T extends TAgentClientEvent['type']> = Extract<
  TAgentClientEvent,
  { type: T }
>

/**
 * 工作台卡片族的块种类（`workbenchBlockToItem` 的分派封闭集合）。
 *
 * 用它而不是宽泛的 `TAgentWorkBlockKind`：调用方若漏了某个 case，`switch`
 * 不再穷尽，**编译期就会报错**（函数声明了返回类型却没有兜底分支）。
 */
export type TWorkbenchCardBlock = IAgentWorkBlock & {
  kind:
    | 'workbench_action'
    | 'workbench_task'
    | 'workbench_report'
    | 'workbench_view'
    | 'workbench_proposal'
}

/**
 * 创建动作卡片项（v16）。
 *
 * @param event - 动作块事件（携带动作身份与按钮文案）。
 * @returns 初始为 pending（可点击）的动作项。
 * @throws 不抛出异常。
 */
export function createWorkbenchActionItem(
  event: TEventOf<'workbench_action'>,
): IWorkbenchActionTimelineItem {
  return {
    kind: 'workbench_action',
    blockId: event.blockId,
    seq: event.seq,
    status: 'pending',
    actionId: event.actionId,
    action: event.action,
    skillId: event.skillId,
    skillTitle: event.skillTitle,
    label: event.label,
    description: event.description,
    requiresConfirm: event.requiresConfirm,
    state: event.state,
  }
}

/**
 * 更新动作卡片项：状态变化（pending → consumed/expired）整体覆盖。
 *
 * 服务端以同一 blockId 重发事件表达状态变化，因此这里不做增量，
 * 直接以事件为准（避免出现「文案改了、状态没改」的错位）。
 *
 * @param item - 待更新的动作项。
 * @param event - 动作块事件。
 * @throws 不抛出异常。
 */
export function patchWorkbenchActionItem(
  item: IWorkbenchActionTimelineItem,
  event: TEventOf<'workbench_action'>,
): void {
  item.action = event.action
  item.skillId = event.skillId
  item.skillTitle = event.skillTitle
  item.label = event.label
  item.description = event.description
  item.requiresConfirm = event.requiresConfirm
  item.state = event.state
  if (event.state !== 'pending') {
    item.status = 'done'
  }
}

/**
 * 创建任务卡片项（v16；v17 扩 batch 分支）。
 *
 * @param event - 任务块事件（携带任务身份与初始状态）。
 * @returns 初始为 streaming 的任务项。
 * @throws 不抛出异常。
 */
export function createWorkbenchTaskItem(
  event: TEventOf<'workbench_task'>,
): IWorkbenchTaskTimelineItem {
  return {
    kind: 'workbench_task',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    taskId: event.taskId,
    taskKind: event.taskKind,
    skillId: event.skillId,
    skillTitle: event.skillTitle,
    taskStatus: event.status,
    startedAt: event.startedAt,
    executionId: event.executionId,
    summary: event.summary,
    errorMessage: event.errorMessage,
    artifacts: event.artifacts,
    batchStatus: event.batchStatus,
    items: event.items,
    batchLimit: event.batchLimit,
  }
}

/**
 * 更新任务卡片项：终态时覆盖状态、摘要与错误。
 *
 * @param item - 待更新的任务项。
 * @param event - 任务块事件。
 * @throws 不抛出异常。
 */
export function patchWorkbenchTaskItem(
  item: IWorkbenchTaskTimelineItem,
  event: TEventOf<'workbench_task'>,
): void {
  item.taskStatus = event.status
  item.summary = event.summary
  item.errorMessage = event.errorMessage
  item.artifacts = event.artifacts
  item.executionId = event.executionId ?? item.executionId
  // batch 字段与 status / summary 走同一条更新路径（同一 blockId 重发）：
  // 条目进度与批次状态都靠它原位刷新，漏一个就会出现「汇总变了、清单没变」。
  item.batchStatus = event.batchStatus
  item.items = event.items
  item.batchLimit = event.batchLimit
  if (event.status !== 'running') {
    item.status = event.status === 'failed' ? 'failed' : 'done'
  }
}

/**
 * 创建报告卡片项（v16，PRD RPT-2/RPT-3）。
 *
 * 报告卡片只在执行终态发布一次、不做增量更新，因此没有对应的 patch 函数——
 * 归约器对它只走创建路径。
 *
 * @param event - 报告块事件（携带统计摘要与关联执行）。
 * @returns 报告卡片项。
 * @throws 不抛出异常。
 */
export function createWorkbenchReportItem(
  event: TEventOf<'workbench_report'>,
): IWorkbenchReportTimelineItem {
  return {
    kind: 'workbench_report',
    blockId: event.blockId,
    seq: event.seq,
    status: 'done',
    executionId: event.executionId,
    skillId: event.skillId,
    skillTitle: event.skillTitle,
    taskStatus: event.taskStatus,
    summary: event.summary,
  }
}

/**
 * 创建只读视图卡片项（v17）。
 *
 * 视图卡是 begin 一次性发布（无 append / end），发布即终态。
 *
 * @param event - 视图块事件（payload 由平台宿主自取填充）。
 * @returns 终态（done）的视图项。
 * @throws 不抛出异常。
 */
export function createWorkbenchViewItem(
  event: TEventOf<'workbench_view'>,
): IWorkbenchViewTimelineItem {
  return {
    kind: 'workbench_view',
    blockId: event.blockId,
    seq: event.seq,
    status: 'done',
    viewId: event.viewId,
    viewKind: event.viewKind,
    skillId: event.skillId,
    payload: event.payload,
  }
}

/**
 * 更新只读视图卡片项：整体覆盖载荷与身份（仿动作卡片的「以事件为准」）。
 *
 * 为什么需要它而不是像报告卡那样只走创建路径：技术方案 §4.1 明确「清单卡筛选后
 * 以同一 viewId 重发」——此时 blockId 相同、seq 更新，归约器会走到 patch 分支。
 * 若这里做 no-op，筛选后的清单不会刷新，用户会盯着旧条件的结果。
 *
 * @param item - 待更新的视图项。
 * @param event - 视图块事件。
 * @throws 不抛出异常。
 */
export function patchWorkbenchViewItem(
  item: IWorkbenchViewTimelineItem,
  event: TEventOf<'workbench_view'>,
): void {
  item.viewId = event.viewId
  item.viewKind = event.viewKind
  item.skillId = event.skillId
  item.payload = event.payload
}

/**
 * 创建提案卡片项（v17）。
 *
 * @param event - 提案块事件（携带人话对照、env key 与状态机初始态）。
 * @returns 提案卡片项。
 * @throws 不抛出异常。
 */
export function createWorkbenchProposalItem(
  event: TEventOf<'workbench_proposal'>,
): IWorkbenchProposalTimelineItem {
  return {
    kind: 'workbench_proposal',
    blockId: event.blockId,
    seq: event.seq,
    status: 'pending',
    proposalId: event.proposalId,
    proposalKind: event.proposalKind,
    skillId: event.skillId,
    skillTitle: event.skillTitle,
    label: event.label,
    description: event.description,
    state: event.state,
    changes: event.changes,
    envKeys: event.envKeys,
    envKeyOps: event.envKeyOps,
    requiresModalConfirm: event.requiresModalConfirm,
    reportCount: event.reportCount,
    releaseBytes: event.releaseBytes,
    evidence: event.evidence,
    resultMessage: event.resultMessage,
  }
}

/**
 * 更新提案卡片项：状态变化整体覆盖（仿动作卡片）。
 *
 * 服务端以同一 proposalId 重发事件表达 `pending → applied / cancelled /
 * conflict / failed / expired`，因此不做增量、直接以事件为准——避免出现
 * 「终态了但结果说明还是上一版」的错位。
 *
 * @param item - 待更新的提案项。
 * @param event - 提案块事件。
 * @throws 不抛出异常。
 */
export function patchWorkbenchProposalItem(
  item: IWorkbenchProposalTimelineItem,
  event: TEventOf<'workbench_proposal'>,
): void {
  item.proposalKind = event.proposalKind
  item.skillId = event.skillId
  item.skillTitle = event.skillTitle
  item.label = event.label
  item.description = event.description
  item.state = event.state
  item.changes = event.changes
  item.envKeys = event.envKeys
  item.envKeyOps = event.envKeyOps
  item.requiresModalConfirm = event.requiresModalConfirm
  item.reportCount = event.reportCount
  item.releaseBytes = event.releaseBytes
  item.evidence = event.evidence
  item.resultMessage = event.resultMessage
  if (event.state !== 'pending') {
    item.status = 'done'
  }
}

/**
 * 把物化历史块还原为工作台卡片项（会话恢复路径）。
 *
 * 与 createXxxItem 的差别：物化块的字段是 `Record<string, unknown>`
 * （存储层不理解载荷结构），因此这里做无校验断言 + 缺省兜底，
 * 与 `item-factory.ts` 对基础块的处置一致。
 *
 * 覆盖 v16 的动作 / 任务 / 报告与 v17 的视图 / 提案五种块；调用方
 * （`item-factory.ts`）已按 `block.kind` 分派，本函数只按 kind 二次分派。
 *
 * @param block - 服务端返回的工作块（kind 已限定为工作台卡片族）。
 * @returns 对应的工作台卡片时间线项。
 * @throws 不抛出异常；未知字段按缺省值兜底。
 */
export function workbenchBlockToItem(
  block: TWorkbenchCardBlock,
): TWorkTimelineItem {
  const payload = block.payload
  switch (block.kind) {
    case 'workbench_action':
      return {
        kind: 'workbench_action',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        actionId: (payload.actionId as string) ?? '',
        action: (payload.action as TAgentWorkbenchAction) ?? 'retry',
        skillId: (payload.skillId as string | null) ?? null,
        skillTitle: payload.skillTitle as string | undefined,
        label: (payload.label as string) ?? '',
        description: payload.description as string | undefined,
        requiresConfirm: payload.requiresConfirm as boolean | undefined,
        state: (payload.state as TAgentWorkbenchActionState) ?? 'pending',
        skillMissing: payload.skillMissing as boolean | undefined,
      }
    case 'workbench_task':
      return {
        kind: 'workbench_task',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        taskId: (payload.taskId as string) ?? '',
        taskKind: (payload.taskKind as TAgentWorkbenchTaskKind) ?? 'execution',
        skillId: (payload.skillId as string) ?? '',
        skillTitle: (payload.skillTitle as string) ?? '',
        taskStatus: (payload.status as TAgentWorkbenchTaskStatus) ?? 'running',
        startedAt: (payload.startedAt as number) ?? block.createdAt,
        executionId: payload.executionId as string | undefined,
        summary: payload.summary as IAgentWorkbenchTaskSummary | undefined,
        errorMessage: payload.errorMessage as string | undefined,
        artifacts: payload.artifacts as
          | { hasSkillDocument: boolean; hasPlaywrightScript: boolean }
          | undefined,
        batchStatus: payload.batchStatus as TBatchStatus | undefined,
        items: payload.items as IBatchItem[] | undefined,
        batchLimit: payload.batchLimit as number | undefined,
        skillMissing: payload.skillMissing as boolean | undefined,
      }
    case 'workbench_report':
      return {
        kind: 'workbench_report',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        executionId: (payload.executionId as string) ?? '',
        skillId: (payload.skillId as string) ?? '',
        skillTitle: (payload.skillTitle as string) ?? '',
        taskStatus:
          (payload.taskStatus as Exclude<
            TAgentWorkbenchTaskStatus,
            'running'
          >) ?? 'completed',
        // 摘要缺失时给空对象而不是 undefined：报告卡片处处读它，
        // 让组件拿到空对象能照常渲染（显示 0 条），不必层层判空。
        summary: (payload.summary as IAgentWorkbenchTaskSummary) ?? {},
        skillMissing: payload.skillMissing as boolean | undefined,
      }
    case 'workbench_view':
      return {
        kind: 'workbench_view',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        viewId: (payload.viewId as string) ?? '',
        viewKind: (payload.viewKind as TAgentWorkbenchViewKind) ?? 'capability',
        skillId: (payload.skillId as string | null) ?? null,
        // 载荷缺失时给空对象：子组件按 viewKind 读取时会走各自的空态，
        // 比 undefined 更能避免渲染层层层判空。
        payload: (payload.payload as Record<string, unknown>) ?? {},
      }
    case 'workbench_proposal':
      return {
        kind: 'workbench_proposal',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        proposalId: (payload.proposalId as string) ?? '',
        proposalKind:
          (payload.proposalKind as TAgentWorkbenchProposalKind) ??
          'case-change',
        skillId: (payload.skillId as string) ?? '',
        skillTitle: (payload.skillTitle as string) ?? '',
        label: (payload.label as string) ?? '',
        description: payload.description as string | undefined,
        state: (payload.state as TAgentWorkbenchProposalState) ?? 'pending',
        changes: payload.changes as IProposalChange[] | undefined,
        envKeys: payload.envKeys as
          Array<{ key: string; usage: string }> | undefined,
        envKeyOps: payload.envKeyOps as IEnvKeyOperation[] | undefined,
        // 缺省 false：弹框是额外的一道闸，**只有服务端明说 true 才弹**
        //（漏弹的代价是少一道确认，误弹的代价是每次点按钮都被打断）。
        requiresModalConfirm: payload.requiresModalConfirm === true,
        reportCount: payload.reportCount as number | undefined,
        releaseBytes: payload.releaseBytes as number | undefined,
        evidence: payload.evidence as ICaseRepairEvidence | undefined,
        resultMessage: payload.resultMessage as string | undefined,
        skillMissing: payload.skillMissing as boolean | undefined,
      }
  }
}

/**
 * 时间线项工厂：把客户端事件与物化历史块转换为渲染友好的时间线项。
 *
 * 全部为纯函数（不触达 store / DOM），便于单元测试与多消费方复用：
 *   - createXxxItem：块的 begin 事件到达时创建项；
 *   - patchXxxItem：append / end 事件到达时就地更新项；
 *   - blockToTimelineItem：把服务端物化的历史块还原为项（会话恢复用）。
 *
 * 工作台卡片族（workbench_*）的工厂在 `workbench-item-factory.ts`——
 * 它们随卡片协议演进，与基础块没有共同的变化原因。
 */
import type {
  IAgentInteraction,
  IAgentTodoItem,
  IAgentToolImageRef,
  IAgentTurnUsage,
  IAgentWorkBlock,
  TAgentClientEvent,
  TAgentContentType,
  TAgentToolAction,
  TAgentToolCategory,
  TAgentTurnOutcome,
} from '@authine-e2e-agent/types'
import type {
  ICommandTimelineItem,
  IContentTimelineItem,
  IInteractionTimelineItem,
  INoticeTimelineItem,
  IThinkingTimelineItem,
  ITodoTimelineItem,
  IToolTimelineItem,
  ITurnTimelineItem,
  TWorkTimelineItem,
} from './types'
import {
  workbenchBlockToItem,
  type TWorkbenchCardBlock,
} from './workbench-item-factory'

/** 按事件类型取对应的判别联合分支。 */
type TEventOf<T extends TAgentClientEvent['type']> = Extract<
  TAgentClientEvent,
  { type: T }
>

/**
 * 把物化历史块转换为时间线项。
 *
 * @param block - 服务端返回的工作块（payload 结构按 kind 区分）。
 * @returns 可直接渲染的时间线项。
 * @throws 不抛出异常；未知字段按缺省值兜底。
 */
export function blockToTimelineItem(block: IAgentWorkBlock): TWorkTimelineItem {
  const payload = block.payload
  switch (block.kind) {
    case 'thinking':
      return {
        kind: 'thinking',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        text: (payload.text as string) ?? '',
        durationMs: payload.durationMs as number | undefined,
        // 物化块不存 begin 事件时间戳，用块创建时间兜底（服务端在 begin 时
        // 写入 `createdAt: event.timestamp`，两值同源）。
        startedAt: block.createdAt,
      }
    case 'content':
      return {
        kind: 'content',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        contentType: (payload.contentType as TAgentContentType) ?? 'markdown',
        language: payload.language as string | undefined,
        text: (payload.text as string) ?? '',
      }
    case 'tool':
      return {
        kind: 'tool',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        category: (payload.category as TAgentToolCategory) ?? 'other',
        // 与 category 同理：payload 是无校验断言，`??` 只挡 null/undefined。
        // 旧会话物化的块没有 action 字段，会落到 'other' 的兜底扳手——
        // 这是可接受的降级（而不是渲染成空白方块）。
        action: (payload.action as TAgentToolAction) ?? 'other',
        title: (payload.title as string) ?? '',
        subtitle: payload.subtitle as string | undefined,
        toolName: (payload.toolName as string) ?? '',
        text: (payload.text as string) ?? '',
        summary: payload.summary as string | undefined,
        durationMs: payload.durationMs as number | undefined,
        image: payload.image as IAgentToolImageRef | undefined,
      }
    case 'todo':
      return {
        kind: 'todo',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        // 物化块只存当前清单；历史块因此展示「当时的清单快照」，符合预期。
        items: Array.isArray(payload.items)
          ? (payload.items as IAgentTodoItem[])
          : [],
      }
    case 'command':
      return {
        kind: 'command',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        command: (payload.command as string) ?? '',
        cwd: payload.cwd as string | undefined,
        stdout: (payload.stdout as string) ?? '',
        stderr: (payload.stderr as string) ?? '',
        exitCode: payload.exitCode as number | undefined,
        durationMs: payload.durationMs as number | undefined,
      }
    case 'interaction':
      return {
        kind: 'interaction',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        interaction: payload.interaction as IAgentInteraction,
        answer: payload.answer as IInteractionTimelineItem['answer'],
        answeredBy: payload.answeredBy as
          'user' | 'timeout' | 'aborted' | undefined,
      }
    case 'notice':
      return {
        kind: 'notice',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        level: (payload.level as 'warning' | 'error') ?? 'warning',
        message: (payload.message as string) ?? '',
      }
    case 'turn':
      return {
        kind: 'turn',
        blockId: block.blockId,
        seq: block.seq,
        status: block.status,
        runId: (payload.runId as string) ?? block.runId,
        inputPreview: payload.inputPreview as string | undefined,
        outcome: payload.outcome as TAgentTurnOutcome | undefined,
        errorMessage: payload.errorMessage as string | undefined,
        usage: payload.usage as IAgentTurnUsage | undefined,
      }
    // 工作台卡片族（v16 动作/任务/报告、v17 视图/提案）交给独立模块：
    // 它们随卡片协议演进，与基础块没有共同的变化原因。
    case 'workbench_action':
    case 'workbench_task':
    case 'workbench_report':
    case 'workbench_view':
    case 'workbench_proposal':
      // 断言的理由：`block.kind` 已由本 switch 收窄到工作台卡片族
      //（这里的 case 就是族清单），但 TS 的收窄不会传递到函数实参。
      return workbenchBlockToItem(block as TWorkbenchCardBlock)
  }
}

/**
 * 创建思考块项。
 *
 * @param event - 思考块事件（通常为 begin）。
 * @returns 初始为 streaming 的思考项，并记录 begin 时间戳供实时计时。
 */
export function createThinkingItem(
  event: TEventOf<'thinking'>,
): IThinkingTimelineItem {
  return {
    kind: 'thinking',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    text: '',
    // 取信封时间戳（服务端分配）：块尚未 end、拿不到 durationMs，
    // 头部「已思考 N 秒」只能靠起点 + 当前时间实时推算。
    startedAt: event.timestamp,
  }
}

/**
 * 更新思考块项：append 追加文本，end 记录耗时并定型。
 *
 * @param item - 待更新的思考项。
 * @param event - 思考块事件。
 */
export function patchThinkingItem(
  item: IThinkingTimelineItem,
  event: TEventOf<'thinking'>,
): void {
  if (event.phase === 'append') {
    item.text += event.text
  } else if (event.phase === 'end') {
    item.durationMs = event.durationMs
    item.status = 'done'
  }
}

/**
 * 创建内容输出块项。
 *
 * @param event - 内容块事件（begin 携带 contentType / language）。
 * @returns 初始为 streaming 的内容项。
 */
export function createContentItem(
  event: TEventOf<'content'>,
): IContentTimelineItem {
  return {
    kind: 'content',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    contentType: event.phase === 'begin' ? event.contentType : 'markdown',
    language: event.phase === 'begin' ? event.language : undefined,
    text: '',
  }
}

/**
 * 更新内容输出块项：append 追加文本，end 定型。
 *
 * @param item - 待更新的内容项。
 * @param event - 内容块事件。
 */
export function patchContentItem(
  item: IContentTimelineItem,
  event: TEventOf<'content'>,
): void {
  if (event.phase === 'append') {
    item.text += event.text
  } else if (event.phase === 'end') {
    item.status = 'done'
  }
}

/**
 * 创建工具调用块项。
 *
 * @param event - 工具块事件（begin 携带工具元信息）。
 * @returns 初始为 streaming 的工具项。
 */
export function createToolItem(event: TEventOf<'tool'>): IToolTimelineItem {
  return {
    kind: 'tool',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    category: event.phase === 'begin' ? event.tool.category : 'other',
    action: event.phase === 'begin' ? event.tool.action : 'other',
    title: event.phase === 'begin' ? event.tool.title : '',
    subtitle: event.phase === 'begin' ? event.tool.subtitle : undefined,
    toolName: event.phase === 'begin' ? event.tool.toolName : '',
    text: '',
  }
}

/**
 * 更新工具调用块项：append 追加进度文本，end 记录摘要与成败。
 *
 * @param item - 待更新的工具项。
 * @param event - 工具块事件。
 */
export function patchToolItem(
  item: IToolTimelineItem,
  event: TEventOf<'tool'>,
): void {
  if (event.phase === 'append') {
    item.text += event.text
  } else if (event.phase === 'end') {
    item.summary = event.summary
    item.durationMs = event.durationMs
    item.image = event.image
    item.status = event.status === 'failed' ? 'failed' : 'done'
  }
}

/**
 * 创建待办清单块项（v12-pre）。
 *
 * 清单是整体替换语义：begin 事件即携带完整清单，因此没有 append 阶段。
 *
 * @param event - 待办块事件。
 * @returns 包含完整清单的待办项。
 */
export function createTodoItem(event: TEventOf<'todo'>): ITodoTimelineItem {
  return {
    kind: 'todo',
    blockId: event.blockId,
    seq: event.seq,
    status: 'done',
    items: event.items,
  }
}

/**
 * 更新待办清单块项：整体替换清单内容。
 *
 * @param item - 待更新的待办项。
 * @param event - 待办块事件。
 */
export function patchTodoItem(
  item: ITodoTimelineItem,
  event: TEventOf<'todo'>,
): void {
  item.items = event.items
}

/**
 * 创建命令执行块项。
 *
 * @param event - 命令块事件（begin 携带命令与执行目录）。
 * @returns 初始为 streaming 的命令项。
 */
export function createCommandItem(
  event: TEventOf<'command'>,
): ICommandTimelineItem {
  return {
    kind: 'command',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    command: event.phase === 'begin' ? event.command : '',
    cwd: event.phase === 'begin' ? event.cwd : undefined,
    stdout: '',
    stderr: '',
  }
}

/**
 * 更新命令执行块项：append 按流向分流累积，end 按退出码定型。
 *
 * @param item - 待更新的命令项。
 * @param event - 命令块事件。
 */
export function patchCommandItem(
  item: ICommandTimelineItem,
  event: TEventOf<'command'>,
): void {
  if (event.phase === 'append') {
    if (event.stream === 'stderr') {
      item.stderr += event.text
    } else {
      item.stdout += event.text
    }
  } else if (event.phase === 'end') {
    item.exitCode = event.exitCode
    item.durationMs = event.durationMs
    item.status = event.exitCode === 0 ? 'done' : 'failed'
  }
}

/**
 * 创建交互块项。
 *
 * @param event - 交互块事件（begin 携带交互元信息）。
 * @returns 初始为 pending（等待回答）的交互项。
 */
export function createInteractionItem(
  event: TEventOf<'interaction'>,
): IInteractionTimelineItem {
  return {
    kind: 'interaction',
    blockId: event.blockId,
    seq: event.seq,
    status: 'pending',
    interaction:
      event.phase === 'begin'
        ? event.interaction
        : { interactionId: event.interactionId, kind: 'confirm', title: '' },
  }
}

/**
 * 更新交互块项：end 记录回答值与来源。
 *
 * @param item - 待更新的交互项。
 * @param event - 交互块事件。
 */
export function patchInteractionItem(
  item: IInteractionTimelineItem,
  event: TEventOf<'interaction'>,
): void {
  if (event.phase === 'end') {
    item.answer = event.answer
    item.answeredBy = event.answeredBy
    item.status = 'answered'
  }
}

/**
 * 创建提示块项。
 *
 * @param event - 提示块事件。
 * @returns 按级别定型（error 为 failed）的提示项。
 */
export function createNoticeItem(
  event: TEventOf<'notice'>,
): INoticeTimelineItem {
  return {
    kind: 'notice',
    blockId: event.blockId,
    seq: event.seq,
    status: event.level === 'error' ? 'failed' : 'done',
    level: event.level,
    message: event.message,
  }
}

/**
 * 创建轮次分隔项。
 *
 * @param event - 轮次事件。
 * @returns 初始为 streaming 的轮次项。
 */
export function createTurnItem(event: TEventOf<'turn'>): ITurnTimelineItem {
  return {
    kind: 'turn',
    blockId: event.blockId,
    seq: event.seq,
    status: 'streaming',
    runId: event.runId,
  }
}

/**
 * 更新轮次分隔项：begin 记录输入预览，end 记录结局、错误与用量。
 *
 * @param item - 待更新的轮次项。
 * @param event - 轮次事件。
 */
export function patchTurnItem(
  item: ITurnTimelineItem,
  event: TEventOf<'turn'>,
): void {
  if (event.phase === 'begin') {
    item.inputPreview = event.inputPreview
  } else {
    item.outcome = event.outcome
    item.errorMessage = event.errorMessage
    item.usage = event.usage
    item.status = event.outcome === 'failed' ? 'failed' : 'done'
  }
}

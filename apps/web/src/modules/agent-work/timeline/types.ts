/**
 * 工作时间线项的渲染契约。
 *
 * 一个项 = 一个组件：WorkTimeline 按 kind 分发到对应展示组件。
 * 这些类型是 agent-work store 与生成弹窗共用的渲染语义，
 * 因此独立于任何 store / composable（单一职责，避免循环依赖）。
 */
import type {
  IAgentInteraction,
  IAgentTodoItem,
  IAgentToolImageRef,
  IAgentTurnUsage,
  IAgentWorkbenchTaskSummary,
  IBatchItem,
  ICaseRepairEvidence,
  IEnvKeyOperation,
  IProposalChange,
  TBatchStatus,
  TAgentContentType,
  TAgentFileChangeOperation,
  TAgentInteractionAnswer,
  TAgentToolAction,
  TAgentToolCategory,
  TAgentTurnOutcome,
  TAgentWorkBlockStatus,
  TAgentWorkbenchAction,
  TAgentWorkbenchActionState,
  TAgentWorkbenchProposalKind,
  TAgentWorkbenchProposalState,
  TAgentWorkbenchTaskKind,
  TAgentWorkbenchTaskStatus,
  TAgentWorkbenchViewKind,
} from '@authine-e2e-agent/types'

/** 思考块时间线项。 */
export interface IThinkingTimelineItem {
  kind: 'thinking'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  text: string
  /** 思考耗时（毫秒），仅在 `end` 事件到达后存在。 */
  durationMs?: number
  /**
   * 思考开始的毫秒时间戳，用于运行中实时计时（`now - startedAt`）。
   *
   * 实时到达的块取 begin 事件信封的 `timestamp`；会话恢复的物化块取
   * `createdAt`。`end` 之后**保留不清空**：终态摘要虽改用 `durationMs`，
   * 但保留现场便于回看与诊断。
   */
  startedAt?: number
}

/** 内容输出块时间线项。 */
export interface IContentTimelineItem {
  kind: 'content'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  contentType: TAgentContentType
  language?: string
  text: string
}

/** 工具调用块时间线项。 */
export interface IToolTimelineItem {
  kind: 'tool'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 工具类别：**配色/样式**依据（粗粒度分组）。 */
  category: TAgentToolCategory
  /**
   * 工具动作：**图标**选择依据（细粒度动作身份）。
   *
   * 与 `category` 分开的原因：同一大类下的不同动作需要不同图标
   * （如「查询页面元素」与「点击页面元素」同属 browser），
   * 仅靠 category 会让它们塌缩成同一个图标。
   */
  action: TAgentToolAction
  title: string
  subtitle?: string
  toolName: string
  text: string
  summary?: string
  durationMs?: number
  /**
   * 结果附带的图片引用（v12-pre 页面截图）。
   *
   * 只带引用不带字节：图片由 CLI 落盘在 Skill 的 temp/exploration/ 目录，
   * 卡片按 url 懒加载，避免时间线里堆积 base64。
   *
   * 图片随 temp/ 在任务终态被删除，因此历史会话中该 url 已失效，
   * 卡片会降级为占位文案（见 ToolBlock.vue）。
   */
  image?: IAgentToolImageRef
}

/** 待办清单块时间线项（v12-pre）。 */
export interface ITodoTimelineItem {
  kind: 'todo'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 完整清单（整体替换语义，非增量）。 */
  items: IAgentTodoItem[]
}

/** 命令执行块时间线项。 */
export interface ICommandTimelineItem {
  kind: 'command'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  command: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode?: number
  durationMs?: number
}

/** 前端交互块时间线项。 */
export interface IInteractionTimelineItem {
  kind: 'interaction'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  interaction: IAgentInteraction
  /** 回答（v14 D5 放宽：单问题 string / 多问题回答表 / 取消哨兵）。 */
  answer?: TAgentInteractionAnswer
  answeredBy?: 'user' | 'timeout' | 'aborted'
}

/** 提示块时间线项。 */
export interface INoticeTimelineItem {
  kind: 'notice'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  level: 'warning' | 'error'
  message: string
}

/** 轮次分隔时间线项。 */
export interface ITurnTimelineItem {
  kind: 'turn'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  runId: string
  inputPreview?: string
  outcome?: TAgentTurnOutcome
  errorMessage?: string
  usage?: IAgentTurnUsage
}

/**
 * 工作台动作卡片项（v16）：对话流中用户可点击的入口。
 *
 * 点击后由父级调用动作接口；`state` 定格后按钮不再可点（卡片保留为历史痕迹）。
 */
export interface IWorkbenchActionTimelineItem {
  kind: 'workbench_action'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  actionId: string
  action: TAgentWorkbenchAction
  /** 目标 SKILL；create-skill 时为 null。 */
  skillId: string | null
  skillTitle?: string
  label: string
  description?: string
  /** 点击前需用户确认（GEN-10 覆盖确认）；由服务端给出，不由文案推断。 */
  requiresConfirm?: boolean
  state: TAgentWorkbenchActionState
  /**
   * 目标用例已不存在（v17 L2d）。
   *
   * 由服务端在读取历史块时统一标注（删除侧不回写历史），前端据此禁用按钮
   * 并标注「用例已删除」——**不得出现点了报错的入口**。
   */
  skillMissing?: boolean
}

/**
 * 工作台任务卡片项（v16）：一次执行或生成的载体。
 *
 * 卡片主体按 `taskKind` 分派：执行内嵌执行区块，生成内嵌子会话时间线；
 * 终态摘要 `summary` 由服务端物化，历史回看据此还原（PRD LOG-2）。
 */
export interface IWorkbenchTaskTimelineItem {
  kind: 'workbench_task'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 任务 ID：执行任务为 executionId，生成任务为子会话 ID。 */
  taskId: string
  taskKind: TAgentWorkbenchTaskKind
  skillId: string
  skillTitle: string
  taskStatus: TAgentWorkbenchTaskStatus
  /** 任务创建时刻（毫秒时间戳，供运行中实时计时）。 */
  startedAt: number
  /** 执行任务的目标执行 ID（内嵌执行区块的取数键）。 */
  executionId?: string
  summary?: IAgentWorkbenchTaskSummary
  errorMessage?: string
  /** 生成任务终态的产物完备性。 */
  artifacts?: { hasSkillDocument: boolean; hasPlaywrightScript: boolean }
  /** batch 专用：批次状态（v17 R4 三态；其余 taskKind 为缺省）。 */
  batchStatus?: TBatchStatus
  /** batch 专用：条目清单与逐条状态。 */
  items?: IBatchItem[]
  /** batch 专用：单批上限（R4b 的 10）。 */
  batchLimit?: number
  /** 目标用例已不存在（v17 L2d）。 */
  skillMissing?: boolean
}

/**
 * 工作台报告卡片项（v16，PRD RPT-2/RPT-3）：执行结果的独立一张卡。
 *
 * 与 `IWorkbenchTaskTimelineItem` 平级：那张记过程，这张记结果。
 * 报告卡片一旦发布即为终态，不做增量更新。
 */
export interface IWorkbenchReportTimelineItem {
  kind: 'workbench_report'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 关联的执行 ID（与执行卡片的 taskId 同值）。 */
  executionId: string
  skillId: string
  skillTitle: string
  /** 执行终态（报告只在终态发布，故不含 running）。 */
  taskStatus: Exclude<TAgentWorkbenchTaskStatus, 'running'>
  /** 统计与展示数据。 */
  summary: IAgentWorkbenchTaskSummary
  /** 目标用例已不存在（v17 L2d）：报告入口禁用。 */
  skillMissing?: boolean
}

/**
 * 工作台只读视图卡片项（v17）：清单 / 详情 / 历史 / 体检 / 能力五张卡合一。
 *
 * 五张卡没有状态迁移（发布即终态），因此合成一种时间线项、由 `viewKind`
 * 决定渲染哪个子组件——与后端把五张卡合成一类块的取舍同源（技术方案 §3.1）。
 */
export interface IWorkbenchViewTimelineItem {
  kind: 'workbench_view'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 视图 ID（块的 blockId，也是行内操作回指的键）。 */
  viewId: string
  /** 视图种类：组件分派依据。 */
  viewKind: TAgentWorkbenchViewKind
  /** 本次视图对应的目标用例；清单卡与能力卡为 null。 */
  skillId: string | null
  /**
   * 渲染载荷（按 viewKind 区分，由平台宿主自取后填充）。
   *
   * 保持 `Record<string, unknown>` 原样存放：**窄化在各子组件内做一次带校验的
   * 转换**，而不是在归约层——归约层不该认识每种视图的字段（协议分层）。
   */
  payload: Record<string, unknown>
}

/**
 * 工作台提案卡片项（v17）：等用户确认后才生效的四类提案（E / V / L 组）。
 *
 * 与动作卡片同构：创建时 pending，用户操作后以同一 blockId 重发终态
 * （经 `patchWorkbenchProposalItem` 整体覆盖）。
 */
export interface IWorkbenchProposalTimelineItem {
  kind: 'workbench_proposal'
  blockId: string
  seq: number
  status: TAgentWorkBlockStatus
  /** 提案 ID：apply / cancel 的路径参数，也是本块的 blockId。 */
  proposalId: string
  /** 提案种类。 */
  proposalKind: TAgentWorkbenchProposalKind
  skillId: string
  skillTitle: string
  /** 卡片标题与一句话说明（服务端给出）。 */
  label: string
  description?: string
  /** 提案状态：终态时卡片定格、隐藏按钮。 */
  state: TAgentWorkbenchProposalState
  /** 人话对照（变更 / 清理 / 删除有；env-fill 为缺失项说明）。 */
  changes?: IProposalChange[]
  /** env-fill 专用：待补齐的 key 与用途摘要（**永不含值**）。 */
  envKeys?: Array<{ key: string; usage: string }>
  /** env-fill 的 key 级维护（新增 / 删除 key 名）。 */
  envKeyOps?: IEnvKeyOperation[]
  /** 是否需要前端二次弹框确认（报告清理与用例删除恒为 true）。 */
  requiresModalConfirm: boolean
  /** case-delete 专用：将一并删除的报告份数（弹框复述用）。 */
  reportCount?: number
  /** report-cleanup 专用：将释放的空间（字节）。 */
  releaseBytes?: number
  /** G5 专用：页面核对证据（举证区）。 */
  evidence?: ICaseRepairEvidence
  /** 终态说明（应用成功 / 冲突原因 / 失败原因）。 */
  resultMessage?: string
  /** 目标用例已不存在（v17 L2d）。 */
  skillMissing?: boolean
}

/** 时间线项判别联合。 */
export type TWorkTimelineItem =
  | IThinkingTimelineItem
  | IContentTimelineItem
  | IToolTimelineItem
  | ITodoTimelineItem
  | ICommandTimelineItem
  | IInteractionTimelineItem
  | INoticeTimelineItem
  | ITurnTimelineItem
  | IWorkbenchActionTimelineItem
  | IWorkbenchTaskTimelineItem
  | IWorkbenchReportTimelineItem
  | IWorkbenchViewTimelineItem
  | IWorkbenchProposalTimelineItem

/** 文件变更信号（供文件树组件消费）。 */
export interface IFileChangeSignal {
  seq: number
  operation: TAgentFileChangeOperation
  path: string
  newPath?: string
  sourceBlockId?: string
}

/** 事件流连接状态。 */
export type TWorkConnection = 'connecting' | 'live' | 'reconnecting' | 'offline'

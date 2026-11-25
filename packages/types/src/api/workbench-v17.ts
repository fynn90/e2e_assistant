/**
 * V17 工作台扩展的渲染协议契约（PRD `v17.md` / 技术方案 §4）。
 *
 * 本模块承载 v17 相对 v16 新增的两类块与一次判别式扩展：
 *   - `workbench_view`：**只读呈现**类卡片（用例清单 / 详情 / 执行历史 / 体检 /
 *     能力说明五种 `viewKind`）。五张卡没有状态迁移，合成一块后物化与恢复
 *     逻辑只写一遍（技术方案 §3.1）；
 *   - `workbench_proposal`：**用户确认后才生效**类卡片（用例变更 / 环境变量补齐 /
 *     报告清理 / 用例删除四种 `proposalKind`）。四张卡共用一个
 *     `pending → applied / cancelled / conflict / failed / expired` 状态机；
 *   - `workbench_task` 的 `batch` 分支：会话内连续执行（不是平台级批量任务）。
 *
 * 贯穿本模块的两条结构性约束（技术方案 §5.1 / §6.3）：
 *   1. **协议传的是选择，不是数据**——模型只说「渲染哪种视图、什么范围」，
 *      payload 全部由平台宿主自取后填充，模型无法伪造卡片里的数字；
 *   2. **值不经过 Agent**——env 补齐只传 key，值由前端随 apply 请求直连平台，
 *      不进入任何事件、工作块或模型上下文（D7 / PRD V3）。
 */

import type { TAgentWorkbenchAction } from './agent-work'

// ---------------------------------------------------------------------------
// 4.1 只读视图块 workbench_view（v17）
// ---------------------------------------------------------------------------

/** 只读视图的种类（PRD Q1–Q5 / R3 / H2）。 */
export type TAgentWorkbenchViewKind =
  /** 用例清单卡（Q1/Q2/Q3/Q6）。 */
  | 'skill-list'
  /** 用例详情卡（Q4/Q5）。 */
  | 'skill-detail'
  /** 执行历史卡（Q7）。 */
  | 'run-history'
  /** 体检卡（R3）。 */
  | 'readiness'
  /** 能力卡（H2/H3）。 */
  | 'capability'

/** 清单卡的筛选状态（Q3）。 */
export type TWorkbenchSkillListStatus =
  'missing-document' | 'missing-script' | 'never-executed' | 'last-failed'

/**
 * 用例清单卡的一行（Q1/Q6）。
 *
 * `canExecute` 由服务端**判定并给出**，不由前端从其他字段推断——与 v14 立下的
 * 「按字段分派，不做内容嗅探」一致：卡片上的按钮能不能点，必须是平台算出来的
 * 结论，而不是前端自己解释出来的。
 */
export interface IWorkbenchSkillRow {
  skillId: string
  title: string
  description: string
  hasSkillDocument: boolean
  hasPlaywrightScript: boolean
  baseUrl?: string
  tags?: string[]
  /**
   * 最近一次带报告的执行（无报告时缺省 = 从未执行过，Q7）。
   *
   * 取自持久化的 `summary.json`；**不解析报告 HTML 兜底**——HTML 无机器可读
   * 结构，靠中文标签正则取数会随视觉改版静默失真（技术方案 F4）。
   */
  latestRun?: {
    runId: string
    /** 报告目录时间戳推导出的 ISO 时间。 */
    at: string
    passed: number
    failed: number
    interrupted: number
    skipped: number
    durationMs: number
  }
  /**
   * 行内快捷操作（Q6）：点击后走**已有的动作接口**。
   *
   * 宿主在渲染清单卡时为每一行预先登记一张动作卡片记录（复用 v16 的
   * `publishAction` 登记机制），但**不另行发布卡片块**——否则清单卡旁边会
   * 多出 20 张动作卡片。这是「登记与呈现解耦」：清单卡是呈现，登记是为了
   * 让按钮可点。
   *
   * 缺省表示该行没有可用动作（登记失败），前端据此不渲染按钮——
   * 好过一个点了报错的按钮。
   */
  inlineActionId?: string
  inlineAction?: import('./agent-work').TAgentWorkbenchAction
}

/** 清单卡载荷（Q1–Q3）。 */
export interface ISkillListViewPayload {
  rows: IWorkbenchSkillRow[]
  /** 筛选后的命中总数（Q3 要求说明「筛出几个」）。 */
  total: number
  /** 工作区用例总数（未筛选前的规模，供卡片说明范围）。 */
  overallTotal?: number
  /** 当前生效的筛选条件（供卡片顶部说明「按『最近失败』筛出 3 个」）。 */
  filter?: {
    keyword?: string
    tag?: string
    status?: TWorkbenchSkillListStatus
  }
}

/** 详情卡载荷（Q4/Q5）。 */
export interface ISkillDetailViewPayload {
  skillId: string
  title: string
  description: string
  baseUrl?: string
  tags?: string[]
  preconditions: Array<{ id: string; description: string }>
  steps: Array<{
    id: string
    order: number
    description: string
    action: string
    expectedResult: string
    enabled: boolean
  }>
  hasSkillDocument: boolean
  hasPlaywrightScript: boolean
  /**
   * 脚本引用的 env **key 清单**——只列 key，值永不出现在此（D7）。
   *
   * 来源是 `collectEnvReferences(testCase)`（用例侧声明），**不是** J4 的
   * 脚本实际引用判定——两者通常相同但不保证相同（用户可能手改了脚本），
   * 卡片不得用一方的结论冒充另一方（技术方案 §6.1 易错点）。
   */
  envKeys: string[]
  /** 引用的 key 中在 env.json 里缺失的（与用例侧判定同源）。 */
  missingEnvKeys: string[]
  /** SKILL.md 正文。默认不在卡内展开（Q5），前端折叠展示。 */
  documentContent?: string
}

/** 执行历史卡载荷（Q7）。 */
export interface IRunHistoryViewPayload {
  skillId: string
  skillTitle: string
  runs: Array<{
    runId: string
    startedAt: string
    passed: number
    failed: number
    interrupted: number
    skipped: number
    total: number
    durationMs: number
    baseUrl?: string
  }>
  /** 更早的报告未在卡内列出（Q7 的如实说明）。 */
  truncatedAt: number
  /** 该用例从未执行过（无任何报告）。 */
  neverExecuted: boolean
}

/** 体检卡载荷（R3）。 */
export interface IReadinessViewPayload {
  skillId: string
  skillTitle: string
  ok: boolean
  checks: Array<{
    /** J1–J8 的既有 code。 */
    code: string
    /** 检查项人话名（如「脚本包含测试」「环境变量齐备」）。 */
    label: string
    ok: boolean
    message?: string
    /**
     * 修复入口（前端据此渲染按钮，Q6/E3 同构）。
     *
     * 与清单卡行内动作同构：`fixActionId` 是宿主**预先登记**的动作记录 ID
     *（登记与呈现解耦——体检卡是呈现，登记是为了让按钮可点）。
     */
    fixAction?: TAgentWorkbenchAction
    /** 已登记的修复动作 ID（缺省表示该检查项没有可点的修复入口）。 */
    fixActionId?: string
  }>
  /**
   * 全部通过时的「执行」入口（R3 ③：体检卡直接给出执行按钮，闭环到执行）。
   *
   * 与修复入口同一机制：宿主在渲染体检卡时预先登记一张 `execute-test` 动作。
   */
  executeActionId?: string
}

/** 能力卡载荷（H2/H3）。 */
export interface ICapabilityViewPayload {
  /** 能做的事（按能力域）。 */
  domains: Array<{ key: string; label: string; examples: string[] }>
  /** 明确不做的事（PRD §1.4 的「不接入」项与 U4 清单）。 */
  notSupported: Array<{ label: string; alternative: string }>
}

/**
 * 渲染请求的参数：按 viewKind 取其一（**模型只需给这些**）。
 *
 * 这是「协议传的是选择，不是数据」的类型表达：模型侧能表达的只有视图种类
 * 与范围，没有任何数据字段——宿主拿到它之后自己检索一遍再填 payload。
 */
export type TWorkbenchRenderParams =
  /** skill-list：筛选条件（模型直接透传用户表达的筛选意图）。 */
  | {
      viewKind: 'skill-list'
      status?: TWorkbenchSkillListStatus
      keyword?: string
      tag?: string
    }
  /** skill-detail / run-history / readiness：只要一个用例 ID。 */
  | { viewKind: 'skill-detail' | 'run-history' | 'readiness'; skillId: string }
  /** capability：无参数。 */
  | { viewKind: 'capability' }

/**
 * 只读视图块事件（begin 一次性，无 append）。
 *
 * 与 `interaction` 块的状态更新同构：需要原位更新时以同一 blockId 重发本事件
 * （清单卡筛选后即走这条路，见技术方案 §4.1 末注）。
 */
export interface IAgentWorkbenchViewEvent {
  type: 'workbench_view'
  phase: 'begin'
  /** 视图 ID：块的 blockId，也是前端行内操作回指的键。 */
  viewId: string
  viewKind: TAgentWorkbenchViewKind
  /** 本次视图对应的目标用例（清单卡与能力卡为 null）。 */
  skillId: string | null
  /**
   * 渲染载荷（按 viewKind 区分）。
   *
   * **由平台填充，不是模型给的**——模型只通过 `render_view` 的 `params` 表达
   * 「渲染哪种视图、什么范围」，宿主据此自取数据后填进这里。这是模型可见内容
   * 与卡片内容**结构性分离**的落点：模型无法伪造卡片里的数字。
   *
   * 用 `Record<string, unknown>` 而不是联合类型：与 `IAgentWorkBlock.payload`
   * 的既有约定一致（物化块本身就是「按 kind 区分的完整状态」），
   * 前端在 timeline 层做一次带校验的窄化。
   */
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 4.2 提案块 workbench_proposal（v17）
// ---------------------------------------------------------------------------

/** 提案种类（PRD E2 / V2 / L1 / L2）。 */
export type TAgentWorkbenchProposalKind =
  /** 用例数据变更（E 组）。 */
  | 'case-change'
  /** 环境变量补齐（V 组）。 */
  | 'env-fill'
  /** 报告清理（L1）。 */
  | 'report-cleanup'
  /** 用例删除（L2）。 */
  | 'case-delete'

/** 提案终态。 */
export type TAgentWorkbenchProposalState =
  /** 等待用户确认。 */
  | 'pending'
  /** 已应用（成功）。 */
  | 'applied'
  /** 用户取消。 */
  | 'cancelled'
  /** 应用时冲突，需重新提案（E4）。 */
  | 'conflict'
  /** 应用失败（校验不过、目标已变等）。 */
  | 'failed'
  /** 目标已不存在（如用例已被删除）。 */
  | 'expired'

/**
 * 人话对照的一行（E2 要求「不得把 JSON 丢给用户」）。
 *
 * **由平台计算，不由模型生成**：模型只给目标值，diff 由服务端读盘后算出来——
 * 这样「从什么改成什么」一定与磁盘事实一致，模型无法在其中夹带不实描述。
 */
export interface IProposalChange {
  /** 变更对象（人话，如「标题」「步骤 2」）。 */
  target: string
  /** 变更类型。 */
  op: 'add' | 'update' | 'remove' | 'toggle' | 'reorder'
  before?: string
  after?: string
}

/**
 * 提案来源（PRD G5b 的「意图来源」区分）。
 *
 * - `user`：E 组，用户主动要求改（断言层红线**不适用**——用户有权改自己的用例）；
 * - `agent-analysis`：G5，Agent 分析页面与用例不一致后提出（**红线适用**）。
 *
 * 为什么必须有这个字段而不是「靠模型自觉」：两条路径的合法改动范围**不同**，
 * 而模型无法可靠地自我分类。由 `propose_case_change` 与 `propose_case_repair`
 * 两个工具分别置位，**模型无从传**（R15），判定在服务端。
 */
export type TCaseChangeOrigin = 'user' | 'agent-analysis'

/**
 * 页面核对证据（PRD G5a/G5b）。
 *
 * **必填**：Agent 必须先通过浏览器核对页面（生成子会话本就具备该能力），
 * 把「页面实际是什么」写进来。工具宿主校验其非空且格式合法，
 * 并把它渲染进提案卡的举证区。
 *
 * 为什么必填而不是选填：若把「无证据」变成合法输入，就等于允许
 * 「脚本失败 → 反推用例错了」这种猜测——那是 PRD G5a 明确禁止的。
 * 必填是整个红线的第一道闸：**没有证据，工具调用直接失败。**
 */
export interface ICaseRepairEvidence {
  /** 页面实际情况（如「按钮文本为『保存』」）。 */
  actual: string
  /** 用例所写（如「步骤 2 期望点击『提交』按钮」）。 */
  expected: string
  /** 核对方式（快照 / 查询 / 截图）与位置，供用户复核。 */
  verifiedBy: string
}

/**
 * 用例变更的目标值（模型给出，不是 diff）。
 *
 * 为什么模型给目标值而不是差异：差异（从什么改成什么）要准确反映磁盘现状，
 * 而模型看到的是它读到的版本——两者可能已经不同。让服务端读盘再 diff，
 * 「原值」一侧就一定是事实。
 *
 * 步骤给**全量**而非增量的取舍：给全量则「漏步骤」的风险由卡片上显式列出的
 * `remove` 项兜住（用户看得见）；给增量则要模型自己定位目标步骤，定位错时更
 * 隐蔽（技术方案 §6.3 / R3）。
 */
export interface ICaseChangeTargets {
  title?: string
  description?: string
  baseUrl?: string
  tags?: string[]
  preconditions?: Array<{ id: string; description: string }>
  /** 完整的目标步骤数组（模型须先 read_test_case 拿到现状再改）。 */
  steps?: Array<{
    id: string
    order: number
    description: string
    action: string
    expectedResult: string
    testData?: Record<string, string>
    enabled: boolean
  }>
  /** G5（`origin: 'agent-analysis'`）必填的页面核对证据。 */
  evidence?: ICaseRepairEvidence
}

/** env-fill 提案的 key 级操作（PRD V6）。 */
export interface IEnvKeyOperation {
  key: string
  op: 'add' | 'remove'
  /** 用途摘要（展示用，说明这个 key 用在哪里）。 */
  usage?: string
}

/**
 * 提案块事件。
 *
 * 生命周期与动作卡片同构：只发 begin，状态变化以**同一 blockId** 重发本事件，
 * 客户端按 blockId 原位更新。
 */
export interface IAgentWorkbenchProposalEvent {
  type: 'workbench_proposal'
  phase: 'begin'
  /** 提案 ID：块的 blockId，也是 apply / cancel 的路径参数。 */
  proposalId: string
  proposalKind: TAgentWorkbenchProposalKind
  skillId: string
  skillTitle: string
  /** 卡片标题与一句话说明（服务端给出）。 */
  label: string
  description?: string
  state: TAgentWorkbenchProposalState
  /** 人话对照（case-change / report-cleanup / case-delete 有；env-fill 为缺失项说明）。 */
  changes?: IProposalChange[]
  /**
   * env-fill 专用：待补齐的 key 与用途摘要。
   *
   * **只含 key 与用途说明，永不含值**（D7）——值由用户在卡内输入后随
   * apply 请求直达平台，不进入本结构、不进入工作块。
   */
  envKeys?: Array<{ key: string; usage: string }>
  /**
   * env-fill 的 key 级维护（PRD V6）：新增 / 删除 key 名，不涉及值。
   *
   * 与 `envKeys` 的补齐语义分开：补齐是「补上缺失的值」，这里是
   * 「调整键名集合」。两者可同时出现在一份提案里。
   */
  envKeyOps?: IEnvKeyOperation[]
  /**
   * 是否需要前端二次弹框确认（D2）。
   *
   * 报告清理与用例删除恒为 true（PRD L1a / L2a）；变更与 env 补齐为 false
   * （它们本身就是「用户明确表达意图后才生成」的，再弹一次是重复确认）。
   * 由服务端按 proposalKind 判定并给出——前端不自行推断（规则单点）。
   */
  requiresModalConfirm: boolean
  /** case-delete 专用：将一并删除的报告份数（弹框复述「N 份报告」）。 */
  reportCount?: number
  /** report-cleanup 专用：将释放的空间（字节）。 */
  releaseBytes?: number
  /** G5 专用：页面核对证据（举证区渲染）。 */
  evidence?: ICaseRepairEvidence
  /** 终态说明（应用成功 / 冲突原因 / 失败原因）。 */
  resultMessage?: string
}

// ---------------------------------------------------------------------------
// 4.3 任务块扩 batch（v17）
// ---------------------------------------------------------------------------

/**
 * 连续执行的条目状态（PRD R4c / R4e）。
 *
 * 与批次状态分开：批次是 `running` 时，单个条目可能已 passed、已 skipped。
 */
export type TBatchItemStatus =
  /** 待执行。 */
  | 'pending'
  /** 执行中。 */
  | 'running'
  /** 通过。 */
  | 'passed'
  /** 存在失败。 */
  | 'failed'
  /** 已中断。 */
  | 'interrupted'
  /** 未就绪或已有任务，跳过（R4c）。 */
  | 'skipped'
  /** 因批次被停止而未执行（R4e）。 */
  | 'not-executed'

/**
 * 批次状态（PRD R4 三态）。
 *
 * `awaiting-confirmation` 是 PRD R4a 的「待确认」——它必须先于 running 存在，
 * 且**不占用执行通道**（尚未开始跑任何东西）。
 */
export type TBatchStatus =
  /** 待用户确认（尚未开始）。 */
  | 'awaiting-confirmation'
  /** 执行中。 */
  | 'running'
  /** 全部跑完（含跳过）。 */
  | 'completed'
  /** 被用户停止。 */
  | 'interrupted'
  /** 用户在待确认态取消。 */
  | 'cancelled'

/** 连续执行的单个条目（R4a–R4f）。 */
export interface IBatchItem {
  skillId: string
  skillTitle: string
  status: TBatchItemStatus
  /** 跳过原因（未就绪时的说明）。 */
  skippedReason?: string
  /** 就绪预判（待确认态展示，R4a）。 */
  readyCheck?: { ok: boolean; reason?: string }
  /** 执行 ID（内嵌执行区块取数用）。 */
  executionId?: string
  /** 报告运行 ID（报告入口）。 */
  runId?: string
  /** 该条执行的统计摘要。 */
  summary?: {
    total?: number
    passed?: number
    failed?: number
    interrupted?: number
    skipped?: number
    durationMs?: number
  }
}

/** 连续执行卡片的发布/更新入参。 */
export interface IBatchCardInput {
  /** 目标会话。 */
  sessionId: string
  /** 批次 ID。 */
  batchId: string
  /** 批次状态。 */
  batchStatus: TBatchStatus
  /** 条目清单与逐条状态。 */
  items: IBatchItem[]
  /** 条目上限（R4b 的 10）。 */
  batchLimit: number
  /** 批次创建时刻（毫秒时间戳，供运行中实时计时）。 */
  startedAt: number
  /** 失败或阻断原因。 */
  errorMessage?: string
}

// ---------------------------------------------------------------------------
// 4.4 报告摘要文件（v17，PRD Q7/Q9 的数据基础）
// ---------------------------------------------------------------------------

/**
 * 一次执行的持久化摘要（PRD Q7/Q9 的数据基础）。
 *
 * 为什么与报告 HTML 并列成文件、而不是塞进 HTML：
 *   1. HTML 是给人看的，其结构会随视觉改版变化——把数据解析寄托在 DOM 结构上
 *      会在每次改版时静默失效；摘要文件的结构由类型锁定，改版不影响；
 *   2. 历史卡要读 N 份报告，逐份解析 HTML 既慢又脆。
 *
 * 为什么不用数据库：报告本身就是文件系统的产物（用户可以手工删除报告目录，
 * 平台也提供删除入口）；摘要与报告**同生共死**才不会出现「报告已删、历史还在」
 * 的假数据。数据库会引入第二份真相与同步问题。
 */
export interface IExecutionRunSummary {
  schemaVersion: 1
  skillId: string
  skillTitle: string
  runId: string
  /** 执行开始时间（ISO）。 */
  startedAt: string
  baseUrl: string
  /** 逐项统计（与 `parseTestReportData` 的 stats 同源）。 */
  stats: {
    total: number
    passed: number
    failed: number
    timedOut: number
    interrupted: number
    skipped: number
    durationMs: number
  }
  /** 结果语义（PRD v11 第 9 章）。 */
  outcome: 'passed' | 'failed' | 'interrupted'
  /**
   * 失败定位（供 Agent 解读，Q8）；每条含测试标题、失败步骤 id 与错误摘要。
   *
   * `errorMessage` 是**经既有脱敏器处理后的**文本（技术方案 §8 净化要求），
   * 与日志同一条链路，不得直接落原始错误文本。
   */
  failures?: Array<{
    title: string
    stepId?: string
    errorMessage?: string
    hasScreenshot: boolean
  }>
  /** 报告文件是否存在（被手工删除后为 false，供 Q7 如实呈现）。 */
  reportFile: boolean
}

/** 摘要文件名（与 `report.html` 并列放在 `test_report/<runId>/` 下）。 */
export const TEST_REPORT_SUMMARY_FILE_NAME = 'summary.json'

// ---------------------------------------------------------------------------
// 4.5 能力清单（PRD H3 的事实来源）
// ---------------------------------------------------------------------------

/**
 * 平台能力清单（PRD H3：能力卡的内容必须与平台实际能力一致）。
 *
 * 为什么要类型化而不是写在提示词字符串里：
 *   能力卡是**结构化渲染**的，而提示词是**自然语言**。同一份事实若各写一遍，
 *   加一个能力时必然漏掉一处——那时能力卡会对用户承诺平台做不到的事，
 *   或者对能做的事说「不支持」。类型化后两处共用同一份数据（技术方案 §5.3）。
 */
export interface IWorkbenchCapabilityManifest {
  /** 能做的事：按能力域分组（与 PRD §4.0 的能力域一一对应）。 */
  domains: Array<{
    key: string
    label: string
    /** 该域能做的事的示例说法（供提示词与能力卡共用）。 */
    examples: string[]
  }>
  /** 明确不做的事 + 替代路径（PRD §4.9 U4 清单的同源数据）。 */
  notSupported: Array<{
    key: string
    label: string
    alternative: string
  }>
}

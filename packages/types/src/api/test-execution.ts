/**
 * 测试执行任务的跨包契约（v11，PRD 第 2 章 / 技术方案 §2）。
 *
 * 该文件只定义「执行任务」在 types / playwright-engine / apps/cli / apps/web
 * 之间流转的数据形状：
 *   - 执行状态机（TExecutionStatus）；
 *   - 单条测试结果与汇总（测试报告总结卡片的数据源）；
 *   - SSE / 快照共用的执行事件（含单调 seq，与 agent-work 事件总线同构）；
 *   - 发起执行的响应与快照恢复结构。
 *
 * 安全约定（PRD A3 / X3）：env.json 的值由 CLI 层在组装子进程环境时注入，
 * 本文件所有类型都没有承载 value 的字段，构成结构性隔离——只允许出现 key 名。
 */

/** 执行任务状态机：prechecking → running → completed | failed | interrupted。 */
export type TExecutionStatus =
  'prechecking' | 'running' | 'completed' | 'failed' | 'interrupted'

/** 单条测试的结果状态；timedOut / interrupted 按失败归类（PRD X11 / X12）。 */
export type TExecutionTestCaseStatus =
  'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped'

/** 单条测试结果摘要（报告与侧边栏步骤进度共用）。 */
export interface IExecutionTestCaseResult {
  /** 测试标题（test() 第一个参数）。 */
  title: string
  /** 测试最终状态。 */
  status: TExecutionTestCaseStatus
  /** 测试耗时（毫秒）。 */
  durationMs: number
  /** 失败时的错误信息摘要（已脱敏）。 */
  errorMessage?: string
  /** 失败发生的步骤 id（test.step 的第一参数，可定位时提供）。 */
  failedStepId?: string
}

/** 执行结果汇总（测试报告总结卡片数据源，PRD V1）。 */
export interface IExecutionSummary {
  /** 平台为本执行分配的唯一 ID（UUID）。 */
  executionId: string
  /** 运行时间戳（yyyyMMdd-HHmmss，本地时间；报告目录名）。 */
  runId: string
  /** 执行终态：completed（含失败用例）/ failed（环境错误）/ interrupted。 */
  status: TExecutionStatus
  /** 执行开始时间（ISO 字符串）。 */
  startedAt: string
  /** 总耗时（毫秒）。 */
  durationMs: number
  /** 测试总数。 */
  total: number
  /** 通过数。 */
  passed: number
  /** 失败数（含超时）。 */
  failed: number
  /** 中断数。 */
  interrupted: number
  /** 跳过数。 */
  skipped: number
  /** 每条测试的结果列表。 */
  results: IExecutionTestCaseResult[]
  /**
   * 报告在 Skill 目录内的相对路径（`test_report/<runId>/report.html`）；
   * 未生成报告（环境错误）时缺省。
   */
  reportRelativePath?: string
  /**
   * 本次执行的目标 URL（PRD v16 RPT-2 要求摘要展示）。
   *
   * 取自用例数据的 `baseUrl`——经 `validateBaseUrl` 校验的真实 URL，
   * 不含 `${ENV:KEY}` 引用，因此不违反 SEC-4（env 值不入卡片）。
   */
  baseUrl?: string
}

/** 执行过程的阶段标识（前端「执行过程」清单的排序与去重键）。 */
export type TExecutionStage =
  'precheck' | 'env' | 'chromium' | 'launch' | 'run' | 'report'

/** 阶段推进状态。 */
export type TExecutionStageStatus = 'start' | 'done' | 'fail'

/**
 * 执行事件（SSE 推送与快照补发共用）。
 *
 * `seq` 由服务端按执行任务单调分配；SSE 的 `id` 即 `seq`，
 * 客户端以 `afterSeq` 断线补发（PRD X16 导航/刷新恢复）。
 */
export type TExecutionEvent =
  | { type: 'status'; seq: number; status: TExecutionStatus }
  /** 已脱敏的平台事件与运行输出行。 */
  | { type: 'log'; seq: number; line: string }
  /**
   * 阶段推进事件：前端据此渲染「执行过程」清单
   * （就绪校验 → env 注入 → Chromium → 浏览器启动 → 测试执行 → 报告生成）。
   */
  | {
      type: 'stage'
      seq: number
      stage: TExecutionStage
      status: TExecutionStageStatus
      /** 面向用户的阶段说明（如「就绪校验通过（6 项）」）。 */
      label: string
    }
  | { type: 'test-start'; seq: number; title: string }
  | { type: 'test-end'; seq: number; result: IExecutionTestCaseResult }
  /** stepId 为脚本内 test.step 的第一参数（用例步骤 id，PRD X8）。 */
  | { type: 'step-start'; seq: number; testTitle: string; stepId: string }
  | { type: 'step-end'; seq: number; stepId: string; ok: boolean }
  /**
   * 执行过程产生的 Skill 文件变化（`test_report/...` 相对路径），
   * 供前端实时刷新文件树（PRD X17）；只携带路径，不携带内容。
   */
  | { type: 'files-changed'; seq: number; relativePaths: string[] }
  /** 执行结束的汇总（含报告路径）；终态事件的最后一条。 */
  | { type: 'summary'; seq: number; summary: IExecutionSummary }

/** 发起执行的响应数据。 */
export interface IStartExecutionResponse {
  executionId: string
  /** 目标 Skill 标题（执行区块头部展示）。 */
  skillTitle?: string
}

/** 删除一次执行报告的响应数据。 */
export interface IDeleteTestReportResponse {
  skillId: string
  runId: string
}

/** 执行任务的快照：导航/刷新后重建执行区块的数据源（PRD X16）。 */
export interface IExecutionSnapshot {
  executionId: string
  /** 目标 Skill 标题（执行区块头部展示）。 */
  skillTitle?: string
  /** 当前状态；终态后快照保留到服务重启或被新执行替换。 */
  status: TExecutionStatus
  /** 当前最大事件 seq（SSE afterSeq 补发的起点）。 */
  currentSeq: number
  /** 结果汇总；结束后提供。 */
  summary?: IExecutionSummary
  /** 就绪校验失败明细；本快照仅用于运行中/已结束任务，正常无此字段。 */
  issues?: Array<{ code: string; message: string; target?: string }>
  /** 环形缓冲内的最近事件（按 seq 升序），供直接重建展示。 */
  events: TExecutionEvent[]
}

/** 就绪校验问题（PRD J1–J8）；`target` 为建议跳转的目标面板。 */
export interface IExecutionPrecheckIssue {
  code: string
  message: string
  /** 建议跳转目标：env-file → env.json 编辑页；test-case → 用例编辑页。 */
  target?: 'env-file' | 'test-case'
}

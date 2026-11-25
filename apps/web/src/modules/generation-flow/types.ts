/**
 * 生成流程的共享类型契约。
 *
 * 这些类型描述「侧边栏里有什么」，是 store、卡片模型派生与渲染组件之间的
 * 稳定接口。独立成文件以避免 store ↔ 派生模块之间的循环依赖。
 */
import type {
  IFileSaveDiagnostic,
  IPlaywrightStepCoverage,
} from '@authine-e2e-agent/types'
import type { IUseAgentWorkTimeline } from '../agent-work/timeline'
import type { TAutoSaveState } from '../../common/autosave/types'

/** 阶段种类，按发生顺序：skill → script。 */
export type TStageKind = 'skill' | 'script'

/**
 * 阶段 UI 状态。
 *
 * 前两组来自两个生成状态机；`completed` / `failed` / `cancelled` 为终态，
 * `conflict` 为保存冲突（生成成功但落盘被拒）。
 */
export type TStageStatus =
  | 'idle'
  | 'saving-source'
  | 'requesting-model'
  | 'writing-skill'
  | 'repairing-output'
  | 'validating-output'
  | 'saving-skill'
  | 'preparing'
  | 'verifying-page'
  | 'generating-script'
  | 'validating-code'
  | 'saving-script'
  | 'preview'
  | 'completed'
  | 'conflict'
  | 'failed'
  | 'cancelled'

/** 流程整体阶段（派生出标题栏副标题，PRD 5.2）。 */
export type TFlowPhase =
  | 'idle'
  | 'skill-running'
  | 'skill-completed'
  | 'skill-failed'
  | 'skill-cancelled'
  | 'script-running'
  | 'script-completed'
  | 'script-failed'
  | 'script-cancelled'

/** 产物卡片种类。 */
export type TProductCardKind = 'skill-document' | 'playwright-script'

/** 生成警告（两类产物共用形状）。 */
export interface IProductWarning {
  code: string
  message: string
  /** 展现级别；服务端下发，用于区分「提示」与「警告」。 */
  severity: 'info' | 'warning'
  stepId?: string
}

/**
 * 产物卡片：承载「结果」，**不可折叠**（PRD 5.4）。
 *
 * 只在阶段状态为「完成」时产出。
 */
export interface IProductCard {
  /** 唯一标识（阶段 + 版本），用于列表 key 与「最新卡片」判定。 */
  key: string
  kind: TProductCardKind
  /** 产物文件名：`SKILL.md` / `test.spec.ts`。 */
  fileName: string
  /** 当前编辑内容（本地 ref，输入与保存解耦）。 */
  content: string
  /** 视图模式：预览 / 源码（仅 SKILL.md 卡片有预览）。 */
  viewMode: 'preview' | 'source'
  /** 完成说明（一句话说明当前状态与下一步）。 */
  completionHint: string
  warnings: IProductWarning[]
  assumptions: string[]
  environmentVariables: string[]
  stepCoverage: IPlaywrightStepCoverage[]
  meta: {
    testCaseVersion?: string
    /** 文档 / 脚本版本。 */
    version: string
    /** 脚本修改时间。 */
    updatedAt?: string
    /** 上次生成时间。 */
    generatedAt?: string
  }
  /** 保存状态（来自 useAutoSave）。 */
  saveState: TAutoSaveState
  diagnostics: readonly IFileSaveDiagnostic[]
  /** 主按钮执行结果（用于置灰 + 时间戳，PRD 6.7）。 */
  primaryAction?: { executedAt: string; label: string }
}

/**
 * 终止卡片：阶段失败或被取消时出现（PRD 6.5）。
 *
 * 出现时**不出现**产物卡片。
 */
export interface IFailureCard {
  key: string
  kind: TStageKind
  /** 卡片头的产物名（`SKILL.md` / `test.spec.ts`）。 */
  fileName: string
  /** 状态徽标：失败 / 已停止。 */
  status: 'failed' | 'cancelled'
  /** 失败原因摘要（遵循既有脱敏与截断约束）。 */
  errorMessage: string
  /** 已完成的部分：失败前是否已有内容写入磁盘（PRD 10.3）。 */
  partialWriteHint?: string
  /** 下一步建议。 */
  nextStepHint: string
}

/**
 * 一个生成阶段在侧边栏中的呈现记录。
 *
 * 阶段区块承载「过程」，**可折叠**（终态自动折叠，PRD 5.3）。
 */
export interface IStageRecord {
  kind: TStageKind
  /** 阶段显示名（`SKILL 阶段` / `Playwright 脚本阶段`）。 */
  title: string
  status: TStageStatus
  /** 该阶段独立的 Agent 工作时间线（非单例，见技术方案 6.4）。 */
  timeline: IUseAgentWorkTimeline
  /** 该阶段产出的产物卡片；运行中或失败时为 null。 */
  card: IProductCard | null
  /** 该阶段失败或被取消时的终止卡片；正常时为 null。 */
  failureCard: IFailureCard | null
  /** 运行中反馈：阶段文案。 */
  stageText: string
  /** 是否可取消（沿用既有 cancelable 约束）。 */
  cancelable: boolean
  /** 开始时间，用于置灰按钮的时间戳标记。 */
  startedAt: string
  /** 终态时间。 */
  settledAt?: string
}

/** 侧边栏内容项：阶段区块与卡片按发生顺序平级排列（PRD 5.4）。 */
export type TSidebarItem =
  | { kind: 'stage'; key: string; stage: IStageRecord }
  | { kind: 'card'; key: string; card: IProductCard }
  | { kind: 'failure'; key: string; card: IFailureCard }

/** 阶段状态是否为终态（决定自动折叠与关闭按钮归属）。 */
export function isTerminalStatus(status: TStageStatus): boolean {
  return ['completed', 'failed', 'conflict', 'cancelled'].includes(status)
}

/** 阶段是否正在运行（决定关闭按钮显隐，PRD 6.6）。 */
export function isStageRunning(stage: IStageRecord): boolean {
  return !isTerminalStatus(stage.status)
}

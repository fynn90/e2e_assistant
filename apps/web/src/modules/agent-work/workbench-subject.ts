/**
 * 工作台显示主体的跨 store 编排（v13 PRD §4.2 C 组、技术方案 §3.7）。
 *
 * 为什么独立成模块而不写进 `global-chat` store：`generation-flow` 已经 import
 * 了 `global-chat`（用于 expand / collapse），若后者反向 import 前者就会形成
 * 模块环。本模块处在两者**之上**，是唯一同时认识它们的点，由组件调用。
 *
 * 本模块只做编排（决定清空 / 切换 / 拒绝），不含任何 UI —— 确认弹窗与提示
 * 由调用方注入（依赖倒置），因此三条分支都可独立单测。
 */
import type { IWorkbenchSubject } from '../../stores/global-chat'

/** 主体种类（与 `IWorkbenchSubject['kind']` 同源，避免调用点重复书写字面量）。 */
export type TSubjectKind = IWorkbenchSubject['kind']

/** 发起前编排的结果。 */
export type TBeginSubjectOutcome =
  'started' | 'cancelled' | 'rejected-running-generation'

/** 发起前编排的输入。 */
export interface IBeginSubjectOptions {
  /** 即将发起的工作项种类。 */
  kind: TSubjectKind
  /** 目标来源 Skill。 */
  skillId: string
  /** 当前显示主体；null 表示空态。 */
  current: IWorkbenchSubject | null
  /** 当前显示主体是否仍在运行。 */
  currentRunning: boolean
  /**
   * 需要用户确认时调用（PRD C-5 第 ① 条：执行运行中切换）。
   *
   * @param message - 面向用户的确认文案。
   * @returns 用户同意切换时返回 true。
   */
  confirm: (message: string) => Promise<boolean>
}

/**
 * 判定新工作项是否可以发起（PRD §4.2 C-2 ~ C-5）。
 *
 * 判定顺序：
 *   1. 无显示主体 → 直接发起（C-3：空态不产生额外行为）；
 *   2. 有主体但已终态 → 直接发起（发起方随后清空旧内容，C-2/C-6）；
 *   3. 有主体且运行中，且**旧主体是执行** → 先确认再发起（C-5 第 ① 条）；
 *   4. 有主体且运行中，且**旧主体是生成** → 拒绝（C-5 第 ② 条）。
 *
 * **为什么两者的处置不同**（技术方案 §3.5）：执行由平台服务端独立承载，
 * 前端不再观察它仍会跑完；而生成的前端流就是它的生命周期——中止连接会终止
 * 服务端的运行轮次。若对生成也承诺「切换后仍继续运行」，那是欺骗用户。
 *
 * @param options - 见 `IBeginSubjectOptions`。
 * @returns 编排结果。
 * @throws 不抛出异常；`confirm` 的异常由调用方负责。
 */
export async function beginSubject(
  options: IBeginSubjectOptions,
): Promise<TBeginSubjectOutcome> {
  const { current, currentRunning } = options

  // 1 + 2：无主体或已终态 —— 直接发起。
  if (!current || !currentRunning) return 'started'

  // 4：生成运行中不得切换（破坏性，且无先例入口）。
  if (current.kind === 'generation') return 'rejected-running-generation'

  // 3：执行运行中 —— 确认后切换。
  const agreed = await options.confirm(describeSwitchConfirm(current))
  return agreed ? 'started' : 'cancelled'
}

/**
 * 生成切换确认文案（PRD C-5 第 ① 条）。
 *
 * 必须说清「进度不再显示」与「任务仍会继续运行」两件事，并给出回看路径；
 * 只说「确定切换吗」会让用户以为任务会被中止。
 *
 * @param subject - 仍在运行的主体。
 * @returns 面向用户的确认文案。
 * @throws 不抛出异常。
 */
export function describeSwitchConfirm(subject: IWorkbenchSubject): string {
  const target = subject.skillTitle ? `「${subject.skillTitle}」` : '该 Skill'
  return (
    `当前有正在运行的任务（${target}），切换后其进度将不再在工作台显示。` +
    `任务仍会继续运行，可在该 Skill 的开发页查看。是否继续？`
  )
}

/**
 * 生成运行中被拒绝的说明文案（PRD C-5 第 ② 条）。
 *
 * @param fileName - 正在生成的产物名（`SKILL.md` / `test.spec.ts`）。
 * @returns 面向用户的说明。
 * @throws 不抛出异常。
 */
export function describeGenerationRejection(fileName: string): string {
  return `正在生成 ${fileName}，请等待完成或先停止生成。`
}

/**
 * 由阶段记录派生「正在生成的产物名」，用于拒绝文案（PRD C-5 第 ② 条）。
 *
 * @param kind - 运行中的阶段种类。
 * @returns 产物文件名。
 * @throws 不抛出异常。
 */
export function fileNameForStage(kind: TStageKindLike): string {
  return kind === 'skill' ? 'SKILL.md' : 'test.spec.ts'
}

/** 阶段种类（与 `generation-flow` 的 `TStageKind` 同形，避免为一行判断引入类型依赖）。 */
export type TStageKindLike = 'skill' | 'script'

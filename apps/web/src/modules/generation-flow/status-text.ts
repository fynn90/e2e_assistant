/**
 * 生成流程的标题栏文案派生（PRD 5.2）。
 *
 * 副标题是**流程级**状态，只反映「当前走到哪一步、结果如何」，
 * **不反映保存状态**（保存状态在卡片上，见 PRD 7.4）。
 *
 * 文案表集中在此处而非散落在组件内，满足「状态判定逻辑集中在独立模块」的约束。
 */
import type { TFlowPhase } from './types'

/**
 * 由流程阶段派生标题栏副标题。
 *
 * @param phase - 当前流程整体阶段。
 * @returns 副标题文案；空态返回空串（不展示副标题）。
 */
export function deriveSubtitle(phase: TFlowPhase): string {
  return FLOW_SUBTITLE_TABLE[phase]
}

/**
 * 副标题文案表（PRD 5.2 九种状态，逐项覆盖）。
 *
 * `idle` 对应「无流程数据（空态）」——不展示副标题。
 */
const FLOW_SUBTITLE_TABLE: Record<TFlowPhase, string> = {
  idle: '',
  'skill-running': 'SKILL.md 生成中',
  'skill-completed': 'SKILL.md 完成',
  'skill-failed': 'SKILL.md 生成失败',
  'skill-cancelled': 'SKILL.md 生成已停止',
  'script-running': 'Playwright 脚本生成中',
  'script-completed': 'Playwright 脚本生成完成',
  'script-failed': 'Playwright 脚本生成失败',
  'script-cancelled': 'Playwright 脚本生成已停止',
}

/**
 * 阶段运行中反馈的文案表。
 *
 * 沿用既有弹窗文案，让用户不看时间线也知道当前处于哪一步（PRD 9 T2）。
 */
export const STAGE_TEXT_TABLE: Record<string, string> = {
  // SKILL 阶段
  'saving-source': '正在保存最新结构化用例…',
  'requesting-model': '正在请求 Chat Agent…',
  'writing-skill': 'Agent 正在写入当前 Skill 的 SKILL.md…',
  'repairing-output': '正在等待 Agent 修复输出结构…',
  'validating-output': '正在校验 Agent 写入的 SKILL.md…',
  'saving-skill': '正在保存 SKILL.md…',
  // 脚本阶段
  preparing: '正在检查模型与本地生成环境…',
  'verifying-page': 'Agent 正在访问目标页面并核对页面元素…',
  'generating-script': 'Agent 正在生成脚本…',
  'validating-code': '正在执行 TypeScript 和安全校验…',
  'saving-script': '正在保存 test.spec.ts…',
}

/**
 * 断言层红线的字段级判定（v17 §6.5.1，PRD G5c）。
 *
 * ## 为什么必须在代码里强制，而不能只靠提示词
 *
 * 这条红线的失败模式是「**测试配合缺陷**」：把预期结果从 `/dashboard` 改成
 * `/home`，测试通过，而缺陷被掩盖——自动化测试里最坏的一种失败。
 * 提示词可以被绕过，因此平台侧必须有兜底。
 *
 * ## 判据是 diff 的结果，不是模型的自述
 *
 * 模型说「我只改了动作」不作数，必须让 diff 说话。因此本模块只吃
 * 「磁盘上的当前用例」与「变更后的目标用例」两份数据。
 *
 * ## 归类原则（新增字段时的依据，R14）
 *
 * **描述「应该得到什么」的字段属断言层**——`expectedResult`、用例标题 /
 * 描述里描述的预期行为。描述「怎么做到」的字段不属断言层——`action`、
 * `description`（步骤名）、`testData`、`preconditions`、新增步骤。
 *
 * 这条原则写在这里而不是留给后来者猜：判定按**字段清单逐项**做，
 * 新增字段必须显式归类，否则红线会出现缺口。
 *
 * ## 只对 G5 生效
 *
 * E 组（用户主动要求改）不受此限——用户有权改自己的用例。区分靠调用方传入的
 * `origin`，而 `origin` 由工具签名固定（`propose_case_change` → `user`、
 * `propose_case_repair` → `agent-analysis`），模型无从传（R15）。
 */

import type { IE2ETestCase } from '@fynn90-e2e_assistant/types'

/** 触碰断言层的单条记录。 */
export interface IAssertionLayerViolation {
  /** 位置路径（如 `steps[2].expectedResult`），供日志与排查。 */
  path: string
  /** 人话原因（谁被改成了什么，为什么不许改）。 */
  reason: string
}

/**
 * 判断一份用例变更是否触碰断言层（PRD G5c）。
 *
 * 在 **create 与 apply 两处都调用**：create 时拒绝并说明，apply 时再拒一次
 *（防止提案在用户确认与写入之间被篡改）。
 *
 * @param current - 磁盘上的当前用例。
 * @param target - 变更后的目标用例。
 * @returns 触碰的断言层项；为空表示仅在允许范围内。
 * @throws 不抛出异常。
 */
export function findAssertionLayerChanges (
  current: IE2ETestCase,
  target: IE2ETestCase,
): IAssertionLayerViolation[] {
  const violations: IAssertionLayerViolation[] = []

  // ① 用例标题 / 描述里描述的预期行为（G5c ②）。
  //    这一条只在 G5 通道判定：用户主动改标题是合法需求（E 组不受限）。
  if (current.title !== target.title) {
    violations.push({
      path: 'title',
      reason: `用例标题被修改（「${current.title}」→「${target.title}」）。标题描述的预期行为属断言层，不能改。`,
    })
  }
  if (current.description !== target.description) {
    violations.push({
      path: 'description',
      reason:
        '用例描述被修改。描述里的预期行为属断言层；若描述与实际不符，应如实报告可能是被测系统的缺陷，建议人工确认。',
    })
  }

  // ② 步骤数量减少（G5c ③ 的「删除步骤绕过失败」）。
  if (target.steps.length < current.steps.length) {
    const removedCount = current.steps.length - target.steps.length
    const removedTitles = current.steps
      .filter((step) => !target.steps.some((item) => item.id === step.id))
      .map((step) => `第 ${step.order} 步「${step.description}」`)
    violations.push({
      path: 'steps',
      reason: `步骤数从 ${current.steps.length} 减为 ${target.steps.length}（减少 ${removedCount}）。${removedTitles.length > 0 ? `被移除：${removedTitles.join('、')}。` : ''
        }删除步骤是绕过失败的一种形式，不能做。`,
    })
  }

  // ③ 逐步骤比对（按 id 匹配；id 变了视为「删旧增新」，由 ② 与 ④ 覆盖）。
  for (const targetStep of target.steps) {
    const currentStep = current.steps.find((step) => step.id === targetStep.id)
    if (!currentStep) continue

    // ③a 预期结果（G5c ①：断言本体）。
    if (currentStep.expectedResult !== targetStep.expectedResult) {
      violations.push({
        path: `steps[${currentStep.order}].expectedResult`,
        reason: `第 ${currentStep.order} 步的预期结果被修改（「${currentStep.expectedResult}」→「${targetStep.expectedResult}」）。预期与实际不符极可能是被测系统的缺陷，不能改。`,
      })
    }

    // ③b 含断言的步骤被停用（G5c ③ 的另一种形式）。
    if (currentStep.enabled && !targetStep.enabled) {
      violations.push({
        path: `steps[${currentStep.order}].enabled`,
        reason: `第 ${currentStep.order} 步被停用。停用步骤来「绕过」失败与删除步骤等价，不能做。`,
      })
    }
  }

  return violations
}

/**
 * 把违规列表渲染成给模型看的拒绝文案（G5d 的落点）。
 *
 * **不返回「拒绝」就结束**：文案本身承担教育职责——模型收到后应转而执行
 * G5d 的行为（如实报告可能是缺陷、给查看入口），而不是换条路绕。
 * 这与 v16 守卫「阻断并给正确方向」同一思路。
 *
 * @param violations - 命中的违规项。
 * @returns 面向模型的引导文案。
 * @throws 不抛出异常。
 */
export function describeAssertionLayerRefusal (
  violations: ReadonlyArray<IAssertionLayerViolation>,
): string {
  const details = violations.map((item) => `- ${item.reason}`).join('\n')
  return [
    '断言层变更已被平台拒绝：',
    details,
    '',
    '**这不是死路**——正确做法是如实报告，而不是换一种方式绕过：',
    '把「用例预期什么、页面实际什么」告知用户，说明这**可能是被测系统的缺陷**，',
    '建议人工确认这是预期变更还是缺陷，并提供「查看报告」与「在开发页打开用例」入口。',
    '若用户坚持要改，说明该改动会掩盖可能的缺陷；用户确认是产品变更时，',
    '引导他到用例编辑页修改并记录原因——你不要生成这个修改提案。',
  ].join('\n')
}

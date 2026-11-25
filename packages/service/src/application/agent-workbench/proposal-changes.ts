/**
 * 提案的人话对照计算（v17 §6.3）：把「模型给的目标值」与「磁盘现状」
 * diff 成人话，供提案卡展示。
 *
 * ## 为什么由服务端算，而不是让模型写
 *
 * PRD E2 的硬要求是「不得把 JSON 丢给用户」。而模型看到的是它**读到的版本**——
 * 与磁盘可能已经不同。让服务端读盘再 diff：
 *   - 「从什么改成什么」一定与磁盘一致，模型无法在其中夹带不实描述；
 *   - 步骤的**删除会被显式列出**（`op: 'remove'`）——模型若漏掉一个步骤，
 *     用户在卡片上会看到「将删除步骤 2」，不会静默丢失（R3 的对策）。
 */

import type {
  ICaseChangeTargets,
  IProposalChange,
  IE2ETestCase,
} from '@authine-e2e-agent/types'

/** 步骤比对用的最小形状（磁盘与目标两侧共用）。 */
interface IStepLike {
  id: string
  order: number
  description: string
  action: string
  expectedResult: string
  enabled: boolean
}

/**
 * 计算用例变更的人话对照（E2）。
 *
 * @param current - 磁盘上的当前用例。
 * @param targets - 模型给出的目标值（只含要改的字段）。
 * @returns 逐条的人话对照；无变化时为空数组。
 * @throws 不抛出异常。
 */
export function diffCaseChange(
  current: IE2ETestCase,
  targets: ICaseChangeTargets,
): IProposalChange[] {
  const changes: IProposalChange[] = []

  if (targets.title !== undefined && targets.title !== current.title) {
    changes.push({
      target: '标题',
      op: 'update',
      before: current.title,
      after: targets.title,
    })
  }
  if (
    targets.description !== undefined &&
    targets.description !== current.description
  ) {
    changes.push({
      target: '描述',
      op: 'update',
      before: truncate(current.description),
      after: truncate(targets.description),
    })
  }
  if (targets.baseUrl !== undefined && targets.baseUrl !== current.baseUrl) {
    changes.push({
      target: '目标地址',
      op: 'update',
      before: current.baseUrl || '（未配置）',
      after: targets.baseUrl || '（清空）',
    })
  }

  if (targets.tags !== undefined) {
    changes.push(...diffStringSet('标签', current.tags, targets.tags))
  }

  if (targets.preconditions !== undefined) {
    changes.push(
      ...diffPreconditions(current.preconditions, targets.preconditions),
    )
  }

  if (targets.steps !== undefined) {
    changes.push(...diffSteps(current.steps, targets.steps))
  }

  return changes
}

/**
 * 比对字符串集合（标签）的新增与移除。
 *
 * @param label - 人话对象名。
 * @param before - 当前集合。
 * @param after - 目标集合。
 * @returns 逐条对照。
 * @throws 不抛出异常。
 */
function diffStringSet(
  label: string,
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): IProposalChange[] {
  const changes: IProposalChange[] = []
  const beforeSet = new Set(before)
  const afterSet = new Set(after)

  for (const item of after) {
    if (!beforeSet.has(item)) {
      changes.push({ target: `${label}「${item}」`, op: 'add' })
    }
  }
  for (const item of before) {
    if (!afterSet.has(item)) {
      changes.push({
        target: `${label}「${item}」`,
        op: 'remove',
        before: item,
      })
    }
  }

  return changes
}

/**
 * 比对前置条件集合（按 id 匹配）。
 *
 * @param before - 当前前置条件。
 * @param after - 目标前置条件。
 * @returns 逐条对照。
 * @throws 不抛出异常。
 */
function diffPreconditions(
  before: ReadonlyArray<{ id: string; description: string }>,
  after: ReadonlyArray<{ id: string; description: string }>,
): IProposalChange[] {
  const changes: IProposalChange[] = []

  for (const item of after) {
    const existing = before.find((current) => current.id === item.id)
    if (!existing) {
      changes.push({
        target: `前置条件「${item.description}」`,
        op: 'add',
        after: item.description,
      })
    } else if (existing.description !== item.description) {
      changes.push({
        target: `前置条件 ${item.id}`,
        op: 'update',
        before: existing.description,
        after: item.description,
      })
    }
  }

  for (const item of before) {
    if (!after.some((target) => target.id === item.id)) {
      changes.push({
        target: `前置条件「${item.description}」`,
        op: 'remove',
        before: item.description,
      })
    }
  }

  return changes
}

/**
 * 比对步骤集合（按 id 匹配，逐字段对照）。
 *
 * 新增步骤给出「将新增」；被移除的步骤**显式列出**（用户看得见，R3 的对策）；
 * 顺序变动单独列为 `reorder`。
 *
 * @param before - 当前步骤。
 * @param after - 目标步骤。
 * @returns 逐条对照。
 * @throws 不抛出异常。
 */
function diffSteps(
  before: ReadonlyArray<IStepLike>,
  after: ReadonlyArray<IStepLike>,
): IProposalChange[] {
  const changes: IProposalChange[] = []

  for (const step of after) {
    const existing = before.find((current) => current.id === step.id)
    const position = `步骤 ${step.order}`

    if (!existing) {
      changes.push({
        target: `${position}「${step.description}」`,
        op: 'add',
        after: step.description,
      })
    } else {
      if (existing.order !== step.order) {
        changes.push({
          target: position,
          op: 'reorder',
          before: `第 ${existing.order} 位`,
          after: `第 ${step.order} 位`,
        })
      }
      if (existing.description !== step.description) {
        changes.push({
          target: `${position} 描述`,
          op: 'update',
          before: existing.description,
          after: step.description,
        })
      }
      if (existing.action !== step.action) {
        changes.push({
          target: `${position} 操作`,
          op: 'update',
          before: existing.action,
          after: step.action,
        })
      }
      if (existing.expectedResult !== step.expectedResult) {
        changes.push({
          target: `${position} 预期结果`,
          op: 'update',
          before: existing.expectedResult,
          after: step.expectedResult,
        })
      }
      if (existing.enabled !== step.enabled) {
        changes.push({
          target: `${position} 启用状态`,
          op: 'toggle',
          before: existing.enabled ? '启用' : '停用',
          after: step.enabled ? '启用' : '停用',
        })
      }
    }
  }

  // 被移除的步骤必须显式列出：模型漏掉一个步骤时用户能在卡片上看到。
  for (const step of before) {
    if (!after.some((target) => target.id === step.id)) {
      changes.push({
        target: `步骤 ${step.order}「${step.description}」`,
        op: 'remove',
        before: step.description,
      })
    }
  }

  return changes
}

/**
 * 计算报告清理的人话对照（L1）。
 *
 * 每条报告给出「时间 + 结果」，让用户能判断删的是什么。
 *
 * @param runs - 待删除的报告摘要（时间与结果）。
 * @returns 逐条对照。
 * @throws 不抛出异常。
 */
export function diffReportCleanup(
  runs: ReadonlyArray<{
    runId: string
    at: string
    passed: number
    failed: number
  }>,
): IProposalChange[] {
  return runs.map((run) => {
    const result =
      run.failed > 0
        ? `有失败（失败 ${run.failed}）`
        : `全部通过（${run.passed} 条）`
    return {
      target: `报告 ${run.runId}`,
      op: 'remove',
      before: `${formatTime(run.at)} · ${result}`,
    }
  })
}

/**
 * 计算用例删除的人话对照（L2）。
 *
 * @param input - 用例标题与将一并删除的资产摘要。
 * @returns 逐条对照。
 * @throws 不抛出异常。
 */
export function diffCaseDeletion(input: {
  skillTitle: string
  hasSkillDocument: boolean
  hasPlaywrightScript: boolean
  reportCount: number
}): IProposalChange[] {
  const changes: IProposalChange[] = [
    { target: '用例目录', op: 'remove', before: input.skillTitle },
  ]

  if (input.hasSkillDocument) {
    changes.push({ target: 'SKILL.md', op: 'remove' })
  }
  if (input.hasPlaywrightScript) {
    changes.push({ target: 'test.spec.ts', op: 'remove' })
  }
  if (input.reportCount > 0) {
    changes.push({
      target: `测试报告（${input.reportCount} 份）`,
      op: 'remove',
    })
  }
  changes.push({ target: '用户产物（userWorkSpace 及其内容）', op: 'remove' })

  return changes
}

/** 截断过长的文本（卡片上的描述不需要全文）。 */
function truncate(value: string, limit = 120): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/** 把 ISO 时间渲染为可读的本地时间（失败时原样返回）。 */
function formatTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  return new Date(parsed).toLocaleString()
}

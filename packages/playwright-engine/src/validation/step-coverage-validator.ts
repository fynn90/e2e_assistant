/** 通过固定 `test.step(stepId)` 结构重新计算候选脚本的步骤覆盖。 */

import ts from 'typescript'
import type {
  IPlaywrightStepCoverage,
  IValidationTestCase,
} from '../contracts/validation'
import {
  createNodeIssue,
  getCallName,
  getStringLiteralValue,
  visitNodes,
} from './ast-utils'
import type { IPlaywrightValidationIssue } from './validation-types'

export interface IStepCoverageResult {
  issues: IPlaywrightValidationIssue[]
  coverage: IPlaywrightStepCoverage[]
}

/**
 * 校验每个启用步骤恰好由一个 `test.step('<step-id>')` 包裹，并包含操作和断言。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param testCase - 当前 SDK 最小用例。
 * @returns 从 AST 计算的覆盖结果和违规问题。
 * @throws 不抛出异常。
 */
export function validateStepCoverage(
  sourceFile: ts.SourceFile,
  testCase: IValidationTestCase,
): IStepCoverageResult {
  const issues: IPlaywrightValidationIssue[] = []
  const coverageById = new Map<string, IPlaywrightStepCoverage[]>()
  const knownSteps = new Map(testCase.steps.map((step) => [step.id, step]))

  visitNodes(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      getCallName(node.expression) !== 'test.step'
    ) {
      return
    }

    const stepId = getStringLiteralValue(node.arguments[0])

    if (!stepId) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'STEP_ID_LITERAL_REQUIRED',
          message: 'test.step() 第一个参数必须是稳定步骤 ID 字符串。',
          severity: 'warning',
        }),
      )
      return
    }

    const callback = node.arguments[1]
    const counts = callback
      ? countStepCalls(callback)
      : { operations: 0, assertions: 0 }
    const coverage = { stepId, ...counts }
    coverageById.set(stepId, [...(coverageById.get(stepId) ?? []), coverage])

    const knownStep = knownSteps.get(stepId)

    if (!knownStep) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'UNKNOWN_STEP_ID',
          message: `脚本包含未知步骤 ID：${stepId}。`,
          severity: 'warning',
          stepId,
        }),
      )
    } else if (!knownStep.enabled) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'DISABLED_STEP_INCLUDED',
          message: `禁用步骤 ${stepId} 不得出现在生成脚本中。`,
          severity: 'warning',
          stepId,
        }),
      )
    }
  })

  for (const step of testCase.steps.filter((item) => item.enabled)) {
    const entries = coverageById.get(step.id) ?? []

    if (entries.length === 0) {
      issues.push({
        code: 'STEP_NOT_COVERED',
        message: `启用步骤 ${step.id} 未被脚本覆盖。`,
        severity: 'warning',
        stepId: step.id,
      })
      continue
    }

    if (entries.length > 1) {
      issues.push({
        code: 'STEP_DUPLICATED',
        message: `启用步骤 ${step.id} 在脚本中出现多次。`,
        severity: 'warning',
        stepId: step.id,
      })
    }

    const entry = entries[0]

    if (entry && entry.operations < 1) {
      issues.push({
        code: 'STEP_OPERATION_REQUIRED',
        message: `步骤 ${step.id} 至少需要一个 Playwright 操作。`,
        severity: 'warning',
        stepId: step.id,
      })
    }

    if (entry && entry.assertions < 1) {
      issues.push({
        code: 'STEP_ASSERTION_REQUIRED',
        message: `步骤 ${step.id} 至少需要一个 expect() 断言。`,
        severity: 'warning',
        stepId: step.id,
      })
    }
  }

  return {
    issues,
    coverage: [...coverageById.values()]
      .flat()
      .filter((entry) => knownSteps.get(entry.stepId)?.enabled)
      .sort((left, right) => {
        const leftOrder = knownSteps.get(left.stepId)?.order ?? 0
        const rightOrder = knownSteps.get(right.stepId)?.order ?? 0
        return leftOrder - rightOrder
      }),
  }
}

/**
 * 统计一个步骤回调内的 Playwright 操作和 expect 断言。
 *
 * @param node - 步骤回调 AST 节点。
 * @returns 操作和断言数量。
 * @throws 不抛出异常。
 */
function countStepCalls(node: ts.Node): {
  operations: number
  assertions: number
} {
  let operations = 0
  let assertions = 0
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      const callName = getCallName(current.expression)

      if (callName === 'test.step') {
        return
      }

      if (isExpectCall(current)) {
        assertions += 1
      } else if (
        callName &&
        (callName.startsWith('page.') ||
          /\.(click|fill|press|check|uncheck|selectOption|hover|goto|reload|focus|blur|setInputFiles)$/.test(
            callName,
          ))
      ) {
        operations += 1
      }
    }

    ts.forEachChild(current, visit)
  }

  ts.forEachChild(node, visit)
  return { operations, assertions }
}

/**
 * 判断调用是否是 expect 链式断言。
 *
 * @param node - 待判断的调用节点。
 * @returns 是 expect 链时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
function isExpectCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false
  }

  let expression: ts.Expression = node.expression.expression

  while (ts.isPropertyAccessExpression(expression)) {
    expression = expression.expression
  }

  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'expect'
  )
}

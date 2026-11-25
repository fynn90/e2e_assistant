/**
 * 校验 Playwright 测试结构、标题、基础断言、环境变量和定位器策略。
 */
import ts from 'typescript'
import {
  createNodeIssue,
  getCallName,
  getStringLiteralValue,
  visitNodes,
} from './ast-utils'
import type { IPlaywrightValidationIssue } from './validation-types'

export interface IPlaywrightStructureResult {
  issues: IPlaywrightValidationIssue[]
  environmentVariables: string[]
  hasTest: boolean
  hasExpect: boolean
  hasGoto: boolean
}

/**
 * 校验 Playwright 脚本具备最小可执行结构，并收集非阻断质量警告。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param expectedTitle - E2E 用例要求的 test() 标题。
 * @returns 结构问题、环境变量和基础调用状态。
 */
export function validatePlaywrightStructure(
  sourceFile: ts.SourceFile,
  expectedTitle: string,
  expectedBaseUrl: string,
): IPlaywrightStructureResult {
  const issues: IPlaywrightValidationIssue[] = []
  const environmentVariables = new Set<string>()
  let hasTest = false
  let hasExpect = false
  let hasGoto = false
  let hasMatchingTitle = false
  let hasPageFixture = false
  let hasMatchingGoto = false

  visitNodes(sourceFile, (node) => {
    collectEnvironmentVariable(node, environmentVariables)

    if (!ts.isCallExpression(node)) {
      return
    }

    const callName = getCallName(node.expression)

    if (callName === 'test') {
      hasTest = true
      hasMatchingTitle ||=
        getStringLiteralValue(node.arguments[0]) === expectedTitle
      hasPageFixture ||= callbackUsesPageFixture(node.arguments[1])
    } else if (isExpectCall(node)) {
      hasExpect = true
    } else if (callName === 'page.goto') {
      hasGoto = true
      const target = getStringLiteralValue(node.arguments[0])
      hasMatchingGoto ||= Boolean(
        target && isAllowedGotoTarget(target, expectedBaseUrl),
      )
    } else if (callName?.endsWith('.waitForTimeout')) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'FIXED_WAIT_DISCOURAGED',
          message: '不建议使用 waitForTimeout()，请等待可观察页面状态。',
          severity: 'warning',
        }),
      )
    } else if (callName?.endsWith('.locator')) {
      validateLocator(sourceFile, node, issues)
    }
  })

  if (!hasTest) {
    issues.push({
      code: 'TEST_REQUIRED',
      message: '脚本至少需要一个 test()。',
      severity: 'warning',
    })
  } else if (!hasMatchingTitle) {
    issues.push({
      code: 'TEST_TITLE_MISMATCH',
      message: 'test() 标题必须与 E2E 用例标题一致。',
      severity: 'warning',
    })
  }

  if (!hasPageFixture) {
    issues.push({
      code: 'PAGE_FIXTURE_REQUIRED',
      message: 'test() 回调必须解构并使用 page fixture。',
      severity: 'warning',
    })
  }

  if (!hasExpect) {
    issues.push({
      code: 'EXPECT_REQUIRED',
      message: '脚本至少需要一个 expect() 断言。',
      severity: 'warning',
    })
  }

  if (!hasGoto) {
    issues.push({
      code: 'PAGE_GOTO_REQUIRED',
      message: '脚本必须通过 page.goto() 打开目标页面。',
      severity: 'warning',
    })
  } else if (!hasMatchingGoto) {
    issues.push({
      code: 'PAGE_GOTO_TARGET_MISMATCH',
      message: 'page.goto() 必须使用用例 Base URL 或其同源相对页面。',
      severity: 'warning',
    })
  }

  return {
    issues,
    environmentVariables: [...environmentVariables].sort(),
    hasTest,
    hasExpect,
    hasGoto,
  }
}

function callbackUsesPageFixture(node: ts.Expression | undefined): boolean {
  if (!node || (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node))) {
    return false
  }

  const parameter = node.parameters[0]

  if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
    return false
  }

  return parameter.name.elements.some((element) => {
    const propertyName = element.propertyName
    return propertyName
      ? getStringLiteralValue(propertyName) === 'page' ||
          (ts.isIdentifier(propertyName) && propertyName.text === 'page')
      : ts.isIdentifier(element.name) && element.name.text === 'page'
  })
}

function isAllowedGotoTarget(target: string, expectedBaseUrl: string): boolean {
  try {
    const baseUrl = new URL(expectedBaseUrl)
    const targetUrl = new URL(target, baseUrl)
    return targetUrl.origin === baseUrl.origin
  } catch {
    return false
  }
}

function isExpectCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
    return true
  }

  let expression: ts.Expression = node.expression

  while (ts.isPropertyAccessExpression(expression)) {
    expression = expression.expression
  }

  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'expect'
  )
}

function collectEnvironmentVariable(
  node: ts.Node,
  variables: Set<string>,
): void {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env'
  ) {
    variables.add(node.name.text)
    return
  }

  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'process' &&
    node.expression.name.text === 'env'
  ) {
    const name = getStringLiteralValue(node.argumentExpression)

    if (name) {
      variables.add(name)
    }
  }
}

function validateLocator(
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
  issues: IPlaywrightValidationIssue[],
): void {
  const selector = getStringLiteralValue(node.arguments[0])

  if (!selector) {
    issues.push(
      createNodeIssue(sourceFile, node, {
        code: 'DYNAMIC_LOCATOR_WARNING',
        message: 'locator() 使用动态选择器，可能降低脚本稳定性。',
        severity: 'warning',
      }),
    )
    return
  }

  if (selector.startsWith('//') || selector.startsWith('xpath=')) {
    issues.push(
      createNodeIssue(sourceFile, node, {
        code: 'XPATH_LOCATOR_WARNING',
        message: 'XPath 仅应作为最后手段，请优先使用语义定位器。',
        severity: 'warning',
      }),
    )
  } else if (
    (selector.match(/>/g)?.length ?? 0) >= 2 ||
    /\.[\w-]*\d{3,}/.test(selector)
  ) {
    issues.push(
      createNodeIssue(sourceFile, node, {
        code: 'FRAGILE_CSS_LOCATOR_WARNING',
        message: 'CSS 选择器依赖深层结构或疑似动态 class。',
        severity: 'warning',
      }),
    )
  }
}

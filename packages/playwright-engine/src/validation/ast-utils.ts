/**
 * 提供 Playwright AST 校验器共享的节点名称、位置和遍历辅助函数。
 */
import ts from 'typescript'
import type { IPlaywrightValidationIssue } from './validation-types'

export function visitNodes(
  rootNode: ts.Node,
  visitor: (node: ts.Node) => void,
): void {
  const visit = (node: ts.Node): void => {
    visitor(node)
    ts.forEachChild(node, visit)
  }

  visit(rootNode)
}

export function getCallName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const owner = getCallName(expression.expression)
    return owner ? `${owner}.${expression.name.text}` : expression.name.text
  }

  if (ts.isElementAccessExpression(expression)) {
    const owner = getCallName(expression.expression)
    const member = getStringLiteralValue(expression.argumentExpression)
    return owner && member ? `${owner}.${member}` : null
  }

  return null
}

export function createNodeIssue(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  issue: Omit<IPlaywrightValidationIssue, 'line' | 'column'>,
): IPlaywrightValidationIssue {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  )
  return {
    ...issue,
    line: position.line + 1,
    column: position.character + 1,
  }
}

export function getStringLiteralValue(
  node: ts.Node | undefined,
): string | null {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

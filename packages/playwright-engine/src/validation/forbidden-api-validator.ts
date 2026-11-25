/**
 * 扫描候选脚本中的动态执行、进程控制与 Shell API。
 *
 * v14（W37）：fs 写入族（`fs.writeFile`、裸 `writeFile` 等）从禁止清单**移除**——
 * Node 原生文件操作已按 W33/W34 定向放开，其路径边界改由
 * `user-workspace-fs-validator`（污点分析）管辖。动态执行、Shell、子进程仍然全禁。
 */
import ts from 'typescript'
import { createNodeIssue, getCallName, visitNodes } from './ast-utils'
import type { IPlaywrightValidationIssue } from './validation-types'

const FORBIDDEN_CALL_NAMES = new Set([
  'eval',
  'Function',
  'child_process.exec',
  'child_process.execFile',
  'child_process.spawn',
  'child_process.fork',
  'exec',
  'execFile',
  'spawn',
  'fork',
  'process.exit',
  'process.kill',
])

/**
 * 检查禁止在生成脚本中出现的危险运行时调用。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @returns 所有安全违规问题。
 */
function isForbiddenCallName(callName: string): boolean {
  return (
    FORBIDDEN_CALL_NAMES.has(callName) ||
    callName.endsWith('.eval') ||
    callName.endsWith('.Function')
  )
}

export function validateForbiddenApis(
  sourceFile: ts.SourceFile,
): IPlaywrightValidationIssue[] {
  const issues: IPlaywrightValidationIssue[] = []

  visitNodes(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const callName = getCallName(node.expression)

      if (callName && isForbiddenCallName(callName)) {
        issues.push(
          createNodeIssue(sourceFile, node, {
            code: 'FORBIDDEN_API',
            message: `生成脚本不允许调用 ${callName}。`,
            severity: 'error',
          }),
        )
      }
    }

    if (
      ts.isNewExpression(node) &&
      Boolean(getCallName(node.expression)?.endsWith('Function'))
    ) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'FORBIDDEN_API',
          message: '生成脚本不允许使用 new Function()。',
          severity: 'error',
        }),
      )
    }
  })

  return issues
}

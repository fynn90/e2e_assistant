/**
 * 测试脚本的静态结构分析：判定脚本是否包含测试定义，并收集 process.env 引用。
 *
 * 供 CLI 执行前就绪校验（v11 PRD J2 / J4）使用：
 *   - J2：脚本至少包含一条 `test(...)` 调用（空文件、只有注释或辅助函数均不通过）；
 *   - J4：脚本引用的每个 `process.env.KEY` 必须能被 env.json 承载。
 *
 * 本模块是纯函数：只解析文本，不读取文件系统、不执行脚本。
 */

import ts from 'typescript'
import { parseTypeScript } from './typescript-parser'
import { getCallName, getStringLiteralValue, visitNodes } from './ast-utils'

/** 测试脚本静态分析结果。 */
export interface ITestScriptAnalysis {
  /** 脚本是否包含至少一条 test(...) 调用。 */
  hasTests: boolean
  /** test(...) 调用数量。 */
  testCount: number
  /** 脚本内引用的全部环境变量 key（去重升序；覆盖 process.env.KEY 与 process.env['KEY']）。 */
  environmentVariables: string[]
}

/**
 * 分析测试脚本：统计 test() 调用并收集 process.env 引用。
 *
 * 语法错误不阻断分析：J2 只关心「有没有测试定义」，
 * 语法层面的失败会由真实执行自然失败并进入报告。
 *
 * @param code - test.spec.ts 的源码文本。
 * @returns 分析结果；代码为空时返回「无测试、无引用」。
 * @throws 不抛出异常。
 */
export function analyzeTestScript(code: string): ITestScriptAnalysis {
  const environmentVariables = new Set<string>()
  let testCount = 0

  // 空脚本（或纯空白）直接短路，避免无意义的解析开销。
  if (!code || code.trim().length === 0) {
    return { hasTests: false, testCount: 0, environmentVariables: [] }
  }

  const { sourceFile } = parseTypeScript(code)

  visitNodes(sourceFile, (node) => {
    collectEnvironmentVariable(node, environmentVariables)

    if (ts.isCallExpression(node) && getCallName(node.expression) === 'test') {
      testCount += 1
    }
  })

  return {
    hasTests: testCount > 0,
    testCount,
    environmentVariables: [...environmentVariables].sort(),
  }
}

/**
 * 收集单个 AST 节点上的 process.env 引用。
 *
 * 与 playwright-structure-validator 内的同名逻辑语义一致：
 * 覆盖 `process.env.KEY` 属性访问与 `process.env['KEY']` 元素访问两种写法。
 *
 * @param node - 当前遍历的 AST 节点。
 * @param variables - 收集结果的去重集合。
 * @returns 无返回值；命中时向集合写入 key。
 * @throws 不抛出异常。
 */
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

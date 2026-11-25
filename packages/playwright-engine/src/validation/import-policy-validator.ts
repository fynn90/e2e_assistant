/**
 * 校验 Playwright 脚本的静态导入、require 和动态 import 策略。
 *
 * v14（W33/W34，§9.1 对 v7 的定向扩展）：在 `@playwright/test` 之外放宽
 * `node:fs` / `node:fs/promises` / `node:path` 三个 Node 原生模块，用于操作
 * 当前 Skill 的 userWorkSpace；其他 Node 模块、Shell 能力仍然禁止。
 *
 * 导入形态约束（从导入形态上封死绕过面）：
 *   - `node:fs` / `node:fs/promises`：**仅按名导入白名单成员**，禁止命名空间导入
 *     与默认导入——`import * as fs` 会让 `fs.open` 等非白名单调用绕过按名检查；
 *   - `node:path`：默认导入或按名导入——path 全成员是纯计算、无副作用，
 *     PRD 示例即默认导入形态。
 */
import ts from 'typescript'
import {
  createNodeIssue,
  getCallName,
  getStringLiteralValue,
  visitNodes,
} from './ast-utils'
import type { IPlaywrightValidationIssue } from './validation-types'

export interface IImportPolicyResult {
  issues: IPlaywrightValidationIssue[]
  importsTest: boolean
  importsExpect: boolean
}

/**
 * 允许按名导入的 fs API 基础成员（W34；两个 fs 模块共用一份常量）。
 *
 * `node:fs` 额外允许每个成员的 `<name>Sync` 变体；`node:fs/promises`
 * 只允许 Promise 形态。其他文件 API 需另行评审（PRD 2.2）。
 */
export const ALLOWED_FS_API_BASE_NAMES = [
  'mkdir',
  'writeFile',
  'appendFile',
  'readFile',
  'copyFile',
  'rename',
  'readdir',
  'stat',
  'access',
  'unlink',
  'rm',
  'rmdir',
] as const

/** node:fs 允许的成员全集（基础名 + Sync 变体）。 */
const ALLOWED_NODE_FS_MEMBERS = new Set<string>([
  ...ALLOWED_FS_API_BASE_NAMES,
  ...ALLOWED_FS_API_BASE_NAMES.map((name) => `${name}Sync`),
])

/** node:fs/promises 允许的成员全集（仅 Promise 形态）。 */
const ALLOWED_NODE_FS_PROMISES_MEMBERS = new Set<string>(
  ALLOWED_FS_API_BASE_NAMES,
)

/** 允许导入的 Node 原生模块（v14 W33）。 */
const ALLOWED_NODE_MODULES = new Set([
  'node:fs',
  'node:fs/promises',
  'node:path',
])

/** 成员白名单提示文案（错误信息附带，便于 Agent 自修复）。 */
const FS_MEMBER_LIST_TEXT = ALLOWED_FS_API_BASE_NAMES.join('、')

/**
 * 仅允许 `@playwright/test`、三个 Node 原生模块和调用方显式声明的 fixture 模块。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param allowedModules - 附加允许导入的模块名称。
 * @returns 导入问题和 test/expect 导入状态。
 */
export function validateImportPolicy(
  sourceFile: ts.SourceFile,
  allowedModules: string[],
): IImportPolicyResult {
  const issues: IPlaywrightValidationIssue[] = []
  const allowed = new Set([
    '@playwright/test',
    ...allowedModules,
    ...ALLOWED_NODE_MODULES,
  ])
  let importsTest = false
  let importsExpect = false

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue
    }

    const moduleName = getStringLiteralValue(statement.moduleSpecifier)

    if (!moduleName || !allowed.has(moduleName)) {
      issues.push(
        createNodeIssue(sourceFile, statement, {
          code: 'IMPORT_NOT_ALLOWED',
          message: `不允许导入模块 ${moduleName ?? '<dynamic>'}。`,
          severity: 'error',
        }),
      )
      continue
    }

    if (moduleName === '@playwright/test') {
      validatePlaywrightImportForm(
        sourceFile,
        statement,
        (imports) => {
          importsTest ||= imports === 'test'
          importsExpect ||= imports === 'expect'
        },
        (issue) => issues.push(issue),
      )
      continue
    }

    // v14：Node 原生模块的导入形态约束。
    issues.push(
      ...validateNodeModuleImportForm(sourceFile, statement, moduleName),
    )
  }

  visitNodes(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) {
      return
    }

    const callName = getCallName(node.expression)

    if (callName === 'require') {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'REQUIRE_NOT_ALLOWED',
          message: '不允许使用 require() 动态加载模块。',
          severity: 'error',
        }),
      )
    }

    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      issues.push(
        createNodeIssue(sourceFile, node, {
          code: 'DYNAMIC_IMPORT_NOT_ALLOWED',
          message: '不允许使用动态 import()。',
          severity: 'error',
        }),
      )
    }
  })

  if (!importsTest) {
    issues.push({
      code: 'PLAYWRIGHT_TEST_IMPORT_REQUIRED',
      message: '必须从 @playwright/test 导入 test。',
      severity: 'warning',
    })
  }

  if (!importsExpect) {
    issues.push({
      code: 'PLAYWRIGHT_EXPECT_IMPORT_REQUIRED',
      message: '必须从 @playwright/test 导入 expect。',
      severity: 'warning',
    })
  }

  return { issues, importsTest, importsExpect }
}

/**
 * 校验 `@playwright/test` 的导入形态（仅按名导入 test / expect）。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param statement - import 声明节点。
 * @param onNamedImport - 按名导入成员的回调（收集 test/expect 状态）。
 * @param onIssue - 问题产出回调。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function validatePlaywrightImportForm(
  sourceFile: ts.SourceFile,
  statement: ts.ImportDeclaration,
  onNamedImport: (name: string) => void,
  onIssue: (issue: IPlaywrightValidationIssue) => void,
): void {
  const importClause = statement.importClause
  const bindings = importClause?.namedBindings

  if (importClause?.name || (bindings && ts.isNamespaceImport(bindings))) {
    onIssue(
      createNodeIssue(sourceFile, statement, {
        code: 'PLAYWRIGHT_IMPORT_FORM_INVALID',
        message: '只能从 @playwright/test 按名称导入 test 和 expect。',
        severity: 'warning',
      }),
    )
  }

  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      onNamedImport(importedName)

      if (importedName !== 'test' && importedName !== 'expect') {
        onIssue(
          createNodeIssue(sourceFile, element, {
            code: 'PLAYWRIGHT_IMPORT_NOT_ALLOWED',
            message: `不允许从 @playwright/test 导入 ${importedName}。`,
            severity: 'warning',
          }),
        )
      }
    }
  }
}

/**
 * 校验 Node 原生模块的导入形态与成员白名单（v14 W33/W34）。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param statement - import 声明节点。
 * @param moduleName - 已在白名单内的 Node 模块名。
 * @returns 形态或成员违规问题列表。
 * @throws 不抛出异常。
 */
function validateNodeModuleImportForm(
  sourceFile: ts.SourceFile,
  statement: ts.ImportDeclaration,
  moduleName: string,
): IPlaywrightValidationIssue[] {
  const issues: IPlaywrightValidationIssue[] = []
  const importClause = statement.importClause
  const bindings = importClause?.namedBindings

  if (moduleName === 'node:path') {
    // path 全成员纯计算：默认导入（import path from 'node:path'）或按名导入均可。
    if (bindings && ts.isNamespaceImport(bindings)) {
      issues.push(
        createNodeIssue(sourceFile, statement, {
          code: 'IMPORT_NOT_ALLOWED',
          message: 'node:path 只允许默认导入或按名导入，不允许命名空间导入。',
          severity: 'error',
        }),
      )
    }
    return issues
  }

  // node:fs / node:fs/promises：仅按名导入白名单成员。
  const allowedMembers =
    moduleName === 'node:fs'
      ? ALLOWED_NODE_FS_MEMBERS
      : ALLOWED_NODE_FS_PROMISES_MEMBERS

  if (importClause?.name || (bindings && ts.isNamespaceImport(bindings))) {
    issues.push(
      createNodeIssue(sourceFile, statement, {
        code: 'IMPORT_NOT_ALLOWED',
        message: `${moduleName} 只允许按名称导入白名单成员（${FS_MEMBER_LIST_TEXT}${
          moduleName === 'node:fs' ? ' 及其 Sync 变体' : ''
        }），不允许默认导入或命名空间导入。`,
        severity: 'error',
      }),
    )
  }

  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text

      if (!allowedMembers.has(importedName)) {
        issues.push(
          createNodeIssue(sourceFile, element, {
            code: 'IMPORT_NOT_ALLOWED',
            message: `不允许从 ${moduleName} 导入 ${importedName}。允许的成员：${FS_MEMBER_LIST_TEXT}${
              moduleName === 'node:fs' ? '（及其 Sync 变体）' : ''
            }。`,
            severity: 'error',
          }),
        )
      }
    }
  }

  return issues
}

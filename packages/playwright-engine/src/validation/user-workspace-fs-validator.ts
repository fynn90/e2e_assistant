/**
 * userWorkSpace 文件操作污点校验器（v14 核心新增，W28-W36/W39/A10，技术方案 §5.3）。
 *
 * 静态污点分析：白名单 fs 调用（按名导入形态，如 `mkdir(...)` / `mkdirSync(...)`）
 * 的路径参数必须可证明源自 `process.env.SKILL_USER_WORKSPACE`。
 *
 * 算法（保守的局部分析，不动点迭代）：
 *   1. 收集根变量：`const root = process.env.SKILL_USER_WORKSPACE`
 *      （或 `path.resolve(process.env.SKILL_USER_WORKSPACE)`）→ 深度 0；
 *   2. 传播派生变量：`path.resolve/join(根或派生, <字面量...>)`、`path.dirname(派生)`、
 *      标识符别名 → 计算近似深度（每段字面量 +1，dirname -1），迭代至收敛；
 *   3. 检查每个白名单 fs 调用的路径位参数（rename/copyFile 取两个）：
 *      标识符深度已知且 ≥ 0、或 `path.resolve/join(根派生, 字面量)` 内联表达式 → 通过；
 *      字面量段含 `..`、深度为负（dirname 逃出根）、未知来源 → FS_PATH_OUTSIDE_WORKSPACE；
 *   4. 根守卫：`rm`/`rmdir` 的路径参数解析为深度 0（恰为 userWorkSpace 根）
 *      → FS_WORKSPACE_ROOT_DELETE（W36）；
 *   5. 脚本存在 fs 调用但没有根变量声明 → 全部 fs 调用报 FS_PATH_OUTSIDE_WORKSPACE
 *      （无根变量时任何参数都无法证明在界内，自然收敛到该结果）。
 *
 * **取舍说明**：这是「宁可误拒不放过」的保守分析——闭包捕获、数组拼接等复杂数据流
 * 一律拒绝。误拒的代价只是 Agent 按错误提示重新生成（提示词提供标准模板，正常产出
 * 都命中模板形态）；漏放的代价是越界写盘。这与 typescript-semantic-validator 的 shim
 * 「误拒合法代码比漏报更危险」的宽松哲学方向相反，是因为二者防护对象不同：
 * shim 防误报，本校验器防越界。
 */

import ts from 'typescript'
import { getCallName, getStringLiteralValue } from './ast-utils'
import { ALLOWED_FS_API_BASE_NAMES } from './import-policy-validator'
import type { IPlaywrightValidationIssue } from './validation-types'

/** 平台注入的 userWorkSpace 根环境变量（W38）。 */
const WORKSPACE_ENV_KEY = 'SKILL_USER_WORKSPACE'

/** 白名单 fs 调用名（基础成员 + Sync 变体；按名导入形态下的裸调用名）。 */
const FS_CALL_NAMES = new Set<string>([
  ...ALLOWED_FS_API_BASE_NAMES,
  ...ALLOWED_FS_API_BASE_NAMES.map((name) => `${name}Sync`),
])

/** 路径位参数取两个的调用（源与目标都是文件系统对象）。 */
const TWO_PATH_ARG_CALL_NAMES = new Set([
  'rename',
  'renameSync',
  'copyFile',
  'copyFileSync',
])

/** 删除类调用（触发根守卫，W36）。 */
const DELETE_CALL_NAMES = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync'])

/** 路径派生函数调用名（默认导入 `path.resolve` 或按名导入 `resolve` 两种形态）。 */
const PATH_RESOLVE_NAMES = new Set(['path.resolve', 'resolve'])
const PATH_JOIN_NAMES = new Set(['path.join', 'join'])
const PATH_DIRNAME_NAMES = new Set(['path.dirname', 'dirname'])

/** 越界错误的统一说明（附平台模板写法，引导 Agent 自修复）。 */
const OUTSIDE_MESSAGE =
  '文件操作只允许作用于当前 Skill 的 userWorkSpace/ 内，路径必须由 process.env.SKILL_USER_WORKSPACE 派生。' +
  '标准写法：const target = path.resolve(process.env.SKILL_USER_WORKSPACE, "业务/相对路径")，' +
  '或先 const workspaceRoot = process.env.SKILL_USER_WORKSPACE 再 path.resolve(workspaceRoot, "业务/相对路径")。'

/** 校验结果。 */
export interface IUserWorkspaceFsResult {
  issues: IPlaywrightValidationIssue[]
}

/**
 * 对候选脚本执行 fs 路径污点校验。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @returns 越界与根删除问题列表（均为 error 级）。
 * @throws 不抛出异常——所有失败都转换为结构化问题返回。
 */
export function validateUserWorkspaceFs(
  sourceFile: ts.SourceFile,
): IUserWorkspaceFsResult {
  const issues: IPlaywrightValidationIssue[] = []

  // 1+2. 收集根变量并迭代传播派生深度（不动点：直到没有新变量可获得深度）。
  const depths = collectPathDepths(sourceFile)

  // 3-5. 检查每个白名单 fs 调用的路径位参数。
  visitFsCalls(sourceFile, (node, callName) => {
    const argIndexes = TWO_PATH_ARG_CALL_NAMES.has(callName) ? [0, 1] : [0]

    for (const index of argIndexes) {
      const arg = node.arguments[index]
      if (!arg) continue
      checkPathArgument(sourceFile, arg, callName, depths, issues)
    }
  })

  return { issues }
}

/**
 * 路径深度的三态：非负数字 = 界内（0 恰为根），undefined = 无法证明（未知或越界）。
 */
type TPathDepth = number | undefined

/**
 * 收集全文件变量声明中可确定深度的路径变量。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @returns 变量名 → 深度的映射（仅含可证明界内的变量）。
 * @throws 不抛出异常。
 */
function collectPathDepths(sourceFile: ts.SourceFile): Map<string, TPathDepth> {
  const depths = new Map<string, TPathDepth>()

  // 首轮：收集根变量（process.env.SKILL_USER_WORKSPACE 或其 resolve 包裹）。
  for (const declaration of collectVariableDeclarations(sourceFile)) {
    const depth = resolveRootDeclarationDepth(declaration.initializer)
    if (depth !== undefined && ts.isIdentifier(declaration.name)) {
      depths.set(declaration.name.text, depth)
    }
  }

  // 不动点迭代：传播派生变量，直到没有新变量获得深度。
  let changed = true
  while (changed) {
    changed = false

    for (const declaration of collectVariableDeclarations(sourceFile)) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      if (depths.has(name)) continue

      const depth = resolveDerivedDepth(declaration.initializer, depths)
      if (depth !== undefined) {
        depths.set(name, depth)
        changed = true
      }
    }
  }

  return depths
}

/**
 * 收集全文件的变量声明节点（跨作用域的平铺扫描：保守局部分析不建模作用域）。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @returns 变量声明节点列表。
 * @throws 不抛出异常。
 */
function collectVariableDeclarations(
  sourceFile: ts.SourceFile,
): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return declarations
}

/**
 * 判定声明初始化表达式是否为根来源（process.env.SKILL_USER_WORKSPACE 及其 resolve 包裹）。
 *
 * @param initializer - 变量声明的初始化表达式。
 * @returns 根变量返回 0；否则返回 undefined。
 * @throws 不抛出异常。
 */
function resolveRootDeclarationDepth(
  initializer: ts.Expression | undefined,
): TPathDepth {
  if (!initializer) return undefined

  // 直接取环境变量。
  if (isWorkspaceEnvAccess(initializer)) return 0

  // path.resolve(process.env.SKILL_USER_WORKSPACE)（等价包裹，单参形态）。
  if (
    isPathCall(initializer, PATH_RESOLVE_NAMES) &&
    initializer.arguments.length === 1
  ) {
    if (isWorkspaceEnvAccess(initializer.arguments[0])) return 0
  }

  return undefined
}

/**
 * 判定声明初始化表达式是否可由已知深度变量派生。
 *
 * @param initializer - 变量声明的初始化表达式。
 * @param depths - 当前已知的变量深度表。
 * @returns 可确定且界内（≥ 0）时返回深度；未知、越界或含 `..` 时返回 undefined。
 * @throws 不抛出异常。
 */
function resolveDerivedDepth(
  initializer: ts.Expression | undefined,
  depths: Map<string, TPathDepth>,
): TPathDepth {
  if (!initializer) return undefined

  // 标识符别名：const p = rootVar。
  if (ts.isIdentifier(initializer)) {
    return depths.get(initializer.text)
  }

  return evaluatePathCallDepth(initializer, depths)
}

/**
 * 评估路径派生调用表达式的深度。
 *
 * @param node - 待评估的表达式。
 * @param depths - 当前已知的变量深度表。
 * @returns 可确定且界内时返回深度；否则返回 undefined。
 * @throws 不抛出异常。
 */
function evaluatePathCallDepth(
  node: ts.Expression,
  depths: Map<string, TPathDepth>,
): TPathDepth {
  if (!ts.isCallExpression(node)) return undefined

  const callName = getCallName(node.expression)

  // path.dirname(x)：深度减一；减到负数即逃出 userWorkSpace（如 dirname(根) = Skill 根）。
  if (callName && PATH_DIRNAME_NAMES.has(callName)) {
    const inner = node.arguments[0]
    if (!inner) return undefined
    const innerDepth = expressionDepth(inner, depths)
    if (innerDepth === undefined) return undefined
    return innerDepth - 1 >= 0 ? innerDepth - 1 : undefined
  }

  // path.resolve/join(base, <字面量...>)：base 深度已知 + 字面量段数。
  if (
    callName &&
    (PATH_RESOLVE_NAMES.has(callName) || PATH_JOIN_NAMES.has(callName))
  ) {
    return evaluateResolveJoinDepth(node, depths)
  }

  return undefined
}

/**
 * 评估 path.resolve / path.join 调用的深度。
 *
 * @param node - resolve/join 调用表达式。
 * @param depths - 当前已知的变量深度表。
 * @returns 可确定且界内时返回深度；含 `..` 段或基准未知时返回 undefined。
 * @throws 不抛出异常。
 */
function evaluateResolveJoinDepth(
  node: ts.CallExpression,
  depths: Map<string, TPathDepth>,
): TPathDepth {
  const [base, ...rest] = node.arguments

  // 基准：已知深度的标识符，或直接是环境变量访问（内联根形态）。
  let baseDepth: TPathDepth
  if (!base) {
    // resolve() 无参 → cwd，不在 userWorkSpace 内。
    return undefined
  }
  if (isWorkspaceEnvAccess(base)) {
    baseDepth = 0
  } else {
    baseDepth = expressionDepth(base, depths)
  }
  if (baseDepth === undefined) return undefined

  // 后续段必须全部是字符串字面量且不含 `..`（静态可判的穿越，W31）。
  let added = 0
  for (const segment of rest) {
    const literal = getStringLiteralValue(segment)
    if (literal === null) return undefined

    for (const part of literal.split('/')) {
      if (part === '..') return undefined
      if (part === '.' || part === '') continue
      added += 1
    }
  }

  return baseDepth + added
}

/**
 * 求单个表达式（作为路径使用）的深度：标识符查表，派生调用递归评估。
 *
 * @param node - 路径表达式。
 * @param depths - 当前已知的变量深度表。
 * @returns 可确定且界内时返回深度；否则返回 undefined。
 * @throws 不抛出异常。
 */
function expressionDepth(
  node: ts.Expression,
  depths: Map<string, TPathDepth>,
): TPathDepth {
  if (ts.isIdentifier(node)) {
    return depths.get(node.text)
  }
  return evaluatePathCallDepth(node, depths)
}

/**
 * 遍历全文件调用表达式，回调每个白名单 fs 调用。
 *
 * @param sourceFile - 已解析的 TypeScript AST。
 * @param onFsCall - fs 调用回调（节点 + 裸调用名）。
 * @throws 不抛出异常。
 */
function visitFsCalls(
  sourceFile: ts.SourceFile,
  onFsCall: (node: ts.CallExpression, callName: string) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // 按名导入形态的裸调用（mkdir / mkdirSync 等）；fs.xxx 前缀形态由
      // import-policy（禁止命名空间导入）+ TS 语义校验（找不到名称 fs）双重拦截，
      // 此处不再匹配，保持按名形态的单一口径。
      if (
        ts.isIdentifier(node.expression) &&
        FS_CALL_NAMES.has(node.expression.text)
      ) {
        onFsCall(node, node.expression.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
}

/**
 * 检查单个路径位参数并产出问题。
 *
 * @param sourceFile - 已解析的 TypeScript AST（定位用）。
 * @param arg - 路径位参数表达式。
 * @param callName - 所属 fs 调用的裸调用名。
 * @param depths - 变量深度表。
 * @param issues - 问题收集数组。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function checkPathArgument(
  sourceFile: ts.SourceFile,
  arg: ts.Expression,
  callName: string,
  depths: Map<string, TPathDepth>,
  issues: IPlaywrightValidationIssue[],
): void {
  const depth = expressionDepth(arg, depths)

  if (depth === undefined) {
    issues.push({
      code: 'FS_PATH_OUTSIDE_WORKSPACE',
      message: OUTSIDE_MESSAGE,
      severity: 'error',
      line: lineOf(sourceFile, arg),
      column: columnOf(sourceFile, arg),
    })
    return
  }

  // 根守卫（W36）：删除类调用的路径恰为 userWorkSpace 根（深度 0）。
  if (depth === 0 && DELETE_CALL_NAMES.has(callName)) {
    issues.push({
      code: 'FS_WORKSPACE_ROOT_DELETE',
      message:
        '不得删除或重命名 userWorkSpace 根目录；只能删除其中的子目录或文件。',
      severity: 'error',
      line: lineOf(sourceFile, arg),
      column: columnOf(sourceFile, arg),
    })
  }
}

/**
 * 判断表达式是否为 `process.env.SKILL_USER_WORKSPACE` 访问（点号或方括号形态）。
 *
 * @param node - 待判断的表达式。
 * @returns 是环境变量访问时返回 true。
 * @throws 不抛出异常。
 */
function isWorkspaceEnvAccess(node: ts.Expression): boolean {
  // 点号形态：process.env.SKILL_USER_WORKSPACE（模板的推荐写法）。
  if (ts.isPropertyAccessExpression(node)) {
    const owner = node.expression
    if (!ts.isPropertyAccessExpression(owner)) return false
    if (
      !ts.isIdentifier(owner.expression) ||
      owner.expression.text !== 'process'
    )
      return false
    if (owner.name.text !== 'env') return false
    return node.name.text === WORKSPACE_ENV_KEY
  }

  // 方括号形态：process.env['SKILL_USER_WORKSPACE']。
  if (ts.isElementAccessExpression(node)) {
    if (!ts.isPropertyAccessExpression(node.expression)) return false
    if (
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== 'process'
    ) {
      return false
    }
    if (node.expression.name.text !== 'env') return false
    return getStringLiteralValue(node.argumentExpression) === WORKSPACE_ENV_KEY
  }

  return false
}

/**
 * 判断节点是否为指定名称集合中的调用表达式。
 *
 * @param node - 待判断的表达式。
 * @param names - 允许的调用名集合。
 * @returns 是匹配的调用表达式时返回 true。
 * @throws 不抛出异常。
 */
function isPathCall(
  node: ts.Expression,
  names: Set<string>,
): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const callName = getCallName(node.expression)
  return callName !== null && names.has(callName)
}

/** 取节点的 1 起始行号（定位失败时省略）。 */
function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number | undefined {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  )
}

/** 取节点的 1 起始列号（定位失败时省略）。 */
function columnOf(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): number | undefined {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      .character + 1
  )
}

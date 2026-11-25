/** 编排 Playwright 候选脚本的语法、安全、结构和步骤覆盖校验。 */

import { validateEnvironmentVariables } from './environment-variable-validator'
import { formatPlaywrightScript } from '../formatting/playwright-script-formatter'
import { validateForbiddenApis } from './forbidden-api-validator'
import { validateImportPolicy } from './import-policy-validator'
import { validatePlaywrightStructure } from './playwright-structure-validator'
import { validateStepCoverage } from './step-coverage-validator'
import { parseTypeScript } from './typescript-parser'
import { validateTypeScriptSemantics } from './typescript-semantic-validator'
import { validateUserWorkspaceFs } from './user-workspace-fs-validator'
import type {
  IPlaywrightValidationIssue,
  IPlaywrightValidationOptions,
  IPlaywrightValidationResult,
  IPlaywrightScriptValidator,
} from './validation-types'

/**
 * 对外暴露完整静态校验能力的兼容接口。
 */
export { IPlaywrightScriptValidator }

/**
 * 执行候选脚本静态质量和安全门禁的默认实现。
 */
export class PlaywrightScriptValidator implements IPlaywrightScriptValidator {
  /**
   * 对模型或客户端提交的代码执行完整静态校验，并返回格式化后的候选代码。
   *
   * @param code - 未受信任的 TypeScript 候选脚本。
   * @param options - 当前权威 E2E 用例和额外允许模块。
   * @returns 校验结果；存在任一 error 时 valid 为 false。
   * @throws 不执行候选代码；解析异常以校验结果中的 error 表示。
   */
  validate(
    code: string,
    options: IPlaywrightValidationOptions,
  ): IPlaywrightValidationResult {
    const parsed = parseTypeScript(code)

    if (parsed.syntaxErrors.length > 0) {
      // 语法不可解析时必须**原样返回入参、且不再往下校验**，这不是保守起见的省略，
      // 而是两条独立且都成立的硬约束：
      //
      //   1. 不可解析即不可打印：createPrinter 从 AST 重新生成代码时，会对缺失的
      //      token 凭空补全（未闭合的函数体会被自动补上 `});`）、对游离 token
      //      静默丢弃，产出「语法合法但语义已被改写」的代码。若继续走格式化，
      //      落盘的将不是 Agent 写的脚本。
      //   2. AST 在此状态下不可信：未闭合的模板字符串会把后续 token 整体吞掉，
      //      `require('node:child_process')` 这类调用在 AST 里根本看不见——
      //      在此之上跑导入策略、禁止 API、fs 污点等检查都得不出可信结论。
      //
      // 因此本分支是**安全边界**：语法错误属阻断族（见 types 的 diagnostic-policy）。
      // 回归保护见 playwright-script-validator.test.ts 的「语法不可解析」用例。
      return createResult(code, parsed.syntaxErrors, [], [], [])
    }

    const importResult = validateImportPolicy(parsed.sourceFile, [
      ...(options.allowedModules ?? []),
    ])
    const structureResult = validatePlaywrightStructure(
      parsed.sourceFile,
      options.testCase.title.trim(),
      options.testCase.baseUrl.trim(),
    )
    const coverageResult = validateStepCoverage(
      parsed.sourceFile,
      options.testCase,
    )
    const issues = [
      ...validateTypeScriptSemantics(code),
      ...importResult.issues,
      ...validateForbiddenApis(parsed.sourceFile),
      // v14：fs 路径污点校验（生成与保存两道门禁自动同时生效）——
      // 白名单 fs 调用的路径必须可证明由 process.env.SKILL_USER_WORKSPACE 派生。
      ...validateUserWorkspaceFs(parsed.sourceFile).issues,
      ...structureResult.issues,
      ...validateEnvironmentVariables(
        options.testCase,
        structureResult.environmentVariables,
      ),
      ...coverageResult.issues,
    ]
    const formattedCode = formatPlaywrightScript(parsed.sourceFile)
    const formattedParse = parseTypeScript(formattedCode)

    if (formattedParse.syntaxErrors.length > 0) {
      // 打印机产出不可解析的代码 —— 它的内部不变式被破坏了。此时**绝不把打印机
      // 的产物交给写入方**（可能已被改写），而是回退到原文并显式阻断。
      // 行号也以原文为准，避免用户按格式化后的假位置去改。
      return createResult(
        code,
        [
          ...issues.filter((issue) => issue.severity === 'error'),
          ...formattedParse.syntaxErrors,
        ],
        issues.filter((issue) => issue.severity === 'warning'),
        coverageResult.coverage,
        structureResult.environmentVariables,
      )
    }

    return createResult(
      formattedCode,
      issues.filter((issue) => issue.severity === 'error'),
      issues.filter((issue) => issue.severity === 'warning'),
      coverageResult.coverage,
      structureResult.environmentVariables,
    )
  }
}

/**
 * 创建统一形状的静态校验结果。
 *
 * @param code - 输出代码。
 * @param errors - 阻断错误。
 * @param warnings - 非阻断警告。
 * @param stepCoverage - 步骤覆盖结果。
 * @param environmentVariables - 代码中发现的环境变量名称。
 * @returns 校验结果对象。
 * @throws 不抛出异常。
 */
function createResult(
  code: string,
  errors: IPlaywrightValidationIssue[],
  warnings: IPlaywrightValidationIssue[],
  stepCoverage: IPlaywrightValidationResult['stepCoverage'],
  environmentVariables: string[],
): IPlaywrightValidationResult {
  return {
    valid: errors.length === 0,
    code,
    errors,
    warnings,
    stepCoverage,
    environmentVariables,
  }
}

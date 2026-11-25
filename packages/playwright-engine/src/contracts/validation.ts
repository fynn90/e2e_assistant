/** 定义 Playwright Engine 的最小脚本校验输入、问题和结果契约。 */

/**
 * SDK 可理解的最小 E2E 步骤，不依赖平台领域类型。
 */
export interface IValidationTestStep {
  id: string
  order: number
  enabled: boolean
  description?: string
  action?: string
  expectedResult?: string
  testData?: Readonly<Record<string, string>>
}

/**
 * SDK 可理解的最小 E2E 用例。
 *
 * 宿主应将平台用例转换为该结构后再调用校验器。
 */
export interface IValidationTestCase {
  title: string
  baseUrl: string
  steps: readonly IValidationTestStep[]
  description?: string
  tags?: readonly string[]
  preconditions?: readonly { description: string }[]
  environmentVariables?: readonly string[]
}

/**
 * 单个步骤的 Playwright 操作与断言覆盖数量。
 */
export interface IPlaywrightStepCoverage {
  stepId: string
  operations: number
  assertions: number
}

/**
 * 静态校验问题严重级别。
 */
export type TPlaywrightValidationSeverity = 'error' | 'warning'

/**
 * 静态校验问题。
 */
export interface IPlaywrightValidationIssue {
  code: string
  message: string
  severity: TPlaywrightValidationSeverity
  line?: number
  column?: number
  stepId?: string
}

/**
 * 校验器运行选项。
 */
export interface IPlaywrightValidationOptions {
  testCase: IValidationTestCase
  allowedModules?: readonly string[]
  requiredEnvironmentVariables?: readonly string[]
}

/**
 * 候选脚本静态校验结果。
 */
export interface IPlaywrightValidationResult {
  valid: boolean
  code: string
  errors: IPlaywrightValidationIssue[]
  warnings: IPlaywrightValidationIssue[]
  stepCoverage: IPlaywrightStepCoverage[]
  environmentVariables: string[]
}

/**
 * 候选脚本校验器公共接口。
 */
export interface IPlaywrightScriptValidator {
  /**
   * 对候选 TypeScript 代码执行静态校验。
   *
   * @param code - 未受信任的候选脚本源码。
   * @param options - 最小用例和导入策略配置。
   * @returns 格式化后的代码以及错误、警告和覆盖结果。
   * @throws 不执行候选代码；输入异常通常通过结果中的 error 返回。
   */
  validate(
    code: string,
    options: IPlaywrightValidationOptions,
  ): IPlaywrightValidationResult
}

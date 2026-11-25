/** 校验 E2E 用例中的环境变量占位符与脚本 process.env 引用保持一致。 */

import {
  collectEnvReferences,
  PLATFORM_BUILTIN_ENV_KEYS,
} from '@charlie_deng/e2e-assistant-types'
import type { IValidationTestCase } from '../contracts/validation'
import type { IPlaywrightValidationIssue } from './validation-types'

/**
 * 从 SDK 最小用例的可生成内容中提取环境变量名称。
 *
 * 提取规则下沉至 `@charlie_deng/e2e-assistant-types` 的 `collectEnvReferences` 统一维护
 * （v10 起 Web 与 CLI 共用同一份正则，消除多端正则漂移风险）；
 * 本函数保留原签名作为转发实现，调用方无感知。
 *
 * @param testCase - 当前权威用例。
 * @returns 去重并排序后的环境变量名称。
 * @throws 不抛出异常；缺失的可选文本字段按空文本处理。
 */
export function extractExpectedEnvironmentVariables (
  testCase: IValidationTestCase,
): string[] {
  return collectEnvReferences(testCase)
}

/**
 * 对比用例占位符与脚本 AST 收集的 process.env 引用。
 *
 * @param testCase - 当前权威用例。
 * @param actualVariables - 从脚本 AST 收集的变量名称。
 * @returns 缺失或额外环境变量问题。
 * @throws 不抛出异常。
 */
export function validateEnvironmentVariables (
  testCase: IValidationTestCase,
  actualVariables: string[],
): IPlaywrightValidationIssue[] {
  const expectedVariables = extractExpectedEnvironmentVariables(testCase)
  const expected = new Set(expectedVariables)
  // v14（W38）：平台内置变量（SKILL_USER_WORKSPACE）由执行器注入，不属于用例
  // 声明范围——从 actual 集合剔除后再比对，引用它不再触发 ENVIRONMENT_VARIABLE_UNDECLARED。
  // expected 方向不变：用例声明的 env 仍必须被脚本使用。
  const actual = new Set(
    actualVariables.filter((name) => !PLATFORM_BUILTIN_ENV_KEYS.includes(name)),
  )
  const issues: IPlaywrightValidationIssue[] = []

  for (const name of expectedVariables) {
    if (!actual.has(name)) {
      issues.push({
        code: 'ENVIRONMENT_VARIABLE_MISSING',
        message: `脚本缺少用例引用的环境变量 process.env.${name}。`,
        severity: 'warning',
      })
    }
  }

  for (const name of [...actual].sort()) {
    if (!expected.has(name)) {
      issues.push({
        code: 'ENVIRONMENT_VARIABLE_UNDECLARED',
        message: `脚本引用了用例未声明的环境变量 process.env.${name}。`,
        severity: 'warning',
      })
    }
  }

  return issues
}

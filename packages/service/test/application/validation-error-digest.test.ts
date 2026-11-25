/**
 * 验证生成失败提示的组织逻辑：位置、类别、修复方向与条数上限。
 */
import { describe, expect, it } from 'vitest'
import type { IPlaywrightValidationIssue } from '@authine-e2e-agent/playwright-engine'
import { buildValidationFailureDigest } from '../../src/application/e2e-test-case/validation-error-digest'

/** 构造一条校验问题，未给出的字段用合理默认值填充。 */
function issue(
  overrides: Partial<IPlaywrightValidationIssue> = {},
): IPlaywrightValidationIssue {
  return {
    code: 'TYPESCRIPT_SEMANTIC_ERROR',
    message: "Parameter 'message' implicitly has an 'any' type.",
    severity: 'error',
    ...overrides,
  }
}

describe('校验失败提示的组织', () => {
  it('给出位置、类别与修复方向', () => {
    const digest = buildValidationFailureDigest([
      issue({ line: 55, column: 23 }),
    ])

    // 位置：行/列必须出现在提示里，否则用户无法定位。
    expect(digest.message).toContain('第 55 行第 23 列')
    // 类别与修复方向
    expect(digest.message).toContain('类型检查未通过')
    expect(digest.message).toContain(': any')
    // 原始校验器信息必须保留，不能被类别名替换掉
    expect(digest.message).toContain(
      "Parameter 'message' implicitly has an 'any' type.",
    )
    expect(digest.errorCount).toBe(1)
  })

  it('有步骤 id 时优先给出步骤定位', () => {
    const digest = buildValidationFailureDigest([
      issue({
        code: 'STEP_ASSERTION_REQUIRED',
        message: '步骤 step_login 至少需要一个断言。',
        stepId: 'step_login',
        line: 12,
      }),
    ])

    expect(digest.message).toContain('步骤 step_login')
    expect(digest.message).toContain('第 12 行')
    expect(digest.message).toContain('步骤缺少断言')
  })

  it('列出多条问题并说明剩余数量', () => {
    const errors = [
      issue({ line: 1 }),
      issue({ line: 2, code: 'STEP_NOT_COVERED', message: '步骤未覆盖。' }),
      issue({ line: 3 }),
      issue({ line: 4 }),
      issue({ line: 5 }),
    ]
    const digest = buildValidationFailureDigest(errors)

    expect(digest.errorCount).toBe(5)
    expect(digest.message).toContain('共 5 项')
    // 只列前 3 条，其余归入「另有 … 项」
    expect(digest.message).toContain('第 1 行')
    expect(digest.message).toContain('第 3 行')
    expect(digest.message).not.toContain('第 4 行')
    expect(digest.message).toContain('另有 2 项问题未列出')
  })

  it('未登记的错误码只展示原文，不猜测含义', () => {
    const digest = buildValidationFailureDigest([
      issue({ code: 'SOME_FUTURE_CODE', message: '未来新增的错误。', line: 9 }),
    ])

    expect(digest.message).toContain('未来新增的错误。')
    expect(digest.message).toContain('校验未通过')
    // 不应编造修复提示
    expect(digest.message).not.toContain('→')
  })

  it('缺少行号时不显示位置，但仍给出类别与原文', () => {
    const digest = buildValidationFailureDigest([
      issue({ code: 'TEST_REQUIRED', message: '脚本缺少 test()。' }),
    ])

    expect(digest.message).not.toContain('第 ')
    expect(digest.message).toContain('缺少测试定义')
    expect(digest.message).toContain('脚本缺少 test()。')
  })

  it('空清单返回兜底文案而非抛错', () => {
    const digest = buildValidationFailureDigest([])

    expect(digest.errorCount).toBe(0)
    expect(digest.message).toContain('未通过静态校验')
  })
})

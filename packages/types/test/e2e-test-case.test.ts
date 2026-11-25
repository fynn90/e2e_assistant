/**
 * 验证 E2E 用例共享 Schema、草稿保存规则和生成就绪规则。
 */
import { describe, expect, it } from 'vitest'
import {
  createDefaultE2ETestCase,
  e2eTestCaseSchema,
  validateE2ETestCaseForGeneration,
  validateE2ETestCaseForSave,
} from '../src/domain/e2e-test-case'
import { playwrightGenerationEventSchema } from '../src/api/e2e-test-case'

describe('E2E test case domain schema', () => {
  it('creates a structurally valid draft for a new Skill', () => {
    const testCase = createDefaultE2ETestCase({
      skillId: 'abc123def',
      title: '登录测试',
      description: '',
    })

    expect(e2eTestCaseSchema.parse(testCase)).toEqual(testCase)
    expect(testCase.baseUrl).toBe('')
    expect(testCase.steps).toEqual([])
    expect(
      validateE2ETestCaseForSave(testCase).map((issue) => issue.path[0]),
    ).toEqual(expect.arrayContaining(['description', 'baseUrl']))
    expect(
      validateE2ETestCaseForGeneration(testCase).map((issue) => issue.path[0]),
    ).toEqual(expect.arrayContaining(['description', 'baseUrl', 'steps']))
  })

  it('accepts a complete generation-ready test case', () => {
    const testCase = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录成功',
        description: '验证合法用户可以进入工作台。',
      }),
      baseUrl: 'https://example.test',
      tags: ['登录', '冒烟'],
      preconditions: [{ id: 'pre_user', description: '测试用户已存在。' }],
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录表单',
          action: '点击登录按钮',
          expectedResult: '页面跳转到工作台',
          testData: {},
          enabled: true,
        },
      ],
    }

    expect(
      validateE2ETestCaseForGeneration(e2eTestCaseSchema.parse(testCase)),
    ).toEqual([])
  })

  it('rejects duplicate ids, non-continuous order and credential URLs', () => {
    const testCase = e2eTestCaseSchema.parse({
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录成功',
        description: '验证登录。',
      }),
      baseUrl: 'https://user:secret@example.test',
      tags: ['登录', '登录'],
      preconditions: [
        { id: 'same', description: '条件一' },
        { id: 'same', description: '条件二' },
      ],
      steps: [
        {
          id: 'same_step',
          order: 2,
          description: '步骤一',
          action: '点击',
          expectedResult: '可见',
          testData: {},
          enabled: true,
        },
        {
          id: 'same_step',
          order: 2,
          description: '步骤二',
          action: '点击',
          expectedResult: '可见',
          testData: {},
          enabled: true,
        },
      ],
    })
    const issues = validateE2ETestCaseForSave(testCase)

    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        '目标 URL 不能包含用户名或密码。',
        '标签不能重复。',
        'ID 不能重复。',
      ]),
    )
    expect(
      issues.filter((issue) => issue.path.at(-1) === 'order'),
    ).toHaveLength(2)
  })

  it('allows plaintext sensitive test data (v10 移除敏感词拦截后不再产生任何 issue)', () => {
    const testCase = e2eTestCaseSchema.parse({
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录成功',
        description: '验证登录。',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录表单',
          action: '点击登录按钮',
          expectedResult: '页面跳转到工作台',
          testData: { username: 'bo2', password: '123456' },
          enabled: true,
        },
      ],
    })

    // v10 D4：敏感词拦截已正式移除，明文测试数据允许保存与生成（引导交给编辑器软提醒）
    expect(validateE2ETestCaseForSave(testCase)).toEqual([])
    expect(validateE2ETestCaseForGeneration(testCase)).toEqual([])
  })

  it('accepts environment references in sensitive test data', () => {
    const testCase = e2eTestCaseSchema.parse({
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录成功',
        description: '验证登录。',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录表单',
          action: '点击登录按钮',
          expectedResult: '页面跳转到工作台',
          testData: {
            username: '${ENV:E2E_USERNAME}',
            password: '${ENV:E2E_PASSWORD}',
          },
          enabled: true,
        },
      ],
    })

    expect(validateE2ETestCaseForSave(testCase)).toEqual([])
    expect(validateE2ETestCaseForGeneration(testCase)).toEqual([])
  })

  it('blocks rows switched to sensitive without a selected key with the dedicated message (v10 C5)', () => {
    const testCase = e2eTestCaseSchema.parse({
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录成功',
        description: '验证登录。',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '提交登录表单',
          action: '点击登录按钮',
          expectedResult: '页面跳转到工作台',
          // 第三次修订：行类型切到敏感但未选 key（哨兵值），键名不限。
          testData: { password: '${ENV:}' },
          enabled: true,
        },
      ],
    })
    const issues = validateE2ETestCaseForSave(testCase)

    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toBe('敏感数据未选择 env.json 中的 key。')
    expect(issues[0]?.path).toEqual(['steps', 0, 'testData', 'password'])
  })

  it('runtime-validates Playwright generation events', () => {
    const event = playwrightGenerationEventSchema.parse({
      type: 'complete',
      data: {
        code: "import { test, expect } from '@playwright/test'",
        warnings: [],
        assumptions: [],
        environmentVariables: ['E2E_USERNAME'],
        stepCoverage: [{ stepId: 'step_login', operations: 1, assertions: 1 }],
        sourceHash: `sha256:${'a'.repeat(64)}`,
        testCaseVersion: 'b'.repeat(64),
        scriptVersion: null,
      },
    })

    expect(event.type).toBe('complete')
    expect(
      playwrightGenerationEventSchema.safeParse({
        type: 'error',
        code: 'UNKNOWN_ERROR',
        message: 'invalid',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown fields and unsupported schema versions', () => {
    const input = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录测试',
        description: '',
      }),
      unexpected: true,
    }

    expect(e2eTestCaseSchema.safeParse(input).success).toBe(false)
    expect(
      e2eTestCaseSchema.safeParse({
        ...input,
        unexpected: undefined,
        schemaVersion: '2.0',
      }).success,
    ).toBe(false)
  })
})

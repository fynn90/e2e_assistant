/**
 * 验证前端字段错误映射与保存/生成两级校验。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import {
  issuesToValidationSummaries,
  getDraftGenerationIssues,
  validateDraftForGeneration,
  validateDraftForSave,
} from '../../src/modules/e2e-test-case/validation/test-case-form-validator'

describe('E2E form validation', () => {
  it('keeps the default structural draft loadable but blocks saving and generation', () => {
    const draft = createDefaultE2ETestCase({
      skillId: 'abc123def',
      title: '登录测试',
      description: '',
    })

    expect(validateDraftForSave(draft)).toMatchObject({
      description: expect.any(String),
      baseUrl: expect.any(String),
    })
    expect(validateDraftForGeneration(draft)).toMatchObject({
      description: expect.any(String),
      baseUrl: expect.any(String),
      steps: expect.any(String),
    })
  })

  it('maps row validation errors to stable field paths', () => {
    const draft = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录测试',
        description: '描述',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_one',
          order: 1,
          description: '',
          action: '',
          expectedResult: '',
          testData: {},
          enabled: true,
        },
      ],
    }

    expect(validateDraftForSave(draft)).toMatchObject({
      'steps.0.description': expect.any(String),
      'steps.0.action': expect.any(String),
      'steps.0.expectedResult': expect.any(String),
    })
  })

  it('does not block plaintext sensitive test data in MVP', () => {
    const draft = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录测试',
        description: '描述',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_one',
          order: 1,
          description: '填写用户名和密码',
          action: '填写用户名或手机号和密码',
          expectedResult: '进入工作台',
          testData: { password: '123456' },
          enabled: true,
        },
      ],
    }

    // 敏感数据总开关关闭：保存与生成两级校验都放行明文测试数据
    expect(validateDraftForSave(draft)).toEqual({})
    expect(validateDraftForGeneration(draft)).toEqual({})
  })

  it('maps test data issues to a navigable step field', () => {
    const draft = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录测试',
        description: '描述',
      }),
      baseUrl: 'https://example.test',
      steps: [
        {
          id: 'step_one',
          order: 1,
          description: '填写用户名和密码',
          action: '填写用户名或手机号和密码',
          expectedResult: '进入工作台',
          // 空键名是始终生效的测试数据约束，用它验证测试数据区的导航映射
          testData: { '': '123456' },
          enabled: true,
        },
      ],
    }
    const summary = issuesToValidationSummaries(
      getDraftGenerationIssues(draft),
    ).find((item) => item.path.startsWith('steps.0.testData'))

    expect(summary).toMatchObject({
      label: '步骤 1 · 测试数据',
      targetId: 'e2e-step-0-test-data',
    })
  })

  it('retains ordered duplicate issues and maps them to stable focus targets', () => {
    const draft = {
      ...createDefaultE2ETestCase({
        skillId: 'abc123def',
        title: '登录测试',
        description: '描述',
      }),
      baseUrl: '',
      steps: [
        {
          id: 'step_one',
          order: 1,
          description: '',
          action: '',
          expectedResult: '',
          testData: {},
          enabled: true,
        },
      ],
    }
    const summaries = issuesToValidationSummaries(
      getDraftGenerationIssues(draft),
    )

    expect(summaries.map((summary) => summary.targetId)).toEqual(
      expect.arrayContaining([
        'e2e-base-url',
        'e2e-step-0-description',
        'e2e-step-0-action',
        'e2e-step-0-expectedResult',
      ]),
    )
    expect(
      summaries.find((summary) => summary.targetId === 'e2e-step-0-action'),
    ).toMatchObject({
      label: '步骤 1 · 操作动作',
      path: 'steps.0.action',
    })
  })
})

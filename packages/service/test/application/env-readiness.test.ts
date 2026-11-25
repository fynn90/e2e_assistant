/**
 * 生成前 env 引用就绪校验（J1–J3）的判定表测试（v10 PRD 7.3）。
 */
import { describe, expect, it } from 'vitest'
import {
  createDefaultE2ETestCase,
  type IE2ETestCase,
} from '@fynn90-e2e_assistant/types'
import {
  validateEnvReferencesForGeneration,
  type TEnvFileState,
} from '../../src/application/e2e-test-case/env-readiness'

/** 构造一个引用了指定 env key 的用例。 */
function draftWithReference (reference: string): IE2ETestCase {
  return {
    ...createDefaultE2ETestCase({
      skillId: 'abc123def',
      title: '登录测试',
      description: '验证用户登录。',
    }),
    baseUrl: 'https://example.test',
    preconditions: [{ id: 'pre_1', description: `已持有令牌 ${reference}` }],
    steps: [
      {
        id: 'step_1',
        order: 1,
        description: '提交登录表单',
        action: '填写账号密码并提交',
        expectedResult: '进入工作台',
        testData: { E2E_PASSWORD: '${ENV:E2E_PASSWORD}' },
        enabled: true,
      },
    ],
  }
}

const noReferenceDraft = createDefaultE2ETestCase({
  skillId: 'abc123def',
  title: '登录测试',
  description: '验证用户登录。',
})

describe('validateEnvReferencesForGeneration（PRD 7.3 判定表）', () => {
  const okState: TEnvFileState = {
    status: 'ok',
    keys: new Set(['E2E_PASSWORD']),
  }

  it('envFile=ok 且引用全部存在 → 通过', () => {
    expect(
      validateEnvReferencesForGeneration(
        draftWithReference('${ENV:E2E_PASSWORD}'),
        okState,
      ),
    ).toEqual([])
  })

  it('envFile=ok 且存在失效引用（J1）→ 每个失效位置一条 ENV_REFERENCE_MISSING', () => {
    const draft = draftWithReference('${ENV:MISSING_KEY}')
    const issues = validateEnvReferencesForGeneration(draft, okState)

    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('ENV_REFERENCE_MISSING')
    expect(issues[0]?.path).toEqual(['preconditions', 0, 'description'])
    expect(issues[0]?.message).toContain('MISSING_KEY')
    expect(issues[0]?.message).toContain('前置条件 1')
  })

  it('同一失效 key 出现在多个位置时逐位置列出', () => {
    const draft = draftWithReference('${ENV:MISSING_KEY}')
    draft.steps[0]!.action = '操作 ${ENV:MISSING_KEY}'
    const issues = validateEnvReferencesForGeneration(draft, okState)

    expect(issues.map((issue) => issue.path.join('.'))).toEqual([
      'preconditions.0.description',
      'steps.0.action',
    ])
  })

  it('envFile=invalid 且用例存在引用（J2）→ 一条 ENV_FILE_UNAVAILABLE', () => {
    const issues = validateEnvReferencesForGeneration(
      draftWithReference('${ENV:E2E_PASSWORD}'),
      { status: 'invalid' },
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('ENV_FILE_UNAVAILABLE')
    expect(issues[0]?.path).toEqual(['env.json'])
    expect(issues[0]?.message).toContain('格式错误')
  })

  it('envFile=missing 且用例存在引用（J2）→ 提示缺失', () => {
    const issues = validateEnvReferencesForGeneration(
      draftWithReference('${ENV:E2E_PASSWORD}'),
      { status: 'missing' },
    )

    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('ENV_FILE_UNAVAILABLE')
    expect(issues[0]?.message).toContain('缺失')
  })

  it('envFile=missing/invalid 且用例无引用（J3）→ 不阻断', () => {
    expect(
      validateEnvReferencesForGeneration(noReferenceDraft, {
        status: 'missing',
      }),
    ).toEqual([])
    expect(
      validateEnvReferencesForGeneration(noReferenceDraft, {
        status: 'invalid',
      }),
    ).toEqual([])
  })

  it('敏感数据条目（键即 env key）与测试数据值中的引用都被识别', () => {
    // testData 值恰为 `${ENV:E2E_PASSWORD}` 的敏感条目与普通值引用均计入。
    const draft = draftWithReference('${ENV:E2E_PASSWORD}')
    const issues = validateEnvReferencesForGeneration(draft, {
      status: 'ok',
      keys: new Set(),
    })

    const paths = issues.map((issue) => issue.path.join('.'))
    expect(paths).toContain('steps.0.testData.E2E_PASSWORD')
    expect(paths).toContain('preconditions.0.description')
  })

  it('禁用步骤中的引用不参与判定（与脚本生成范围一致）', () => {
    const draft = draftWithReference('${ENV:E2E_PASSWORD}')
    draft.steps[0]!.enabled = false
    draft.preconditions = []

    expect(
      validateEnvReferencesForGeneration(draft, {
        status: 'ok',
        keys: new Set(),
      }),
    ).toEqual([])
  })
})

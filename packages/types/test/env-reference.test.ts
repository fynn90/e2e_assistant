/**
 * 验证用例 `${ENV:KEY}` 引用的提取、失效判定与敏感数据行契约。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSensitiveReferenceValue,
  collectEnvReferences,
  ENV_REFERENCE_PATTERN,
  findMissingEnvReferences,
  isSensitiveTestDataEntry,
  isUnselectedSensitiveEntry,
  SENSITIVE_ROW_UNSELECTED_VALUE,
  SUGGESTIVE_SENSITIVE_KEY_PATTERN,
  type IEnvReferenceScanSource,
} from '../src/domain/env-reference'

/** 构造一个覆盖各文本字段的最小用例。 */
function createScanSource(
  overrides: Partial<IEnvReferenceScanSource> = {},
): IEnvReferenceScanSource {
  return {
    title: '标题 ${ENV:TITLE_KEY}',
    description: '描述 ${ENV:DESC_KEY}',
    baseUrl: 'https://example.test/${ENV:URL_KEY}',
    tags: ['${ENV:TAG_KEY}'],
    preconditions: [{ description: '已登录 ${ENV:PRE_KEY}' }],
    steps: [
      {
        enabled: true,
        description: '步骤一 ${ENV:STEP_KEY}',
        action: '点击 ${ENV:ACTION_KEY}',
        expectedResult: '可见 ${ENV:RESULT_KEY}',
        testData: {
          E2E_PASSWORD: '${ENV:E2E_PASSWORD}',
          note: '备注 ${ENV:NOTE_KEY}',
        },
      },
      {
        enabled: false,
        description: '禁用步骤 ${ENV:DISABLED_KEY}',
        testData: { DISABLED: '${ENV:DISABLED_KEY}' },
      },
    ],
    ...overrides,
  }
}

describe('collectEnvReferences', () => {
  it('collects references from all text fields, deduped and sorted', () => {
    expect(collectEnvReferences(createScanSource())).toEqual([
      'ACTION_KEY',
      'DESC_KEY',
      'E2E_PASSWORD',
      'NOTE_KEY',
      'PRE_KEY',
      'RESULT_KEY',
      'STEP_KEY',
      'TAG_KEY',
      'TITLE_KEY',
      'URL_KEY',
    ])
  })

  it('ignores disabled steps (与脚本生成范围一致)', () => {
    const keys = collectEnvReferences(createScanSource())
    expect(keys).not.toContain('DISABLED_KEY')
  })

  it('tolerates missing optional fields (engine 最小用例形态)', () => {
    expect(
      collectEnvReferences({
        title: 't ${ENV:A}',
        baseUrl: 'https://example.test',
        steps: [{ enabled: true }],
      }),
    ).toEqual(['A'])
  })
})

describe('findMissingEnvReferences', () => {
  it('locates missing references with issue-compatible paths', () => {
    const findings = findMissingEnvReferences(
      createScanSource(),
      new Set(['E2E_PASSWORD']),
    )
    const paths = findings.map((finding) => finding.path.join('.'))

    expect(paths).toContain('preconditions.0.description')
    expect(paths).toContain('steps.0.testData.note')
    // 已存在于 env.json 的 E2E_PASSWORD 不产生失效定位。
    expect(paths).not.toContain('steps.0.testData.E2E_PASSWORD')
    expect(paths.some((path) => path.startsWith('steps.1'))).toBe(false)
    // 同一字段内重复出现只产出一条定位（title 中的 TITLE_KEY 失效，恰一条）。
    expect(findings.filter((f) => f.path.join('.') === 'title')).toHaveLength(1)
  })

  it('reports missing sensitive-row key once per entry', () => {
    const findings = findMissingEnvReferences(
      createScanSource(),
      new Set(['PRESENT']),
    )
    const entryFindings = findings.filter(
      (finding) => finding.path.join('.') === 'steps.0.testData.E2E_PASSWORD',
    )
    expect(entryFindings).toHaveLength(1)
    expect(entryFindings[0]?.key).toBe('E2E_PASSWORD')
  })

  it('returns empty when every referenced key exists', () => {
    const allKeys = collectEnvReferences(createScanSource())
    expect(
      findMissingEnvReferences(createScanSource(), new Set(allKeys)),
    ).toEqual([])
  })
})

describe('sensitive test data row contract（第三次修订：键名与所引 key 解耦）', () => {
  it('recognizes well-formed sensitive entries by value only', () => {
    expect(isSensitiveTestDataEntry('${ENV:E2E_PASSWORD}')).toBe(true)
    expect(isSensitiveTestDataEntry(' ${ENV:E2E_PASSWORD} ')).toBe(true)
    // 键名与所引 key 解耦：键名任意（用户命名），只判值。
    expect(isSensitiveTestDataEntry('x${ENV:E2E_PASSWORD}')).toBe(false)
    expect(isSensitiveTestDataEntry('${ENV:E2E_PASSWORD}x')).toBe(false)
    // 键名不满足 env key 规则的占位符不是有效引用形态。
    expect(isSensitiveTestDataEntry('${ENV:password}')).toBe(false)
    expect(isSensitiveTestDataEntry('')).toBe(false)
  })

  it('recognizes the unselected sentinel regardless of label and it is not a valid reference', () => {
    expect(isUnselectedSensitiveEntry(SENSITIVE_ROW_UNSELECTED_VALUE)).toBe(
      true,
    )
    expect(isUnselectedSensitiveEntry('')).toBe(false)
    expect(isUnselectedSensitiveEntry('${ENV:E2E_PASSWORD}')).toBe(false)
    // 残缺占位符不会被引用提取正则识别。
    expect([
      ...SENSITIVE_ROW_UNSELECTED_VALUE.matchAll(ENV_REFERENCE_PATTERN),
    ]).toEqual([])
  })

  it('builds the persisted reference value', () => {
    expect(buildSensitiveReferenceValue('E2E_PASSWORD')).toBe(
      '${ENV:E2E_PASSWORD}',
    )
  })
})

describe('SUGGESTIVE_SENSITIVE_KEY_PATTERN (W1 词根)', () => {
  it('matches roots case-insensitively as substrings', () => {
    for (const key of [
      'password',
      'userPassword',
      'PASSWORD',
      'TOKEN_OLD',
      'api_key',
      'apiKey',
      'my-secret',
      '验证码',
    ]) {
      expect(SUGGESTIVE_SENSITIVE_KEY_PATTERN.test(key)).toBe(true)
    }
    for (const key of ['username', 'code', 'note']) {
      expect(SUGGESTIVE_SENSITIVE_KEY_PATTERN.test(key)).toBe(false)
    }
  })
})

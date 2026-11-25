/**
 * 验证原始 e2e_schema.json 修复的 JSON 行列与 Schema 错误。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import {
  parseRawE2ETestCase,
  RawE2ETestCaseParseError,
} from '../../src/modules/e2e-test-case/utils/parse-raw-test-case'

describe('raw E2E test case parser', () => {
  it('parses a structurally valid raw document', () => {
    const testCase = createDefaultE2ETestCase({
      skillId: 'abc123def',
      title: '登录测试',
      description: '',
    })

    expect(parseRawE2ETestCase(JSON.stringify(testCase))).toEqual(testCase)
  })

  it('reports JSON line and column information', () => {
    expect(() =>
      parseRawE2ETestCase('{\n  "schemaVersion": "1.0",\n}'),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/第 3 行.*第 1 列/),
      }),
    )
  })

  it('reports the first schema field path', () => {
    expect(() =>
      parseRawE2ETestCase(JSON.stringify({ schemaVersion: '2.0' })),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('schemaVersion'),
      }),
    )
  })
})

/**
 * 验证 env.json 的解析与 R1–R5 格式校验规则。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ENV_FILE_CONTENT,
  ENV_KEY_PATTERN,
  extractEnvFileKeys,
  parseEnvFileContent,
} from '../src/domain/env-file'

describe('env-file parse and validation', () => {
  it('accepts an empty object and empty-string values (合法边界)', () => {
    const empty = parseEnvFileContent(DEFAULT_ENV_FILE_CONTENT)
    expect(empty.issues).toEqual([])
    expect(empty.data).toEqual({})

    const result = parseEnvFileContent('{\n  "E2E_TOKEN": ""\n}')
    expect(result.issues).toEqual([])
    expect(result.data).toEqual({ E2E_TOKEN: '' })
  })

  it('accepts valid keys and string values', () => {
    const result = parseEnvFileContent(
      '{\n  "E2E_PASSWORD": "真实密码值",\n  "_ADMIN_TOKEN_2": "令牌"\n}',
    )
    expect(result.issues).toEqual([])
    expect(result.data).toEqual({
      E2E_PASSWORD: '真实密码值',
      _ADMIN_TOKEN_2: '令牌',
    })
  })

  it('reports syntax errors with line/column (R1)', () => {
    // 第二行末尾缺逗号：出错位置应落在第三行开头。
    const result = parseEnvFileContent('{\n  "A": "1"\n  "B": "2"\n}')
    expect(result.data).toBeNull()
    const syntax = result.issues.find(
      (issue) => issue.code === 'ENV_SYNTAX_ERROR',
    )
    expect(syntax).toBeDefined()
    expect(syntax?.line).toBe(3)
    expect(syntax?.column).toBeGreaterThanOrEqual(1)
    expect(syntax?.message).toContain('JSON 语法错误')
  })

  it('reports syntax errors without position when unknown (R1 降级)', () => {
    // 构造无法提取 position 的异常消息形态：直接断言不抛出且仍有问题产出。
    const result = parseEnvFileContent('{ "A": ')
    const syntax = result.issues.find(
      (issue) => issue.code === 'ENV_SYNTAX_ERROR',
    )
    expect(syntax).toBeDefined()
  })

  it('rejects non-object top level (R2)', () => {
    for (const text of ['[]', '"text"', '123', 'true', 'null']) {
      const result = parseEnvFileContent(text)
      expect(result.issues.map((issue) => issue.code)).toContain(
        'ENV_TOP_LEVEL_TYPE',
      )
      expect(result.data).toBeNull()
    }
  })

  it('rejects keys violating the naming rule (R3)', () => {
    const result = parseEnvFileContent(
      '{\n  "password": "a",\n  "1BAD": "b",\n  "中文名": "c"\n}',
    )
    const formatIssues = result.issues.filter(
      (issue) => issue.code === 'ENV_KEY_FORMAT',
    )
    expect(formatIssues.map((issue) => issue.key).sort()).toEqual([
      '1BAD',
      'password',
      '中文名',
    ])
    expect(formatIssues[0]?.message).toContain('不符合命名规则')
    expect(result.data).toBeNull()
  })

  it('detects duplicated keys that JSON.parse would silently drop (R4)', () => {
    const result = parseEnvFileContent('{\n  "TOKEN": "a",\n  "TOKEN": "b"\n}')
    const duplicated = result.issues.filter(
      (issue) => issue.code === 'ENV_KEY_DUPLICATED',
    )
    expect(duplicated).toHaveLength(1)
    expect(duplicated[0]?.key).toBe('TOKEN')
    expect(duplicated[0]?.message).toContain('重复定义')
  })

  it('does not misreport nested same-name keys as duplicates (R4 只扫描顶层)', () => {
    // 嵌套对象中的同名 key 由 R5 拒绝，但不应产生重复误报。
    const result = parseEnvFileContent(
      '{\n  "TOKEN": "a",\n  "NESTED": {"TOKEN": "b"}\n}',
    )
    expect(
      result.issues.filter((issue) => issue.code === 'ENV_KEY_DUPLICATED'),
    ).toEqual([])
    expect(result.issues.map((issue) => issue.code)).toContain('ENV_VALUE_TYPE')
  })

  it('rejects non-string values (R5)', () => {
    const result = parseEnvFileContent(
      '{\n  "NUMBER": 1,\n  "BOOLEAN": true,\n  "NULL": null,\n  "OBJECT": {},\n  "ARRAY": []\n}',
    )
    const typeIssues = result.issues.filter(
      (issue) => issue.code === 'ENV_VALUE_TYPE',
    )
    expect(typeIssues.map((issue) => issue.key).sort()).toEqual([
      'ARRAY',
      'BOOLEAN',
      'NULL',
      'NUMBER',
      'OBJECT',
    ])
    expect(result.data).toBeNull()
  })

  it('collects all issue kinds without short-circuiting', () => {
    const result = parseEnvFileContent('{\n  "lower": 1\n}')
    const codes = result.issues.map((issue) => issue.code)
    expect(codes).toContain('ENV_KEY_FORMAT')
    expect(codes).toContain('ENV_VALUE_TYPE')
  })

  it('extracts keys in alphabetical order', () => {
    expect(
      extractEnvFileKeys({ TOKEN: 'b', ADMIN_TOKEN: 'a', E2E_PASSWORD: 'c' }),
    ).toEqual(['ADMIN_TOKEN', 'E2E_PASSWORD', 'TOKEN'])
  })

  it('exposes the shared key naming pattern', () => {
    expect(ENV_KEY_PATTERN.test('E2E_PASSWORD')).toBe(true)
    expect(ENV_KEY_PATTERN.test('_PRIVATE')).toBe(true)
    expect(ENV_KEY_PATTERN.test('password')).toBe(false)
    expect(ENV_KEY_PATTERN.test('1BAD')).toBe(false)
  })

  it('拒绝占用平台内置变量名 SKILL_USER_WORKSPACE（v14 W38，ENV_KEY_RESERVED）', () => {
    // 该 key 命名合法（全大写下划线），但属平台执行期注入的内置名，
    // 业务占用会被平台值覆盖且语义错乱，必须在解析层直接拒绝落盘。
    const result = parseEnvFileContent(
      '{\n  "SKILL_USER_WORKSPACE": "/some/path"\n}',
    )
    const reserved = result.issues.filter(
      (issue) => issue.code === 'ENV_KEY_RESERVED',
    )
    expect(reserved).toHaveLength(1)
    expect(reserved[0].key).toBe('SKILL_USER_WORKSPACE')
    // 保留名违规同样让整体不可落盘。
    expect(result.data).toBeNull()
  })

  it('保留名拒绝与命名/类型问题并存时不短路（v14）', () => {
    const result = parseEnvFileContent(
      '{\n  "SKILL_USER_WORKSPACE": "x",\n  "lower": 1\n}',
    )
    const codes = result.issues.map((issue) => issue.code)
    expect(codes).toContain('ENV_KEY_RESERVED')
    expect(codes).toContain('ENV_KEY_FORMAT')
    expect(codes).toContain('ENV_VALUE_TYPE')
  })
})

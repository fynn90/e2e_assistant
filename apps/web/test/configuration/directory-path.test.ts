// 目录路径工具测试：确保 Windows 与 POSIX 两类路径的面包屑与拼接结果正确。
import { describe, expect, it } from 'vitest'
import {
  buildDirectoryBreadcrumbs,
  joinDirectoryPath,
  splitDirectoryPath,
  validateAbsoluteDirectoryPath,
} from '../../src/modules/configuration/utils/directory-path'

describe('splitDirectoryPath', () => {
  it('splits a Windows drive path and keeps the drive root', () => {
    expect(splitDirectoryPath('D:\\test agent\\workspace')).toEqual({
      root: 'D:\\',
      segments: ['test agent', 'workspace'],
    })
  })

  it('splits a Windows drive root without segments', () => {
    expect(splitDirectoryPath('D:\\')).toEqual({ root: 'D:\\', segments: [] })
  })

  it('splits a POSIX path', () => {
    expect(splitDirectoryPath('/Users/your-name/authine-workspace')).toEqual({
      root: '/',
      segments: ['Users', 'your-name', 'authine-workspace'],
    })
  })

  it('keeps the POSIX root without segments', () => {
    expect(splitDirectoryPath('/')).toEqual({ root: '/', segments: [] })
  })

  it('collapses repeated and trailing separators', () => {
    expect(splitDirectoryPath('/a//b/')).toEqual({
      root: '/',
      segments: ['a', 'b'],
    })
  })

  it('preserves non-ASCII and space characters in segments', () => {
    expect(splitDirectoryPath('D:\\项目 目录\\子目录')).toEqual({
      root: 'D:\\',
      segments: ['项目 目录', '子目录'],
    })
  })

  it('returns an empty result for blank input', () => {
    expect(splitDirectoryPath('   ')).toEqual({ root: '', segments: [] })
  })
})

describe('buildDirectoryBreadcrumbs', () => {
  it('builds clickable breadcrumbs for a Windows path', () => {
    expect(buildDirectoryBreadcrumbs('D:\\test agent\\workspace')).toEqual([
      { label: 'D:', path: 'D:\\' },
      { label: 'test agent', path: 'D:\\test agent' },
      { label: 'workspace', path: 'D:\\test agent\\workspace' },
    ])
  })

  it('builds breadcrumbs that accumulate absolute paths for a POSIX path', () => {
    expect(buildDirectoryBreadcrumbs('/Users/name/workspace')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'name', path: '/Users/name' },
      { label: 'workspace', path: '/Users/name/workspace' },
    ])
  })

  it('returns only the root breadcrumb for a file system root', () => {
    expect(buildDirectoryBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }])
  })

  it('returns an empty list for blank input', () => {
    expect(buildDirectoryBreadcrumbs('')).toEqual([])
  })

  it('keeps the last breadcrumb path equal to the navigated directory', () => {
    const breadcrumbs = buildDirectoryBreadcrumbs('D:\\项目 目录\\子目录')

    expect(breadcrumbs[breadcrumbs.length - 1].path).toBe(
      'D:\\项目 目录\\子目录',
    )
  })
})

describe('validateAbsoluteDirectoryPath', () => {
  it.each([
    '/Users/your-name/workspace',
    '/',
    'D:\\',
    'D:\\test agent\\workspace',
    'e:\\lower',
    'C:/forward/slash',
    '\\\\srv\\share',
  ])('accepts the absolute path %s', (value) => {
    expect(validateAbsoluteDirectoryPath(value)).toEqual({ valid: true })
  })

  it('accepts a bare drive letter on Windows because the server expands it', () => {
    expect(validateAbsoluteDirectoryPath('D:', 'win32')).toEqual({
      valid: true,
    })
  })

  it.each(['darwin', 'linux'] as const)(
    'rejects a bare drive letter on %s where a colon is a legal file name character',
    (platform) => {
      // 在 macOS/Linux 上 'D:' 是普通相对目录名，放行会导致静默解析到 CLI 工作目录下。
      const result = validateAbsoluteDirectoryPath('D:', platform)

      expect(result.valid).toBe(false)
    },
  )

  it('accepts POSIX absolute paths regardless of the reported platform', () => {
    expect(
      validateAbsoluteDirectoryPath('/Users/your-name/workspace', 'darwin'),
    ).toEqual({
      valid: true,
    })
    expect(validateAbsoluteDirectoryPath('/home/alice/data', 'linux')).toEqual({
      valid: true,
    })
  })

  it('accepts Windows absolute paths regardless of the reported platform', () => {
    // 路径风格判定保持平台无关：浏览器无法可靠得知 CLI 运行平台。
    expect(validateAbsoluteDirectoryPath('D:\\workspace', 'darwin')).toEqual({
      valid: true,
    })
    expect(validateAbsoluteDirectoryPath('C:\\Program Files', 'linux')).toEqual(
      { valid: true },
    )
  })

  it.each([
    ['relative directory', 'workspace'],
    ['nested relative path', 'workspace/nested'],
    ['current directory', '.'],
    ['parent directory', '..'],
    ['home shorthand', '~'],
    ['drive-relative path', 'D:workspace'],
    ['bare drive letter without colon', 'D'],
  ])('rejects the non-absolute path %s', (_label, value) => {
    // 相对路径必须被拒绝，而不是静默按 CLI 进程工作目录解析，
    // 否则用户会选到意料之外的目录。
    const result = validateAbsoluteDirectoryPath(value)

    expect(result.valid).toBe(false)
    expect(result.valid === false && result.message).toContain('绝对路径')
  })

  it('reports a dedicated message for blank input', () => {
    const result = validateAbsoluteDirectoryPath('   ')

    expect(result).toEqual({ valid: false, message: '请输入目录路径。' })
  })

  it('ignores surrounding whitespace when validating', () => {
    expect(validateAbsoluteDirectoryPath('  D:\\workspace  ')).toEqual({
      valid: true,
    })
  })
})

describe('joinDirectoryPath', () => {
  it('joins with a backslash for Windows paths', () => {
    expect(joinDirectoryPath('D:\\test agent', 'workspace')).toBe(
      'D:\\test agent\\workspace',
    )
  })

  it('joins with a slash for POSIX paths', () => {
    expect(joinDirectoryPath('/Users/name', 'workspace')).toBe(
      '/Users/name/workspace',
    )
  })

  it('does not duplicate an existing trailing separator', () => {
    expect(joinDirectoryPath('/Users/name/', 'workspace')).toBe(
      '/Users/name/workspace',
    )
    expect(joinDirectoryPath('D:\\', 'workspace')).toBe('D:\\workspace')
  })

  it('returns the name when the parent path is empty', () => {
    expect(joinDirectoryPath('', 'workspace')).toBe('workspace')
  })
})

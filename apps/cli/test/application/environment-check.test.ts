/**
 * Node 版本校验的测试。
 *
 * 关键契约：**校验本身不打印**。原先它在 application 层直接 `console.error`，
 * 于是终端文案散落在各层、风格无法统一（旧版带 `【cli】` 前缀，新版是面板）。
 * 现在它只返回结果，由命令层决定怎么呈现——本文件锁定这条边界。
 */
import { describe, expect, it, vi } from 'vitest'
import { checkNodeVersion } from '../../src/application/environment-check'

describe('checkNodeVersion', () => {
  it('当前 Node 满足要求时返回 satisfied', () => {
    // 测试能跑起来本身就说明版本达标（engines 要求 >= 22.19.0）。
    expect(checkNodeVersion()).toEqual({ satisfied: true })
  })

  it('校验过程不向 stdout / stderr 写任何内容', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => { })

    try {
      checkNodeVersion()

      expect(consoleErrorSpy).not.toHaveBeenCalled()
      expect(stdoutSpy).not.toHaveBeenCalled()
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    }
  })

  it('返回的失败说明里带最低版本号与升级指引', () => {
    // 通过临时篡改 process.versions.node 触发失败分支。
    const originalVersion = process.versions.node
    Object.defineProperty(process.versions, 'node', {
      value: '1.0.0',
      configurable: true,
    })

    try {
      const result = checkNodeVersion()

      expect(result.satisfied).toBe(false)
      if (!result.satisfied) {
        expect(result.message).toContain('22.19.0')
        expect(result.message).toContain('e2e_assistant')
      }
    } finally {
      Object.defineProperty(process.versions, 'node', {
        value: originalVersion,
        configurable: true,
      })
    }
  })

  it('版本号无法解析时给出可执行的说明', () => {
    const originalVersion = process.versions.node
    Object.defineProperty(process.versions, 'node', {
      value: 'not-a-version',
      configurable: true,
    })

    try {
      const result = checkNodeVersion()

      expect(result.satisfied).toBe(false)
      if (!result.satisfied) {
        expect(result.message).toContain('无法识别')
      }
    } finally {
      Object.defineProperty(process.versions, 'node', {
        value: originalVersion,
        configurable: true,
      })
    }
  })
})

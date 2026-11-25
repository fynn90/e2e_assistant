/**
 * bash 探测结果在启动面板上的呈现测试。
 *
 * 背景：该探测原先自己 `console.log`，于是有两个问题——
 *   1. 分层：application 层直接拼终端文案（含 `【cli】` 前缀），与 presentation
 *      层的面板风格不一致，用户会看到新旧两种排版混在一起；
 *   2. 后台模式下子进程的 stdout 被重定向到日志文件，那行提示既不在用户眼前、
 *      又混进了服务日志。
 *
 * 因此探测改为**只返回结构化结果**，由启动面板呈现。本文件锁定这个契约：
 * 探测函数本身不产生任何输出。
 */
import { describe, expect, it, vi } from 'vitest'
import { probeBashShell } from '../../src/application/bash-shell-check'

describe('probeBashShell 不产生输出', () => {
  it('探测过程不向 stdout / stderr 写任何内容', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {})

    try {
      const probe = probeBashShell()

      // 结果必须是可判别的三态之一——调用方据此决定要不要渲染、怎么渲染。
      expect(['not-applicable', 'found', 'missing']).toContain(probe.outcome)

      expect(consoleLogSpy).not.toHaveBeenCalled()
      expect(consoleWarnSpy).not.toHaveBeenCalled()
      expect(stdoutSpy).not.toHaveBeenCalled()
      expect(stderrSpy).not.toHaveBeenCalled()
    } finally {
      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
      consoleLogSpy.mockRestore()
      consoleWarnSpy.mockRestore()
    }
  })

  it('命中时带出路径，供组合根注入 shellPath', () => {
    const probe = probeBashShell()

    if (probe.outcome === 'found') {
      expect(typeof probe.path).toBe('string')
      expect(probe.path.length).toBeGreaterThan(0)
    }
  })
})

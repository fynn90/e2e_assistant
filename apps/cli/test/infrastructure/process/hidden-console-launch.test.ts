/**
 * 隐藏控制台启动模块测试（v21）。
 *
 * 锁定的性质：VBS 脚本具备「隐藏窗口 + 等待结束 + 输出追加重定向 + 退出码透传」
 * 四要素，且 wscript 的参数顺序与 VBS 的参数约定一致——这两点是「不再弹控制台
 * 黑窗且日志不丢」的全部依据（真实行为由 Windows 集成验证覆盖）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildHiddenLaunchInvocation,
  buildHiddenLaunchScript,
} from '../../../src/infrastructure/process/hidden-console-launch'

describe('buildHiddenLaunchScript', () => {
  it('以隐藏窗口运行命令、等待结束并透传退出码', () => {
    const script = buildHiddenLaunchScript()

    expect(script).toContain('CreateObject("WScript.Shell")')
    // 窗口样式 0（隐藏）+ True（等待结束）：隐藏控制台的唯一来源。
    expect(script).toContain(', 0, True)')
    // 退出码透传：服务启动失败的原因不会被 wscript 吞成 0。
    expect(script).toContain('WScript.Quit exitCode')
  })

  it('把子进程输出追加重定向到日志文件', () => {
    const script = buildHiddenLaunchScript()

    // 实测：Run 不继承父进程 stdio，不显式重定向就会得到空日志。
    expect(script).toContain('cmd.exe /d /s /c ')
    expect(script).toContain('>> ')
    expect(script).toContain('2>&1')
  })

  it('参数按 Windows 命令行规则加引号并转义内部引号', () => {
    const script = buildHiddenLaunchScript()

    expect(script).toContain('Replace(value, """", """""")')
    expect(script).toContain('QuoteArgument(WScript.Arguments(index))')
  })

  it('参数不足时以退出码 2 结束，不静默执行空命令', () => {
    expect(buildHiddenLaunchScript()).toContain('WScript.Quit 2')
  })
})

describe('buildHiddenLaunchInvocation', () => {
  it('按「脚本、日志、命令、参数」顺序组装 wscript 调用', () => {
    const invocation = buildHiddenLaunchInvocation({
      scriptPath: 'C:/config/hidden-launch.vbs',
      logPath: 'C:/config/logs/service.log',
      command: 'C:/node/node.exe',
      args: ['C:/cli/index.js', 'start', '--foreground'],
    })

    expect(invocation.command).toBe('wscript.exe')
    expect(invocation.args).toEqual([
      'C:/config/hidden-launch.vbs',
      'C:/config/logs/service.log',
      'C:/node/node.exe',
      'C:/cli/index.js',
      'start',
      '--foreground',
    ])
  })
})

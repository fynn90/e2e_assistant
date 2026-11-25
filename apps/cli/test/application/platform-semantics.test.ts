/**
 * 平台语义测试（v19 跨平台要求）。
 *
 * 本机是 Windows，POSIX 分支无法真机执行——因此把平台差异收敛为一个纯函数，
 * 用注入的平台标识覆盖三条分支。这是「macOS / Linux 行为」在本仓库内
 * 唯一可被自动验证的形式。
 */
import { describe, expect, it } from 'vitest'
import { isSignalGracefulOnCurrentPlatform } from '../../src/application/service-lifecycle-dependencies'

describe('isSignalGracefulOnCurrentPlatform', () => {
  it('Windows 上信号是硬杀，不触发服务侧清理', () => {
    // Node 在 Windows 用 TerminateProcess 实现 process.kill(pid,'SIGTERM')，
    // 目标的信号处理器不会执行（技术方案实测 M2）。
    expect(isSignalGracefulOnCurrentPlatform('win32')).toBe(false)
  })

  it('macOS / Linux 上 SIGTERM 可被捕获，服务会执行收尾流程', () => {
    expect(isSignalGracefulOnCurrentPlatform('darwin')).toBe(true)
    expect(isSignalGracefulOnCurrentPlatform('linux')).toBe(true)
  })

  it('其他 POSIX 平台按「可优雅关闭」处理', () => {
    // 保守取「信号可捕获」这一侧：误判为优雅只是文案措辞问题，
    // 误判为硬杀会让用户以为资源没释放——两者里前者代价更小。
    expect(isSignalGracefulOnCurrentPlatform('freebsd')).toBe(true)
    expect(isSignalGracefulOnCurrentPlatform('aix')).toBe(true)
  })
})

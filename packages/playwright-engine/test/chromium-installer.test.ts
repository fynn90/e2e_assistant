/** 验证 Chromium detector/installer 的包内 CLI、进度和安装后复检行为。 */

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { IChromiumRuntime } from '../src/contracts/chromium'
import { ChromiumDetector } from '../src/chromium-installer/chromium-detector'
import { ChromiumInstaller } from '../src/chromium-installer/chromium-installer'
import type { IInstallProcess } from '../src/chromium-installer/install-process'

/**
 * 创建可模拟 Playwright 安装输出的子进程替身。
 */
class FakeInstallProcess extends EventEmitter {
  readonly pid = 42
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()

  /**
   * 模拟进程树终止。
   *
   * @param _signal - 兼容 ChildProcess 的终止信号。
   * @returns 表示已发出终止请求。
   * @throws 不抛出异常。
   */
  kill(_signal?: NodeJS.Signals): boolean {
    this.emit('close', null, 'SIGTERM')
    return true
  }
}

/**
 * 创建带有可控访问结果的 Chromium runtime 和文件检测器。
 *
 * @returns runtime、访问函数和修改安装状态的函数。
 * @throws 不抛出异常。
 */
function createFakeChromiumRuntime(): {
  runtime: IChromiumRuntime
  accessFile: (path: string) => Promise<void>
  markInstalled: () => void
} {
  let installed = false
  const runtime: IChromiumRuntime = {
    executablePath: () => 'C:/playwright/chromium.exe',
  }
  return {
    runtime,
    accessFile: async () => {
      if (!installed) {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
        throw error
      }
    },
    markInstalled: () => {
      installed = true
    },
  }
}

describe('ChromiumInstaller', () => {
  it('detects missing Chromium and installs with the package-local CLI', async () => {
    const fake = createFakeChromiumRuntime()
    const progress: string[] = []
    const calls: { command: string; args: readonly string[] }[] = []
    const fakeProcess = new FakeInstallProcess()
    const installer = new ChromiumInstaller({
      runtime: fake.runtime,
      accessFile: fake.accessFile,
      resolveCliPath: () => ['C:/package/node_modules/playwright/cli.js'],
      spawnProcess: (command, args) => {
        calls.push({ command, args })
        fake.markInstalled()
        queueMicrotask(() => {
          fakeProcess.stdout.write('Downloading Chromium\n')
          fakeProcess.stderr.write('password=do-not-log\n')
          fakeProcess.stdout.end()
          fakeProcess.stderr.end()
          fakeProcess.emit('close', 0, null)
        })
        return fakeProcess as unknown as IInstallProcess
      },
    })

    await expect(installer.detect()).resolves.toMatchObject({
      installed: false,
      executablePath: 'C:/playwright/chromium.exe',
    })
    const status = await installer.install({
      timeoutMs: 2_000,
      onProgress: (event) => progress.push(event.message),
    })

    expect(status.installed).toBe(true)
    expect(calls).toEqual([
      {
        command: globalThis.process.execPath,
        args: [
          'C:/package/node_modules/playwright/cli.js',
          'install',
          'chromium',
        ],
      },
    ])
    expect(
      progress.some((message) => message.includes('Downloading Chromium')),
    ).toBe(true)
    expect(progress.join('\n')).not.toContain('do-not-log')
  })

  it('resolves the package-local Playwright CLI script by default', async () => {
    const fake = createFakeChromiumRuntime()
    const fakeProcess = new FakeInstallProcess()
    const calls: { command: string; args: readonly string[] }[] = []
    const installer = new ChromiumInstaller({
      runtime: fake.runtime,
      accessFile: fake.accessFile,
      spawnProcess: (command, args) => {
        calls.push({ command, args })
        fake.markInstalled()
        queueMicrotask(() => {
          fakeProcess.stdout.end()
          fakeProcess.stderr.end()
          fakeProcess.emit('close', 0, null)
        })
        return fakeProcess as unknown as IInstallProcess
      },
    })

    await installer.install({ timeoutMs: 2_000 })

    // 默认解析必须落到真实存在的 cli.js 脚本：历史实现用 node -e 引导
    // program.parse(process.argv)，argv 少了脚本位导致 install 被吃掉，
    // 稳定报 unknown command 'chromium'（退出码 1），自动安装永远失败。
    expect(calls).toHaveLength(1)
    const [cliPath, ...restArgs] = calls[0]!.args
    expect(cliPath!.endsWith('cli.js')).toBe(true)
    expect(existsSync(cliPath!)).toBe(true)
    expect(restArgs).toEqual(['install', 'chromium'])
  })

  it('keeps CLI output in the failure message when the process exits non-zero', async () => {
    const fake = createFakeChromiumRuntime()
    const fakeProcess = new FakeInstallProcess()
    const installer = new ChromiumInstaller({
      runtime: fake.runtime,
      accessFile: fake.accessFile,
      resolveCliPath: () => ['C:/package/node_modules/playwright/cli.js'],
      spawnProcess: () => {
        queueMicrotask(() => {
          fakeProcess.stderr.write("error: unknown command 'chromium'\n")
          fakeProcess.stderr.end()
          fakeProcess.stdout.end()
          // 等输出行消费完再报退出，模拟真实子进程的事件顺序。
          setImmediate(() => fakeProcess.emit('close', 1, null))
        })
        return fakeProcess as unknown as IInstallProcess
      },
    })

    await expect(installer.install({ timeoutMs: 2_000 })).rejects.toMatchObject(
      {
        code: 'BROWSER_INSTALL_FAILED',
        message: expect.stringContaining("unknown command 'chromium'"),
      },
    )
  })

  it('reports cancellation before resolving the CLI', async () => {
    const fake = createFakeChromiumRuntime()
    const controller = new AbortController()
    controller.abort()
    const installer = new ChromiumInstaller({
      runtime: fake.runtime,
      accessFile: fake.accessFile,
      resolveCliPath: () => ['unused'],
    })

    await expect(
      installer.install({ signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'BROWSER_INSTALL_CANCELLED',
    })
  })
})

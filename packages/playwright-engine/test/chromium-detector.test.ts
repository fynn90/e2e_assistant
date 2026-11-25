/**
 * 验证 Chromium 检测器对「有头 + headless shell」两种可执行文件的校验。
 *
 * 回归目标：Playwright 的无头模式使用独立的 `chromium_headless_shell` 下载项，
 * 只检查有头可执行文件会产生「检测通过 → 实际启动失败」的假阳性，
 * 且默认路径（browserVisualization 为 false）恰好走无头模式。
 */
import { describe, expect, it } from 'vitest'
import type { IChromiumRuntime } from '../src/contracts/chromium'
import { ChromiumDetector } from '../src/chromium-installer/chromium-detector'

/** Windows 上 Playwright 缓存目录的真实布局。 */
const HEADED_PATH =
  'C:\\Users\\tester\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe'
const SHELL_PATH =
  'C:\\Users\\tester\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

/**
 * 创建按给定可用文件集合返回访问结果的检测器。
 *
 * @param availablePaths - 视为存在的绝对路径集合。
 * @returns 绑定该可用集合的检测器。
 * @throws 不抛出异常。
 */
function createDetector(availablePaths: Set<string>): ChromiumDetector {
  const runtime: IChromiumRuntime = {
    executablePath: () => HEADED_PATH,
  }

  return new ChromiumDetector({
    runtime,
    accessFile: async (targetPath: string) => {
      if (!availablePaths.has(targetPath)) {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
        throw error
      }
    },
  })
}

describe('ChromiumDetector headless shell 校验', () => {
  it('有头与 headless shell 都在位时报告已安装', async () => {
    const detector = createDetector(new Set([HEADED_PATH, SHELL_PATH]))

    await expect(detector.detect()).resolves.toMatchObject({
      installed: true,
      executablePath: HEADED_PATH,
    })
  })

  it('只有有头浏览器、缺 headless shell 时报告未安装', async () => {
    // 这是修复前的假阳性场景：检测通过但无头模式必然启动失败。
    const detector = createDetector(new Set([HEADED_PATH]))

    await expect(detector.detect()).resolves.toMatchObject({
      installed: false,
      executablePath: HEADED_PATH,
      reason: 'missing',
    })
  })

  it('有头浏览器缺失时直接报告未安装，不再检查 headless shell', async () => {
    const detector = createDetector(new Set([SHELL_PATH]))

    await expect(detector.detect()).resolves.toMatchObject({
      installed: false,
      reason: 'missing',
    })
  })

  it('runtime 提供显式 headlessShellPath 时以该路径为准', async () => {
    const customShell = 'D:\\custom\\headless-shell.exe'
    const detector = new ChromiumDetector({
      runtime: {
        executablePath: () => HEADED_PATH,
        headlessShellPath: () => customShell,
      },
      accessFile: async (targetPath: string) => {
        if (targetPath !== HEADED_PATH && targetPath !== customShell) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
      },
    })

    await expect(detector.detect()).resolves.toMatchObject({ installed: true })
  })

  it('无法从路径推导布局时跳过 headless shell 校验，保持向后兼容', async () => {
    // 替换实现（如测试替身或自定义打包布局）可能给不出标准目录结构。
    const detector = new ChromiumDetector({
      runtime: { executablePath: () => 'C:/playwright/chromium.exe' },
      accessFile: async () => undefined,
    })

    await expect(detector.detect()).resolves.toMatchObject({ installed: true })
  })
})

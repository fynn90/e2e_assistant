/** 检测 Playwright Chromium 可执行文件是否存在且可访问。 */

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import type { IChromiumRuntime, IChromiumStatus } from '../contracts/chromium'

/**
 * Chromium 检测器的依赖注入配置。
 */
export interface IChromiumDetectorOptions {
  runtime?: IChromiumRuntime
  accessFile?: (path: string) => Promise<void>
}

/**
 * 读取 Playwright Chromium 主可执行文件状态。
 */
export class ChromiumDetector {
  private readonly runtime: IChromiumRuntime
  private readonly accessFile: (path: string) => Promise<void>

  /**
   * 创建 Chromium 检测器。
   *
   * @param options - 可选的 Playwright runtime 和文件访问替身。
   * @returns 可用于生产和测试的检测器。
   * @throws 不抛出异常。
   */
  constructor(options: IChromiumDetectorOptions = {}) {
    this.runtime = options.runtime ?? chromium
    this.accessFile =
      options.accessFile ?? ((path) => access(path, constants.F_OK))
  }

  /**
   * 检查 Chromium 可执行路径是否存在。
   *
   * 校验范围覆盖有头与无头两种模式真正需要的可执行文件：
   * Playwright 的无头模式使用独立的 `chromium_headless_shell` 下载项，
   * 只检查有头浏览器会让「检测通过 → 实际启动失败」成为可能。
   *
   * @param options - 可选浏览器路径提示，实际路径由 Playwright runtime 解析。
   * @returns 可诊断的安装状态；任一必需可执行文件缺失都视为未安装。
   * @throws 不抛出异常；路径解析或访问失败转为 reason。
   */
  async detect(
    options: { browsersPath?: string } = {},
  ): Promise<IChromiumStatus> {
    void options
    let executablePath: string

    try {
      executablePath = this.runtime.executablePath()
    } catch {
      return {
        installed: false,
        executablePath: null,
        reason: 'invalid-path',
      }
    }

    if (!executablePath) {
      return {
        installed: false,
        executablePath: null,
        reason: 'missing',
      }
    }

    try {
      await this.accessFile(executablePath)
    } catch (error) {
      return {
        installed: false,
        executablePath,
        reason: classifyAccessFailure(error),
      }
    }

    // 有头可执行文件就位后，继续确认无头模式所需的 headless shell。
    const headlessShellPath = this.resolveHeadlessShellPath()

    if (headlessShellPath) {
      try {
        await this.accessFile(headlessShellPath)
      } catch {
        // 缺 headless shell 时不能报告已安装：browserVisualization 为 false
        // （默认路径）会直接用无头模式启动并失败。
        return {
          installed: false,
          executablePath,
          reason: 'missing',
        }
      }
    }

    return {
      installed: true,
      executablePath,
    }
  }

  /**
   * 推导无头模式所需的 headless shell 可执行文件路径。
   *
   * 优先使用 runtime 显式提供的路径；Playwright 未公开该 API 时，
   * 按官方缓存目录布局推导：`chromium-<rev>` 与 `chromium_headless_shell-<rev>`
   * 位于同一缓存根下且共享版本号，因此可从有头路径替换目录名得到。
   *
   * @returns headless shell 绝对路径；无法推导时返回空字符串（此时跳过该项校验）。
   * @throws 不抛出异常。
   */
  private resolveHeadlessShellPath(): string {
    let explicitPath = ''

    try {
      explicitPath = this.runtime.headlessShellPath?.() ?? ''
    } catch {
      // runtime 未实现或解析失败时退回目录推导。
      explicitPath = ''
    }

    if (explicitPath) {
      return explicitPath
    }

    let executablePath = ''

    try {
      executablePath = this.runtime.executablePath()
    } catch {
      return ''
    }

    return deriveHeadlessShellPath(executablePath)
  }
}

/**
 * 从有头浏览器可执行文件路径推导 headless shell 路径。
 *
 * 目录布局（以 Windows 为例）：
 * ```
 * ms-playwright/chromium-1234/chrome-win64/chrome.exe
 * ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe
 * ```
 * 两种浏览器的版本号一致，因此替换目录名即可定位；平台差异由文件名正则覆盖。
 *
 * @param executablePath - 有头浏览器可执行文件的绝对路径。
 * @returns 推导出的 headless shell 路径；无法识别布局时返回空字符串。
 * @throws 不抛出异常。
 */
function deriveHeadlessShellPath(executablePath: string): string {
  const normalized = executablePath.split('\\').join('/')
  const segments = normalized.split('/')
  // 定位 `chromium-<版本号>` 段；其父目录即浏览器缓存根。
  const revisionIndex = segments.findIndex((segment) =>
    /^chromium-\d+$/.test(segment),
  )

  if (revisionIndex <= 0) {
    return ''
  }

  const revision = segments[revisionIndex]!.slice('chromium-'.length)
  const cacheRoot = segments.slice(0, revisionIndex).join(path.sep)
  const shellRoot = path.join(cacheRoot, `chromium_headless_shell-${revision}`)

  // 平台差异：Windows 用 chrome-headless-shell-win64 目录与 .exe 后缀。
  return process.platform === 'win32'
    ? path.join(
        shellRoot,
        'chrome-headless-shell-win64',
        'chrome-headless-shell.exe',
      )
    : process.platform === 'darwin'
      ? path.join(
          shellRoot,
          'chrome-headless-shell-mac',
          'chrome-headless-shell',
        )
      : path.join(
          shellRoot,
          'chrome-headless-shell-linux64',
          'chrome-headless-shell',
        )
}

/**
 * 将文件访问异常映射为有限的诊断原因。
 *
 * @param error - 文件系统异常。
 * @returns 安装状态原因。
 * @throws 不抛出异常。
 */
function classifyAccessFailure(
  error: unknown,
): 'missing' | 'permission-denied' | 'invalid-path' | 'unknown' {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied'
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
  if (code === 'EINVAL') return 'invalid-path'
  return 'unknown'
}

/**
 * 创建默认检测器。
 *
 * @returns 使用本地 Playwright chromium 的检测器。
 * @throws 不抛出异常。
 */
export function createChromiumDetector(
  options: IChromiumDetectorOptions = {},
): ChromiumDetector {
  return new ChromiumDetector(options)
}

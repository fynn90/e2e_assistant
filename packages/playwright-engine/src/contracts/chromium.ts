/** 定义 Chromium 检测、安装和安装进度的 SDK 契约。 */

/**
 * Chromium 本地运行时状态。
 */
export interface IChromiumStatus {
  installed: boolean
  executablePath: string | null
  version?: string
  reason?: 'missing' | 'permission-denied' | 'invalid-path' | 'unknown'
}

/**
 * Chromium 安装过程中的可观测进度。
 */
export interface IChromiumInstallProgress {
  phase: 'resolving-cli' | 'downloading' | 'extracting' | 'verifying'
  message: string
  completed?: number
  total?: number
}

/**
 * Chromium 安装选项。
 */
export interface IInstallChromiumOptions {
  signal?: AbortSignal
  timeoutMs?: number
  browsersPath?: string
  onProgress?: (event: IChromiumInstallProgress) => void
}

/**
 * Chromium 检测和安装能力。
 */
export interface IChromiumInstaller {
  /**
   * 检测当前 Playwright Chromium 是否可执行。
   *
   * @param options - 可选的浏览器缓存路径提示。
   * @returns 可诊断的 Chromium 状态。
   * @throws 文件系统检测失败时返回未安装状态，而不是泄露原始异常。
   */
  detect(options?: { browsersPath?: string }): Promise<IChromiumStatus>

  /**
   * 使用包内 Playwright CLI 安装 Chromium。
   *
   * @param options - 取消、超时、缓存路径和进度回调。
   * @returns 安装完成后的 Chromium 状态。
   * @throws 安装失败、取消、超时或最终仍不可执行时抛出结构化 Engine 错误。
   */
  install(options?: IInstallChromiumOptions): Promise<IChromiumStatus>
}

/**
 * Chromium 运行时最小适配器，供检测器测试替换。
 *
 * 说明：Playwright 的有头与无头模式使用**不同的可执行文件**——
 * 有头模式用 `chromium.executablePath()`（chrome.exe / headless_shell 之外的完整浏览器），
 * 无头模式用独立的 `chromium_headless_shell`。两者都是 `playwright install chromium`
 * 的下载产物，但缺失其中一个时对应模式会启动失败。
 * 因此检测器需要能取得两者的路径，而不能只检查有头可执行文件。
 */
export interface IChromiumRuntime {
  /** 有头模式使用的 Chromium 可执行文件绝对路径。 */
  executablePath(): string
  /**
   * 无头模式使用的 headless shell 可执行文件绝对路径。
   *
   * 可选：旧版本 Playwright 或替换实现可能不提供该路径，
   * 此时检测器退化为只校验有头可执行文件。
   *
   * @returns headless shell 的绝对路径；不可用时返回空字符串。
   */
  headlessShellPath?(): string
}

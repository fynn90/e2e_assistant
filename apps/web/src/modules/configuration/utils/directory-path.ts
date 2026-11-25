/**
 * 提供目录路径的纯函数工具，兼容 Windows（D:\a\b）与 POSIX（/a/b）两种路径风格。
 *
 * 这些函数只服务于界面展示（面包屑、名称提取），
 * 上级目录跳转一律使用服务端返回的 parentPath，避免自行推导出错。
 */

/** 单个面包屑导航项。 */
export interface IDirectoryBreadcrumb {
  /** 展示文本，例如 'D:'、'users' 或 '/'。 */
  label: string
  /** 点击后可跳转的绝对路径。 */
  path: string
}

/** 路径拆分结果。 */
export interface ISplitDirectoryPath {
  /** 根前缀，例如 'D:\' 或 '/'；相对路径时为 ''。 */
  root: string
  /** 根前缀之后的层级片段。 */
  segments: string[]
}

const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:$/

/**
 * 将目录路径拆分为根前缀与层级片段。
 * @param directoryPath 待拆分的目录路径，允许包含正斜杠或反斜杠。
 * @returns 根前缀与层级片段集合。
 * @throws 不抛出异常，空路径返回空结果。
 */
export function splitDirectoryPath(directoryPath: string): ISplitDirectoryPath {
  const normalizedPath = directoryPath.trim().replace(/\\/g, '/')

  if (!normalizedPath) {
    return { root: '', segments: [] }
  }

  // POSIX 根路径：以单个斜杠开头且没有层级片段。
  if (normalizedPath === '/') {
    return { root: '/', segments: [] }
  }

  const rawSegments = normalizedPath
    .split('/')
    .filter((segment) => segment.length > 0)

  if (normalizedPath.startsWith('/')) {
    // POSIX 绝对路径：根为 '/'，其余片段依次排列。
    return { root: '/', segments: rawSegments }
  }

  const [firstSegment, ...restSegments] = rawSegments

  if (WINDOWS_DRIVE_PATTERN.test(firstSegment)) {
    // Windows 盘符路径：保留盘符为根，输出时统一使用反斜杠。
    return {
      root: `${firstSegment}${separatorForPath(directoryPath)}`,
      segments: restSegments,
    }
  }

  return { root: '', segments: rawSegments }
}

/**
 * 生成面包屑导航项，每项都携带可直接跳转的绝对路径。
 * @param directoryPath 当前目录路径。
 * @returns 面包屑导航项集合；空路径返回空数组。
 * @throws 不抛出异常。
 */
export function buildDirectoryBreadcrumbs(
  directoryPath: string,
): IDirectoryBreadcrumb[] {
  const { root, segments } = splitDirectoryPath(directoryPath)

  if (!root && segments.length === 0) {
    return []
  }

  const breadcrumbs: IDirectoryBreadcrumb[] = []
  let accumulatedPath = root

  if (root) {
    // 根节点本身作为第一个面包屑，保证任何层级都能一键回到盘符或文件系统根。
    breadcrumbs.push({ label: root.replace(/[\\/]+$/, '') || root, path: root })
  }

  for (const segment of segments) {
    accumulatedPath = joinDirectoryPath(accumulatedPath, segment)
    breadcrumbs.push({ label: segment, path: accumulatedPath })
  }

  return breadcrumbs
}

/**
 * 拼接父目录与子目录名，正确处理分隔符与末尾已有分隔符的情况。
 * @param parentPath 父目录路径。
 * @param name 子目录名称。
 * @returns 拼接后的路径。
 * @throws 不抛出异常。
 */
export function joinDirectoryPath(parentPath: string, name: string): string {
  const separator = separatorForPath(parentPath)

  if (!parentPath) {
    return name
  }

  return parentPath.endsWith('/') || parentPath.endsWith('\\')
    ? `${parentPath}${name}`
    : `${parentPath}${separator}${name}`
}

/**
 * 判断路径应使用的分隔符风格。
 * @param directoryPath 参考路径。
 * @returns Windows 路径返回反斜杠，其他情况返回正斜杠。
 * @throws 不抛出异常。
 */
function separatorForPath(directoryPath: string): string {
  return directoryPath.includes('\\') ? '\\' : '/'
}

/**
 * 校验用户输入的目录路径是否为可用于浏览的绝对路径。
 *
 * 与服务端保持一致：拒绝相对路径而不是静默按 CLI 进程工作目录解析，
 * 因为该工作目录取决于用户如何启动 CLI，静默解析会让用户选到意料之外的目录。
 *
 * 路径风格判定与平台无关（同时接受 Windows 与 POSIX 形式），
 * 因为浏览器无法得知 CLI 服务运行在哪个平台上；但盘符简写例外，
 * 它只在 Windows 上有特殊含义，因此需要显式传入平台。
 *
 * @param directoryPath 用户在地址栏输入的目录路径。
 * @param platform 目标平台，默认取当前进程平台；显式传入便于跨平台测试。
 * @returns 校验结果；不合法时包含面向用户的提示文案。
 * @throws 不抛出异常。
 */
export function validateAbsoluteDirectoryPath(
  directoryPath: string,
  platform: NodeJS.Platform = detectClientPlatform(),
): { valid: true } | { valid: false; message: string } {
  const trimmedPath = directoryPath.trim()

  if (!trimmedPath) {
    return { valid: false, message: '请输入目录路径。' }
  }

  // 单独的盘符（如 'D:'）并非绝对路径，但 Windows 用户输入它时意图明确，
  // 服务端会补全为 'D:\'，因此仅在 Windows 上放行。
  // 在 macOS 与 Linux 上冒号是合法文件名字符，'D:' 是普通相对目录名，必须按相对路径拒绝。
  if (platform === 'win32' && /^[A-Za-z]:$/.test(trimmedPath)) {
    return { valid: true }
  }

  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(trimmedPath)
  const isUncPath = /^[\\/]{2}[^\\/]/.test(trimmedPath)
  const isPosixAbsolutePath = trimmedPath.startsWith('/')

  if (!isWindowsAbsolutePath && !isUncPath && !isPosixAbsolutePath) {
    return {
      valid: false,
      message:
        '请输入绝对路径，例如 D:\\workspace 或 /Users/your-name/workspace。',
    }
  }

  return { valid: true }
}

/**
 * 推断浏览器所在平台，用于盘符简写这类与平台强相关的判定。
 *
 * 目录选择器由运行 CLI 服务的同一台机器上的浏览器打开，
 * 因此浏览器平台可代表服务所在平台。
 *
 * @returns 平台标识；无法识别时返回 'linux'（即按 POSIX 规则处理，更为保守）。
 * @throws 不抛出异常。
 */
function detectClientPlatform(): NodeJS.Platform {
  if (typeof navigator === 'undefined') {
    return 'linux'
  }

  // 只用 navigator.platform：它在各浏览器中均可用，
  // 而 navigator.userAgentData 目前仅 Chromium 系支持。
  const platformHint = navigator.platform ?? ''

  if (platformHint.startsWith('Win')) {
    return 'win32'
  }

  if (platformHint.startsWith('Mac')) {
    return 'darwin'
  }

  return 'linux'
}

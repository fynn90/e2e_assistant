/**
 * 提供目录选择器的文件系统浏览能力：逐层列出子目录、解析起始位置、创建新目录。
 *
 * 浏览只向下展开单层，不做递归遍历，因此不存在符号链接循环风险。
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type {
  IDirectoryEntry,
  IDirectoryListing,
} from '@charlie_deng/e2e-assistant-types'
import {
  mapWithConcurrencyLimit,
  withTimeoutRejection,
} from '../shared/async-concurrency'
import { listBrowseRoots, resolveFileSystemRoot } from './browse-roots'
import { DirectoryBrowserError } from '../shared/errors/directory-browser-error'
import {
  isDirectoryWritable,
  probeDirectory,
  resolveDirectoryEntry,
} from './directory-probe'

/** 单次目录浏览返回的子目录数量上限，超出时标记为截断。 */
const MAX_DIRECTORY_ENTRIES = 500

/** 探测子目录空目录状态时的并发上限，避免同时打开过多文件句柄。 */
const ENTRY_PROBE_CONCURRENCY = 8

/** 匹配单独的 Windows 盘符输入，例如 'D:'。 */
const DRIVE_ONLY_PATTERN = /^[A-Za-z]:$/

/** 文件系统访问的超时上限（毫秒），避免已断开的网络盘让请求长时间挂起。 */
const FILE_SYSTEM_TIMEOUT_MS = 15_000

export { listBrowseRoots }

interface IListDirectoryOptions {
  /** 待浏览的目录绝对路径。 */
  directoryPath: string
  /** 子目录数量上限，缺省使用 MAX_DIRECTORY_ENTRIES。 */
  maxEntries?: number
}

/**
 * 列出指定目录下的直接子目录。
 *
 * @param options 待浏览目录与条目上限。
 * @returns 单层目录浏览结果，包含子目录的空目录与可访问性标记。
 * @throws 目录不是绝对路径时抛出 INVALID_REQUEST；
 *         目录不存在时抛出 DIRECTORY_NOT_FOUND；
 *         无权限访问时抛出 DIRECTORY_NOT_ACCESSIBLE；
 *         访问超时（例如已断开的网络盘）时抛出 DIRECTORY_TIMEOUT。
 */
export async function listDirectory (
  options: IListDirectoryOptions,
): Promise<IDirectoryListing> {
  const directoryPath = normalizeDirectoryPath(options.directoryPath)
  const maxEntries = options.maxEntries ?? MAX_DIRECTORY_ENTRIES

  await assertDirectoryAccessible(directoryPath)

  // 读取与探测统一加超时，避免已断开的网络盘（如 \\deadserver\share）挂起到操作系统级超时。
  const [directoryEntries, currentProbe, currentWritable] = await Promise.all([
    readDirectoryEntries(directoryPath),
    probeDirectory(directoryPath),
    isDirectoryWritable(directoryPath),
  ])
  const candidateEntries = directoryEntries
    .filter(
      (directoryEntry) =>
        directoryEntry.isDirectory() || directoryEntry.isSymbolicLink(),
    )
    .sort((leftEntry, rightEntry) =>
      leftEntry.name.localeCompare(rightEntry.name),
    )
  const truncated = candidateEntries.length > maxEntries
  const visibleEntries = truncated
    ? candidateEntries.slice(0, maxEntries)
    : candidateEntries

  // 并发解析条目，符号链接与真实目录在这一步统一判定为目录或忽略。
  const resolvedEntries = await mapWithConcurrencyLimit(
    visibleEntries,
    ENTRY_PROBE_CONCURRENCY,
    (directoryEntry) =>
      resolveDirectoryEntry({
        parentDirectory: directoryPath,
        entryName: directoryEntry.name,
        isSymbolicLink: directoryEntry.isSymbolicLink(),
      }),
  )
  const directories = resolvedEntries.filter(
    (directoryEntry): directoryEntry is IDirectoryEntry =>
      directoryEntry !== null,
  )

  return {
    currentPath: directoryPath,
    parentPath: resolveParentDirectoryPath(directoryPath),
    rootPath: resolveFileSystemRoot(directoryPath),
    directories,
    truncated,
    currentEmpty: currentProbe.empty,
    currentWritable,
  }
}

/**
 * 在指定父目录下创建子目录。
 *
 * @param options 父目录绝对路径与新建目录名称。
 * @returns 新建目录的绝对路径。
 * @throws 名称为空、包含路径分隔符或父目录不是绝对路径时抛出 INVALID_REQUEST；
 *         目录已存在时抛出 DIRECTORY_ALREADY_EXISTS；
 *         父目录不可访问或无权限时抛出 DIRECTORY_NOT_ACCESSIBLE；
 *         父目录访问超时（例如已断开的网络盘）时抛出 DIRECTORY_TIMEOUT。
 */
export async function createDirectory (options: {
  parentPath: string
  name: string
}): Promise<{ absolutePath: string }> {
  const parentPath = normalizeDirectoryPath(options.parentPath)
  const directoryName = options.name.trim()

  if (!directoryName) {
    throw new DirectoryBrowserError('INVALID_REQUEST', '请输入新目录名称。')
  }

  if (
    directoryName === '.' ||
    directoryName === '..' ||
    /[\\/]/.test(directoryName)
  ) {
    throw new DirectoryBrowserError(
      'INVALID_REQUEST',
      '新目录名称不能包含路径分隔符。',
    )
  }

  await assertDirectoryAccessible(parentPath)

  const absolutePath = path.join(parentPath, directoryName)

  try {
    // 与读取一致地施加超时：父目录位于已断开的网络位置时 mkdir 同样会长时间挂起。
    await withTimeoutRejection(
      mkdir(absolutePath),
      FILE_SYSTEM_TIMEOUT_MS,
      () => createFileSystemTimeoutError(),
    )
  } catch (error) {
    if (error instanceof DirectoryBrowserError) {
      throw error
    }

    if (isFileSystemErrorCode(error, 'EEXIST')) {
      throw new DirectoryBrowserError(
        'DIRECTORY_ALREADY_EXISTS',
        '该目录已存在，请换一个名称。',
      )
    }

    if (
      isFileSystemErrorCode(error, 'EACCES') ||
      isFileSystemErrorCode(error, 'EPERM')
    ) {
      throw new DirectoryBrowserError(
        'DIRECTORY_NOT_ACCESSIBLE',
        '父目录没有写入权限。',
      )
    }

    throw new DirectoryBrowserError(
      'DIRECTORY_NOT_ACCESSIBLE',
      '创建目录失败，请检查父目录权限。',
    )
  }

  return { absolutePath }
}

/**
 * 解析目录的上一级目录。
 *
 * 路径已经是文件系统根（如 D:\ 或 /）时返回 null，供前端禁用「上一级」。
 *
 * @param directoryPath 已规范化的目录绝对路径。
 * @returns 上一级目录绝对路径；已是根目录时返回 null。
 * @throws 不抛出异常。
 */
function resolveParentDirectoryPath (directoryPath: string): string | null {
  const parentPath = path.dirname(directoryPath)

  // path.dirname 在文件系统根会返回其自身（POSIX 的 '/'、Windows 的 'D:\' 以及 UNC 共享根均如此），
  // 据此判定已经到达文件系统根，供前端禁用「上一级」。
  return parentPath === directoryPath ? null : parentPath
}

/**
 * 读取目录条目，并对可能长时间无响应的网络路径施加超时。
 *
 * @param directoryPath 已规范化的目录绝对路径。
 * @returns 目录项集合。
 * @throws 超过超时上限时抛出 DIRECTORY_TIMEOUT。
 */
function readDirectoryEntries (directoryPath: string): Promise<Dirent[]> {
  return withTimeoutRejection(
    readdir(directoryPath, { withFileTypes: true }),
    FILE_SYSTEM_TIMEOUT_MS,
    () => createFileSystemTimeoutError(),
  )
}

/**
 * 构造文件系统访问超时错误。
 *
 * @returns 提示目录响应超时的领域错误。
 * @throws 不抛出异常，仅返回错误实例。
 */
function createFileSystemTimeoutError (): DirectoryBrowserError {
  return new DirectoryBrowserError(
    'DIRECTORY_TIMEOUT',
    '访问该目录超时，它可能位于已断开的网络位置。请检查网络连接后重试。',
  )
}

/**
 * 校验目录存在且可访问。
 *
 * @param directoryPath 已规范化的目录绝对路径。
 * @returns 校验通过时无返回值。
 * @throws 目录不存在时抛出 DIRECTORY_NOT_FOUND；
 *         路径指向文件或无权限访问时抛出 DIRECTORY_NOT_ACCESSIBLE。
 */
async function assertDirectoryAccessible (directoryPath: string): Promise<void> {
  let directoryStats: Awaited<ReturnType<typeof stat>>

  try {
    directoryStats = await withTimeoutRejection(
      stat(directoryPath),
      FILE_SYSTEM_TIMEOUT_MS,
      () => createFileSystemTimeoutError(),
    )
  } catch (error) {
    if (error instanceof DirectoryBrowserError) {
      throw error
    }

    if (isFileSystemErrorCode(error, 'ENOENT')) {
      throw new DirectoryBrowserError('DIRECTORY_NOT_FOUND', '目录不存在。')
    }

    if (
      isFileSystemErrorCode(error, 'EACCES') ||
      isFileSystemErrorCode(error, 'EPERM')
    ) {
      throw new DirectoryBrowserError(
        'DIRECTORY_NOT_ACCESSIBLE',
        '没有权限访问该目录。',
      )
    }

    // 已断开的网络盘在本机会返回不带标准错误码的 UNKNOWN，
    // 因此兜底文案需要覆盖「网络位置不可达」这一常见原因。
    throw new DirectoryBrowserError(
      'DIRECTORY_NOT_ACCESSIBLE',
      '无法访问该目录，它可能位于已断开的网络位置。请检查路径与网络连接。',
    )
  }

  if (!directoryStats.isDirectory()) {
    throw new DirectoryBrowserError(
      'DIRECTORY_NOT_ACCESSIBLE',
      '该路径不是目录。',
    )
  }

  const probeResult = await probeDirectory(directoryPath)

  if (!probeResult.accessible) {
    throw new DirectoryBrowserError(
      'DIRECTORY_NOT_ACCESSIBLE',
      '没有权限访问该目录。',
    )
  }
}

/**
 * 将用户输入路径规范化为绝对路径。
 *
 * 只接受绝对路径。相对路径会被明确拒绝，而不是静默地以 CLI 进程工作目录为基准解析：
 * 该工作目录取决于用户如何启动 CLI（桌面快捷方式、任意目录下的命令），
 * 用户无从预期，静默解析会让他选到意料之外的目录并可能真的把项目建在那里。
 *
 * @param directoryPath 用户输入的目录路径。
 * @returns 规范化后的绝对路径。
 * @throws 路径为空时抛出 INVALID_REQUEST；
 *         路径不是绝对路径时抛出 INVALID_REQUEST 并提示需要绝对路径。
 */
function normalizeDirectoryPath (directoryPath: string): string {
  const trimmedPath = directoryPath.trim()

  if (!trimmedPath) {
    throw new DirectoryBrowserError('INVALID_REQUEST', '目录路径不能为空。')
  }

  // 盘符简写先于绝对路径校验处理：'D:' 本身不是绝对路径，但用户意图明确。
  const driveShortcutPath = resolveWindowsDriveShortcut(trimmedPath)

  if (driveShortcutPath) {
    return path.resolve(driveShortcutPath)
  }

  if (!path.isAbsolute(trimmedPath)) {
    throw new DirectoryBrowserError(
      'INVALID_REQUEST',
      '请输入绝对路径，例如 D:\\workspace 或 /Users/your-name/workspace。',
    )
  }

  return path.resolve(trimmedPath)
}

/**
 * 将 Windows 盘符简写（如 'D:'）解析为盘符根目录（如 'D:\'）。
 *
 * 该简写只在 Windows 上成立：单独的盘符是「盘符相对路径」，
 * path.resolve 的结果取决于该盘符是否为进程当前盘（当前盘会解析到进程工作目录），
 * 与用户「进入 D 盘根目录」的意图不符，因此显式补全。
 *
 * 在 macOS 与 Linux 上必须返回 null：那里冒号是合法的文件名字符，
 * 'D:' 是一个普通的相对目录名，补全成 'D:/' 会被 path.resolve 静默解析到进程工作目录下。
 *
 * @param input 已去除首尾空白的用户输入。
 * @param platform 目标平台，默认取当前进程平台；显式传入便于跨平台测试。
 * @returns 盘符根目录路径；输入不是 Windows 盘符简写时返回 null。
 * @throws 不抛出异常。
 */
export function resolveWindowsDriveShortcut (
  input: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32' || !DRIVE_ONLY_PATTERN.test(input)) {
    return null
  }

  return `${input}\\`
}

/**
 * 判断异常是否带有指定的文件系统错误码。
 *
 * @param error 待判断的未知异常。
 * @param expectedCode 期望的文件系统错误码，例如 'ENOENT'。
 * @returns 错误码匹配时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
function isFileSystemErrorCode (error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === expectedCode
  )
}

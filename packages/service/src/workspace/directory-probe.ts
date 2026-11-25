/**
 * 提供目录浏览所需的单目录探测能力：判断目录是否为空、是否可访问。
 */
import { constants as fsConstants } from 'node:fs'
import { access, opendir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { IDirectoryEntry } from '@fynn90-e2e_assistant/types'

/**
 * 判定目录是否为空时需要忽略的系统文件。
 *
 * 与配置写入路径的判定保持一致，避免 macOS 上"看似为空的目录"被误判为非空。
 */
export const IGNORED_DIRECTORY_ENTRY_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

/** 单个目录探测结果。 */
export interface IDirectoryProbeResult {
  /** 是否为空目录（忽略系统文件）。 */
  empty: boolean
  /** 是否可读取。 */
  accessible: boolean
}

/**
 * 探测目录是否为空以及是否可读取。
 *
 * 使用 opendir 逐个读取条目并在得出结论后立即停止，
 * 避免对 node_modules 这类超大目录执行完整 readdir 而产生大量无谓内存分配。
 *
 * @param directoryPath 待探测的目录绝对路径。
 * @returns 空目录与可访问性标记；不可访问时 empty 记为 false。
 * @throws 不抛出异常，探测失败会转换为 inaccessible 结果。
 */
export async function probeDirectory (
  directoryPath: string,
): Promise<IDirectoryProbeResult> {
  let directoryHandle: Awaited<ReturnType<typeof opendir>> | undefined

  try {
    directoryHandle = await opendir(directoryPath)

    // 逐个读取条目，遇到第一个有效条目即可确认目录非空，无需读完整个目录。
    while (true) {
      const directoryEntry = await directoryHandle.read()

      if (!directoryEntry) {
        return { empty: true, accessible: true }
      }

      if (!IGNORED_DIRECTORY_ENTRY_NAMES.has(directoryEntry.name)) {
        return { empty: false, accessible: true }
      }
    }
  } catch {
    return { empty: false, accessible: false }
  } finally {
    // 显式关闭句柄，避免在提前 return 时泄漏文件描述符。
    await directoryHandle?.close().catch(() => undefined)
  }
}

/**
 * 将目录条目解析为目录选择器可用的子目录项，非目录条目返回 null。
 *
 * 符号链接需要额外 stat 判定，因为 dirent.isDirectory() 对链接始终返回 false。
 *
 * @param options 条目所在目录与目录项信息。
 * @returns 子目录条目；条目为文件、链接失效或不可访问时返回 null。
 * @throws 不抛出异常，无法解析的条目会被忽略。
 */
export async function resolveDirectoryEntry (options: {
  parentDirectory: string
  entryName: string
  isSymbolicLink: boolean
}): Promise<IDirectoryEntry | null> {
  const absolutePath = path.join(options.parentDirectory, options.entryName)
  let stats: Awaited<ReturnType<typeof stat>>

  try {
    // stat 会跟随符号链接，因此链接与真实目录在此统一判定。
    stats = await stat(absolutePath)
  } catch {
    // 失效链接或无权限访问的条目直接跳过，不打断整个目录列表。
    return null
  }

  if (!stats.isDirectory()) {
    return null
  }

  const probeResult = await probeDirectory(absolutePath)

  return {
    name: options.entryName,
    absolutePath,
    empty: probeResult.empty,
    accessible: probeResult.accessible,
    symbolicLink: options.isSymbolicLink,
  }
}

/**
 * 判断目录当前是否可写。
 *
 * @param directoryPath 待检查的目录绝对路径。
 * @returns 可写时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
export async function isDirectoryWritable (
  directoryPath: string,
): Promise<boolean> {
  try {
    await access(directoryPath, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

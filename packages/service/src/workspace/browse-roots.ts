/**
 * 提供目录浏览起始位置的解析能力，处理 Windows 多盘符与其他平台家目录的差异。
 */
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withTimeout } from '../shared/async-concurrency'

/** 探测单个盘符是否可用时的超时时间（毫秒）。 */
const DRIVE_PROBE_TIMEOUT_MS = 1500

/**
 * 返回目录选择器可用的起始位置集合。
 *
 * Windows 下枚举所有可访问的盘符（例如 D:\），其他平台返回当前用户家目录。
 *
 * @returns 起始目录绝对路径集合；全部探测失败时返回当前工作目录兜底。
 * @throws 不抛出异常。
 */
export async function listBrowseRoots(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [os.homedir()]
  }

  const driveRoots = await listWindowsDriveRoots()

  return driveRoots.length > 0 ? driveRoots : [os.homedir()]
}

/**
 * 枚举 Windows 下可访问的盘符根目录。
 *
 * 通过并行探测 A:\ 至 Z:\ 是否存在实现，不依赖已被 Windows 11 移除的 wmic 命令。
 * 每个探测都带有超时保护，避免已断开的网络映射盘导致请求长时间挂起。
 *
 * @returns 可用盘符根目录集合，例如 ['C:\\', 'D:\\']。
 * @throws 不抛出异常，不可用或超时的盘符会被忽略。
 */
async function listWindowsDriveRoots(): Promise<string[]> {
  const driveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  const driveProbes = driveLetters.map(async (driveLetter) => {
    const driveRoot = `${driveLetter}:\\`
    const probeResult = await withTimeout(
      probeDriveRoot(driveRoot),
      DRIVE_PROBE_TIMEOUT_MS,
      false,
    )

    return probeResult ? driveRoot : null
  })
  const probeResults = await Promise.all(driveProbes)

  return probeResults.filter(
    (driveRoot): driveRoot is string => driveRoot !== null,
  )
}

/**
 * 探测单个盘符根目录是否存在且可访问。
 *
 * @param driveRoot 盘符根目录，例如 'D:\\'。
 * @returns 盘符可用时返回 true，否则返回 false。
 * @throws 不抛出异常。
 */
async function probeDriveRoot(driveRoot: string): Promise<boolean> {
  try {
    const driveStats = await stat(driveRoot)
    return driveStats.isDirectory()
  } catch {
    return false
  }
}

/**
 * 返回路径所在的文件系统根目录。
 *
 * Windows 下需要保留盘符前缀，不能直接使用 path.parse().root 之外的推断逻辑。
 *
 * @param directoryPath 任意目录路径。
 * @returns 该路径对应的根目录，例如 'D:\\' 或 '/'。
 * @throws 不抛出异常。
 */
export function resolveFileSystemRoot(directoryPath: string): string {
  return path.parse(path.resolve(directoryPath)).root
}

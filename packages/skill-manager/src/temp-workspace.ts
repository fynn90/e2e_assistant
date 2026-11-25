/**
 * Skill 的 `temp/` 临时工作区：**Agent 工作期间产生的全部中间内容的唯一落盘位置**。
 *
 * 装什么（v12-pre 重定义）：凡是 Agent 为完成任务而产生、对用户没有价值、
 * 且只在任务期间供 Agent 自己负责到底的内容，都放这里——
 *   - `candidate.spec.ts`：生成的候选脚本（Agent 通过 write 工具写入）；
 *   - `exploration/<sessionId>/*.png`：探查阶段截取的页面截图（见 exploration-artifact.ts），
 *     它同时是「让用户在生成过程中看到 Agent 核对质量」的展示载体。
 * 与之相对，**需要跨会话为用户保留**的内容不属于 temp/，应放 baselines/ 这类正式产物目录。
 *
 * 产品边界（PRD 4.4 / 9.5 / AC-05）：
 *   - temp/ 不属于正式 Skill 产物，不展示在文件树中，用户不直接把它当作可维护脚本；
 *   - 生成、试运行、取消、失败和清理都不得修改 e2e_schema.json、SKILL.md、
 *     已有正式脚本或 Skill 目录外的任何文件；
 *   - 任务结束（完成、失败、取消）必须清理整个 temp/——探查截图也随之删除，
 *     这是既定行为（截图的价值在生成过程中，不在生成之后）；
 *   - 异常中断遗留的 temp/ 必须在下次生成任务启动前清理。
 *
 * 实现要点：
 *   - 所有写入都通过 resolveSafeTempPath 做逃逸校验，禁止 `..`、绝对路径与符号链接；
 *   - 清理采用「先尽力删除，失败后重试」策略应对 Windows 文件占用（EBUSY/EPERM）；
 *   - 清理失败向上抛出，绝不伪报成功（PRD 4.4 末条）。
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TEMP_DIRECTORY_NAME } from './constants'
import { isFileSystemPermissionError, SkillManagerError } from './errors'

/** Windows 下浏览器/子进程释放文件可能滞后，清理失败时按此节奏重试。 */
const DEFAULT_CLEANUP_RETRY_DELAYS_MS = [50, 150, 400] as const

/** 单个临时文件的字节上限，避免把超大内容写入 Skill 目录。 */
const MAX_TEMP_FILE_BYTES = 1024 * 1024

/** 临时工作区操作选项。 */
export interface ITempWorkspaceOptions {
  /** 已由 Skill Manager 解析的 Skill 目录绝对路径。 */
  skillRoot: string
  /** 清理重试间隔（毫秒）；测试可注入以加快失败路径验证。 */
  cleanupRetryDelaysMs?: readonly number[]
}

/** 已创建的临时工作区句柄。 */
export interface ITempWorkspace {
  /** 临时工作区绝对路径（`<skillRoot>/temp`）。 */
  readonly directory: string
  /**
   * 将候选文件写入临时工作区。
   *
   * @param relativePath - temp/ 下的相对路径，例如 `candidate.spec.ts`。
   * @param content - 文件内容。
   * @returns 写入完成后的绝对路径。
   * @throws SkillManagerError 路径非法、内容超限或写入失败时抛出。
   */
  writeFile(relativePath: string, content: string): Promise<string>
  /**
   * 清理整个临时工作区。
   *
   * @returns 清理完成；目录不存在时安全无操作。
   * @throws SkillManagerError 目录仍被占用或权限不足导致清理失败时抛出。
   */
  cleanup(): Promise<void>
}

/**
 * 解析并创建当前 Skill 的临时工作区。
 *
 * 创建前先清理上次任务可能遗留的 temp/，满足 PRD 4.4「遗留下次任务启动前清理」。
 *
 * @param options - Skill 目录与可选的重试节奏。
 * @returns 可写入与清理的临时工作区句柄。
 * @throws SkillManagerError 目录不可写或存在无法清理的遗留内容时抛出。
 */
export async function createTempWorkspace(
  options: ITempWorkspaceOptions,
): Promise<ITempWorkspace> {
  const directory = resolveTempDirectory(options.skillRoot)

  // 先清理遗留：上一轮任务异常中断时 temp/ 可能残留，直接复用会污染本次生成。
  await removeDirectoryWithRetry(directory, options.cleanupRetryDelaysMs)

  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    if (isFileSystemPermissionError(error)) {
      throw new SkillManagerError(
        'SKILL_PERMISSION_DENIED',
        '当前 Skill 目录不可写，无法创建临时工作区。',
        error,
      )
    }

    throw new SkillManagerError(
      'SKILL_CORRUPTED',
      '无法创建 Skill 的临时工作区。',
      error,
    )
  }

  return {
    directory,

    async writeFile(relativePath: string, content: string): Promise<string> {
      const targetPath = resolveSafeTempFilePath(directory, relativePath)

      if (Buffer.byteLength(content, 'utf-8') > MAX_TEMP_FILE_BYTES) {
        throw new SkillManagerError(
          'FILE_TOO_LARGE',
          '临时文件超过允许的大小上限。',
        )
      }

      try {
        // 目标文件的父目录可能尚未创建（例如 temp/artifacts/ 这类子目录）。
        await mkdir(path.dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content, 'utf-8')
      } catch (error) {
        if (isFileSystemPermissionError(error)) {
          throw new SkillManagerError(
            'FILE_PERMISSION_DENIED',
            '没有权限写入临时工作区。',
            error,
          )
        }

        throw new SkillManagerError(
          'SKILL_CORRUPTED',
          '写入临时文件失败。',
          error,
        )
      }

      return targetPath
    },

    async cleanup(): Promise<void> {
      await removeDirectoryWithRetry(directory, options.cleanupRetryDelaysMs)
    },
  }
}

/**
 * 清理指定 Skill 的临时工作区（不创建）。
 *
 * 供任务终态与启动前的兜底清理使用。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param retryDelaysMs - 可选的重试节奏。
 * @returns 清理完成；目录不存在时安全无操作。
 * @throws SkillManagerError 清理失败时抛出，调用方不得伪报成功。
 */
export async function cleanupTempWorkspace(
  skillRoot: string,
  retryDelaysMs?: readonly number[],
): Promise<void> {
  await removeDirectoryWithRetry(resolveTempDirectory(skillRoot), retryDelaysMs)
}

/**
 * 解析 Skill 的临时目录绝对路径。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns `<skillRoot>/temp` 的绝对路径。
 * @throws 不抛出异常。
 */
export function resolveTempDirectory(skillRoot: string): string {
  return path.join(skillRoot, TEMP_DIRECTORY_NAME)
}

/**
 * 校验临时文件的相对路径并解析为绝对路径。
 *
 * @param tempDirectory - 临时工作区绝对路径。
 * @param relativePath - 调用方给出的相对路径。
 * @returns 位于临时工作区内的绝对路径。
 * @throws SkillManagerError 路径为空、绝对、含 `..` 或逃逸出临时工作区时抛出。
 */
function resolveSafeTempFilePath(
  tempDirectory: string,
  relativePath: string,
): string {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    relativePath.includes('\0')
  ) {
    throw new SkillManagerError('INVALID_FILE_PATH', '临时文件路径不合法。')
  }

  // 禁止绝对路径与 Windows 盘符：临时文件必须相对 temp/ 指定。
  if (
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new SkillManagerError(
      'INVALID_FILE_PATH',
      '临时文件路径不能是绝对路径。',
    )
  }

  const normalized = relativePath.split('\\').join('/')
  const segments = normalized.split('/')

  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new SkillManagerError('INVALID_FILE_PATH', '临时文件路径不合法。')
  }

  const targetPath = path.resolve(tempDirectory, ...segments)
  const relativeFromTemp = path.relative(tempDirectory, targetPath)

  // 双保险：即使前面的校验被绕过，也不允许写出 temp/ 之外。
  if (
    !relativeFromTemp ||
    relativeFromTemp.startsWith('..') ||
    path.isAbsolute(relativeFromTemp)
  ) {
    throw new SkillManagerError('INVALID_FILE_PATH', '临时文件路径越界。')
  }

  return targetPath
}

/**
 * 删除目录，并在 Windows 文件占用（EBUSY/EPERM）时按节奏重试。
 *
 * 目录不存在视为成功，保证多次调用幂等。
 *
 * @param directory - 待删除目录绝对路径。
 * @param retryDelaysMs - 重试间隔；缺省使用 Windows 友好的递增等待。
 * @returns 删除完成。
 * @throws SkillManagerError 重试后仍失败时抛出；调用方不得据此认为任务成功。
 */
async function removeDirectoryWithRetry(
  directory: string,
  retryDelaysMs: readonly number[] = DEFAULT_CLEANUP_RETRY_DELAYS_MS,
): Promise<void> {
  if (!(await directoryExists(directory))) {
    return
  }

  let lastError: unknown

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error

      // 目录可能已在上一轮被并发清理；此时按成功处理。
      if (!(await directoryExists(directory))) {
        return
      }

      const delay = retryDelaysMs[attempt]
      if (delay !== undefined) {
        await sleep(delay)
      }
    }
  }

  throw new SkillManagerError(
    'SKILL_PERMISSION_DENIED',
    '临时工作区仍被浏览器或运行中的任务占用，未能清理。请停止生成任务后重试。',
    lastError,
  )
}

/**
 * 判断路径是否为可访问的目录。
 *
 * @param targetPath - 待检查的绝对路径。
 * @returns 目录存在且可访问时为 true；不存在或不可访问时为 false。
 * @throws 不抛出异常。
 */
async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch {
    return false
  }
}

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 列出临时工作区内的文件名（不含子目录递归），用于测试与诊断。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 临时目录下的条目名称；目录不存在时返回空数组。
 * @throws 不抛出异常。
 */
export async function listTempWorkspaceEntries(
  skillRoot: string,
): Promise<string[]> {
  try {
    return await readdir(resolveTempDirectory(skillRoot))
  } catch {
    return []
  }
}

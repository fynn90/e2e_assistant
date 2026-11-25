import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { MAX_RELATIVE_PATH_LENGTH, SKILL_MANIFEST_FILE_NAME } from './constants'
import {
  isFileSystemMissingError,
  isFileSystemPermissionError,
  SkillManagerError,
} from './errors'

export interface IResolvedSkillFilePath {
  absolutePath: string
  realPath: string
  relativePath: string
  isManifest: boolean
  stat: Awaited<ReturnType<typeof lstat>>
}

export async function resolveSafeSkillFilePath(
  skillRoot: string,
  relativePath: string,
): Promise<IResolvedSkillFilePath> {
  return resolveSafeSkillPath(skillRoot, relativePath, 'file-only')
}

/**
 * 解析 Skill 内路径，允许目标为目录（v13，供删除入口使用）。
 *
 * 与 {@link resolveSafeSkillFilePath} 共用同一套防护（逐段符号链接检测、
 * 归一化前缀校验、realpath 二次校验），唯一差异是**不限制目标必须是普通文件**——
 * 删除目录是合法操作，而只读文件通道只应处理文件。
 *
 * 目标为符号链接时仍然拒绝：删除符号链接会作用到其指向的真实目标，可能越出 Skill 目录。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param relativePath - Skill 内相对路径。
 * @returns 解析结果；`stat` 可能是文件或目录。
 * @throws {SkillManagerError} 路径非法（INVALID_FILE_PATH）、不存在（FILE_NOT_FOUND）
 *   或无权限（FILE_PERMISSION_DENIED）时抛出。
 */
export async function resolveSafeSkillEntryPath(
  skillRoot: string,
  relativePath: string,
): Promise<IResolvedSkillFilePath> {
  return resolveSafeSkillPath(skillRoot, relativePath, 'file-or-directory')
}

/**
 * 解析 Skill 内路径的共用实现。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param relativePath - Skill 内相对路径。
 * @param targetKind - `file-only` 时要求目标是普通文件，否则只要求不是符号链接。
 * @returns 解析结果。
 * @throws {SkillManagerError} 校验不通过时抛出。
 */
async function resolveSafeSkillPath(
  skillRoot: string,
  relativePath: string,
  targetKind: 'file-only' | 'file-or-directory',
): Promise<IResolvedSkillFilePath> {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const realSkillRoot = await realpath(skillRoot)
  const absolutePath = path.resolve(
    skillRoot,
    ...normalizedRelativePath.split('/'),
  )
  const relativeFromRoot = path.relative(skillRoot, absolutePath)

  if (
    relativeFromRoot.startsWith('..') ||
    path.isAbsolute(relativeFromRoot) ||
    relativeFromRoot === ''
  ) {
    throw invalidPathError()
  }

  let currentPath = skillRoot

  try {
    for (const segment of normalizedRelativePath.split('/')) {
      currentPath = path.join(currentPath, segment)
      const segmentStat = await lstat(currentPath)

      if (segmentStat.isSymbolicLink()) {
        throw invalidPathError()
      }
    }

    const targetStat = await lstat(absolutePath)

    if (targetKind === 'file-only') {
      // 文件通道的原始语义保持不变（含错误码）：目标必须是普通文件，
      // 符号链接与目录同样按「非普通文件」处理。
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new SkillManagerError(
          'FILE_NOT_SUPPORTED',
          '只允许访问普通文件。',
        )
      }
    } else if (targetStat.isSymbolicLink()) {
      // 删除等入口允许目录，但符号链接一律拒绝：删除链接会作用到其指向的
      // 真实目标，可能越出 Skill 目录。
      throw invalidPathError()
    }

    const targetRealPath = await realpath(absolutePath)

    if (!isPathInside(realSkillRoot, targetRealPath)) {
      throw invalidPathError()
    }

    const canonicalRelativePath = path
      .relative(realSkillRoot, targetRealPath)
      .split(path.sep)
      .join('/')
    const isManifest =
      canonicalRelativePath.toLocaleLowerCase('en-US') ===
      SKILL_MANIFEST_FILE_NAME.toLocaleLowerCase('en-US')

    return {
      absolutePath,
      realPath: targetRealPath,
      relativePath: normalizedRelativePath,
      isManifest,
      stat: targetStat,
    }
  } catch (error) {
    if (error instanceof SkillManagerError) {
      throw error
    }

    if (isFileSystemMissingError(error)) {
      throw new SkillManagerError('FILE_NOT_FOUND', '文件不存在。', error)
    }

    if (isFileSystemPermissionError(error)) {
      throw new SkillManagerError(
        'FILE_PERMISSION_DENIED',
        '没有权限访问该文件。',
        error,
      )
    }

    throw error
  }
}

export function normalizeRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string') {
    throw invalidPathError()
  }

  const inputPath = relativePath

  if (
    !inputPath ||
    inputPath.length > MAX_RELATIVE_PATH_LENGTH ||
    inputPath.includes('\0')
  ) {
    throw invalidPathError()
  }

  if (
    path.posix.isAbsolute(inputPath) ||
    path.win32.isAbsolute(inputPath) ||
    /^[a-zA-Z]:/.test(inputPath) ||
    /^\\\\[?.]\\/.test(inputPath) ||
    inputPath.startsWith('\\\\') ||
    inputPath.includes('\\')
  ) {
    throw invalidPathError()
  }

  if (/%(?:2e|2f|5c|00)/i.test(inputPath)) {
    throw invalidPathError()
  }

  const segments = inputPath.split('/')

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.includes('\0'),
    )
  ) {
    throw invalidPathError()
  }

  return segments.join('/')
}

function invalidPathError(): SkillManagerError {
  return new SkillManagerError('INVALID_FILE_PATH', '文件路径不合法。')
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

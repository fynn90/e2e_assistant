/**
 * userWorkSpace 内的文件与目录创建（v14 D1/W14，技术方案 §4.5）。
 *
 * 安全设计（与 file-delete 同源的分层边界）：
 *   - **请求体只带 userWorkSpace 内相对路径**，根由服务端拼接——不存在
 *     「前端指定根」的攻击面（B4：用户不能在 userWorkSpace 外创建）；
 *   - 路径先经 types 共享的 `normalizeUserWorkspaceRelativePath`（D2 归一化：
 *     拒绝绝对路径/盘符/UNC/反斜杠/空字节/`..`/URL 编码绕过），再逐段确认
 *     「不存在，或已是普通目录」后才创建——`mkdir recursive` 不检查中间
 *     符号链接，必须手动逐段把关；
 *   - 文件用 `open(..., 'wx')` 原子创建（已存在即失败，不覆盖），
 *     内容写走 `writeFileAtomic`（0o600 + fsync），与平台既有原子写一致；
 *   - 限制沿用文件树口径：深度 ≤ MAX_SKILL_TREE_DEPTH（20）、
 *     大小 ≤ MAX_SKILL_FILE_BYTES（1MB）、扩展名不得属 KNOWN_BINARY_EXTENSIONS
 *     （二进制产物由捕获工具/脚本产生，不走文本创建入口）。
 *
 * 立约（W13）：平台没有重命名/移动 API；今后新增任何此类 API 时，
 * 必须把 userWorkSpace 根目录列入禁改清单。
 */

import { lstat, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { normalizeUserWorkspaceRelativePath } from '@fynn90-e2e_assistant/types'
import {
  KNOWN_BINARY_EXTENSIONS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TREE_DEPTH,
  USER_WORKSPACE_DIRECTORY_NAME,
} from './constants'
import { resolveSkill } from './detail'
import { SkillManagerError } from './errors'
import { hashBytes } from './file-content'
import type { ISkillStorageOptions } from './storage'

/**
 * 在 userWorkSpace 内创建子目录（可多级，W46：在所指定的父目录之下创建）。
 *
 * @param options - Skill 存储根目录（`rootDir`）。
 * @param skillId - 九位 Skill ID。
 * @param relativePath - userWorkSpace 内相对路径（不含 userWorkSpace 前缀，由本模块拼接根；
 *   允许带一次前导 `userWorkSpace` 段，按 D2 规则剥离）。
 * @returns 创建后的 Skill 内完整相对路径（userWorkSpace/<path>）。
 * @throws SkillManagerError 路径非法或越界（INVALID_FILE_PATH）、超过深度上限
 *   （TREE_TOO_LARGE）、中间段被文件或符号链接占用（INVALID_FILE_PATH）、
 *   已存在（DIRECTORY_ALREADY_EXISTS）或权限不足（FILE_PERMISSION_DENIED）时抛出。
 */
export async function createUserWorkspaceDirectory (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
): Promise<{ relativePath: string }> {
  const segments = normalizeWorkspaceSegments(relativePath)
  const resolvedSkill = await resolveSkill(options, skillId)
  const workspaceRoot = path.join(
    resolvedSkill.skillRoot,
    USER_WORKSPACE_DIRECTORY_NAME,
  )

  // 中间段逐段确认并创建缺失段：每一段只允许「不存在（创建），或已是普通目录
  // （通过）」；符号链接与文件占位一律拒绝（mkdir recursive 不检查中间符号链接，
  // 必须手动逐段把关后再逐段创建）。
  let currentPath = workspaceRoot
  for (const segment of segments.slice(0, -1)) {
    currentPath = path.join(currentPath, segment)
    await ensureSegmentAcceptableForDirectory(currentPath, segment)
  }

  // 最后一段（目标目录自身）必须不存在：创建语义不覆盖已有目录或文件。
  const targetPath = path.join(currentPath, segments[segments.length - 1])
  const finalStat = await lstat(targetPath).catch(() => undefined)
  if (finalStat) {
    throw new SkillManagerError(
      'DIRECTORY_ALREADY_EXISTS',
      '目标目录已存在；如需重建请先删除。',
    )
  }

  try {
    await mkdir(targetPath, { recursive: false })
  } catch (error) {
    throw translateCreateError(error, targetPath)
  }

  return {
    relativePath: [USER_WORKSPACE_DIRECTORY_NAME, ...segments].join('/'),
  }
}

/**
 * 在 userWorkSpace 内创建文本文件（不覆盖已有文件，R10：创建空文件由调用方传空内容）。
 *
 * @param options - Skill 存储根目录（`rootDir`）。
 * @param skillId - 九位 Skill ID。
 * @param relativePath - userWorkSpace 内相对路径；父目录不存在时自动创建（逐段安全检查）。
 * @param content - 文件初始文本内容。
 * @returns 创建后的完整相对路径、内容版本（sha-256）与字节数。
 * @throws SkillManagerError 路径非法或越界（INVALID_FILE_PATH）、内容超限（FILE_TOO_LARGE）、
 *   二进制扩展名（FILE_NOT_SUPPORTED）、文件已存在（FILE_ALREADY_EXISTS）、
 *   中间段被文件或符号链接占用（INVALID_FILE_PATH）或权限不足（FILE_PERMISSION_DENIED）时抛出。
 */
export async function createUserWorkspaceFile (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
  content: string,
): Promise<{ relativePath: string; version: string; size: number }> {
  const segments = normalizeWorkspaceSegments(relativePath)

  if (segments.length === 0) {
    throw new SkillManagerError('INVALID_FILE_PATH', '文件路径不合法。')
  }

  const fileName = segments[segments.length - 1]
  const extension = path.extname(fileName).toLowerCase()

  // 二进制产物（截图等）由捕获工具/脚本产生，不走文本创建入口。
  if (KNOWN_BINARY_EXTENSIONS.has(extension)) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      `不支持创建 ${extension} 二进制文件；图片等产物请由测试流程或捕获工具产生。`,
    )
  }

  const bytes = Buffer.from(content, 'utf-8')
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '文件内容超过 1 MiB 限制。')
  }

  const resolvedSkill = await resolveSkill(options, skillId)
  const workspaceRoot = path.join(
    resolvedSkill.skillRoot,
    USER_WORKSPACE_DIRECTORY_NAME,
  )

  // 父目录逐段确认/创建（与目录创建同一条逐段安全规则）。
  let currentPath = workspaceRoot
  for (const segment of segments.slice(0, -1)) {
    currentPath = path.join(currentPath, segment)
    await ensureSegmentAcceptableForDirectory(currentPath, segment)
  }

  const targetPath = path.join(currentPath, fileName)

  // wx 标志：已存在即失败，保证「创建不覆盖」语义的原子性。
  try {
    const handle = await open(targetPath, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    throw translateCreateError(error, targetPath)
  }

  return {
    relativePath: [USER_WORKSPACE_DIRECTORY_NAME, ...segments].join('/'),
    version: hashBytes(bytes),
    size: bytes.byteLength,
  }
}

/**
 * 归一化并校验 userWorkSpace 内相对路径的段列表。
 *
 * @param relativePath - 调用方给出的原始路径（允许带一次前导 userWorkSpace 段）。
 * @returns userWorkSpace 内的段列表（至少一段）。
 * @throws SkillManagerError 路径非法（含越界、绝对路径、重复 userWorkSpace 段）或
 *   深度超过文件树上限时抛出。
 */
function normalizeWorkspaceSegments (relativePath: string): string[] {
  const normalized = normalizeUserWorkspaceRelativePath(relativePath)

  if (normalized === undefined) {
    throw new SkillManagerError(
      'INVALID_FILE_PATH',
      '路径不合法：只能使用 userWorkSpace 内的相对路径。',
    )
  }

  const segments = normalized.split('/')

  // userWorkSpace 根之下的总深度不能超过文件树扫描上限（+1 是 userWorkSpace 自身）。
  if (segments.length + 1 > MAX_SKILL_TREE_DEPTH) {
    throw new SkillManagerError(
      'TREE_TOO_LARGE',
      '目录层级超过文件树最大深度。',
    )
  }

  return segments
}

/**
 * 确认目录段可接受，不存在时逐段创建。
 *
 * @param segmentPath - 段的绝对路径。
 * @param segment - 段名（错误信息定位用）。
 * @returns 段已是目录或本次创建成功时兑现。
 * @throws SkillManagerError 段被普通文件或符号链接占用时抛出（INVALID_FILE_PATH）；
 *   创建失败抛出对应分类错误。
 */
async function ensureSegmentAcceptableForDirectory (
  segmentPath: string,
  segment: string,
): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(segmentPath)
  } catch {
    // 不存在：逐段创建（非 recursive——上一段已确保存在）。
    try {
      await mkdir(segmentPath, { recursive: false })
    } catch (error) {
      throw translateCreateError(error, segmentPath)
    }
    return
  }

  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return
  }

  throw new SkillManagerError(
    'INVALID_FILE_PATH',
    `路径段「${segment}」已被文件或符号链接占用，无法在其下创建目录。`,
  )
}

/**
 * 把创建类 IO 错误翻译为稳定错误码。
 *
 * @param error - mkdir/open 抛出的原始错误。
 * @param targetPath - 目标绝对路径（错误信息定位用）。
 * @returns 已分类的 SkillManagerError。
 * @throws 不抛出异常。
 */
function translateCreateError (
  error: unknown,
  targetPath: string,
): SkillManagerError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code

  if (code === 'EEXIST') {
    return new SkillManagerError(
      'FILE_ALREADY_EXISTS',
      '目标已存在，创建不会覆盖已有内容；如需替换请先删除。',
      error,
    )
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      '没有权限在 userWorkSpace 内创建内容，请检查 Skill 目录权限。',
      error,
    )
  }

  return new SkillManagerError(
    'USER_WORKSPACE_CREATE_FAILED',
    `在 userWorkSpace 内创建失败：${path.basename(targetPath)}`,
    error,
  )
}

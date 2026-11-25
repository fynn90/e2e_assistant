/**
 * 为 Skill 根目录下的固定业务文件提供安全读取和 create-or-update 原子写。
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { MAX_SKILL_FILE_BYTES } from '../constants'
import { getFileSystemErrorCode, SkillManagerError } from '../errors'
import { hashBytes } from '../file-content'

export interface IFixedFileSnapshot {
  content: string
  bytes: Buffer
  version: string
  size: number
  updatedAt: string
  /** 磁盘文件的换行风格：写回时必须保留，否则版本比对会永久失配。 */
  lineEnding: 'lf' | 'crlf'
  /** 磁盘文件是否带 UTF-8 BOM：写回时必须保留，否则版本比对会永久失配。 */
  hasUtf8Bom: boolean
}

export interface IWriteFixedFileResult {
  version: string
  size: number
  updatedAt: string
}

/** 固定业务文件的序列化选项：保留磁盘原有的换行风格与 UTF-8 BOM。 */
export interface IFixedFileSerializationOptions {
  /** 换行风格；缺省为 `lf`。 */
  lineEnding: 'lf' | 'crlf'
  /** 是否在文件头写入 UTF-8 BOM；缺省为 false。 */
  hasUtf8Bom: boolean
}

/**
 * 安全读取 Skill 根目录下已经由仓储固定的业务文件。
 *
 * @param skillRoot - 已由 resolveSkill 验证的 Skill 根目录。
 * @param fileName - 仓储内部固定的文件名，不接受 API 用户输入。
 * @returns 文件快照；文件不存在时返回 null。
 */
export async function readFixedUtf8File(
  skillRoot: string,
  fileName: string,
): Promise<IFixedFileSnapshot | null> {
  assertFixedFileName(fileName)
  const filePath = path.join(skillRoot, fileName)
  let fileStat

  try {
    fileStat = await lstat(filePath)
  } catch (error) {
    if (getFileSystemErrorCode(error) === 'ENOENT') {
      return null
    }

    throw error
  }

  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink > 1) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      `${fileName} 必须是普通单链接文件。`,
    )
  }

  if (fileStat.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError(
      'FILE_TOO_LARGE',
      `${fileName} 超过 1 MiB 限制。`,
    )
  }

  const handle = await openWithoutFollowingSymlink(filePath)

  try {
    const openedStat = await handle.stat()

    if (!openedStat.isFile() || openedStat.nlink > 1) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        `${fileName} 必须是普通单链接文件。`,
      )
    }

    const bytes = await handle.readFile()

    if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillManagerError(
        'FILE_TOO_LARGE',
        `${fileName} 超过 1 MiB 限制。`,
      )
    }

    if (bytes.includes(0)) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        `${fileName} 包含二进制内容。`,
      )
    }

    const hasUtf8Bom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    let content: string

    try {
      // TextDecoder 默认（ignoreBOM: false）会跳过 BOM，因此 content 不含 BOM 字符；
      // hasUtf8Bom 单独记录，供写入时还原原始字节形态。
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        `${fileName} 不是有效 UTF-8。`,
        error,
      )
    }

    return {
      content,
      bytes,
      version: hashBytes(bytes),
      size: bytes.byteLength,
      updatedAt: openedStat.mtime.toISOString(),
      lineEnding: content.includes('\r\n') ? 'crlf' : 'lf',
      hasUtf8Bom,
    }
  } finally {
    await handle.close()
  }
}

/**
 * 在 Skill 根目录中原子创建或更新固定业务文件。
 *
 * 序列化选项用于对齐通用文件写路径（`atomic-write.ts` 的 `serializeEditorContent`）：
 * 读取时版本基于**磁盘原始字节**计算，因此写入必须保留原有的换行与 BOM，
 * 否则返回的版本与再次读取的版本永不相等，下一次保存必然 `FILE_VERSION_CONFLICT`
 * （Windows 上 VSCode 或 git autocrlf 极易产生 CRLF / BOM 文件）。
 *
 * @param skillRoot - 已验证的 Skill 根目录。
 * @param fileName - 仓储内部固定文件名。
 * @param content - 待写入的 UTF-8 文本。
 * @param expectedVersion - null 表示文件必须不存在；字符串表示当前字节版本必须匹配。
 * @param options - 序列化选项；缺省按 LF、无 BOM 处理（与既有调用方行为一致）。
 * @returns 新文件版本、大小和更新时间。
 */
export async function writeFixedUtf8File(
  skillRoot: string,
  fileName: string,
  content: string,
  expectedVersion: string | null,
  options?: IFixedFileSerializationOptions,
): Promise<IWriteFixedFileResult> {
  assertFixedFileName(fileName)

  if (expectedVersion !== null && !/^[a-f0-9]{64}$/.test(expectedVersion)) {
    throw new SkillManagerError('INVALID_REQUEST', '文件版本值不正确。')
  }

  const bytes = serializeFixedFileContent(content, options)

  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '保存内容超过 1 MiB 限制。')
  }

  const initialSnapshot = await readFixedUtf8File(skillRoot, fileName)
  assertExpectedVersion(initialSnapshot, expectedVersion)
  const filePath = path.join(skillRoot, fileName)
  const tempPath = path.join(
    skillRoot,
    `.${fileName}.authine-tmp-${process.pid}-${randomUUID()}`,
  )
  let tempCreated = false

  try {
    const tempHandle = await open(
      tempPath,
      'wx',
      initialSnapshot ? 0o600 : 0o600,
    )
    tempCreated = true

    try {
      await tempHandle.writeFile(bytes)
      await tempHandle.sync()
    } finally {
      await tempHandle.close()
    }

    const finalSnapshot = await readFixedUtf8File(skillRoot, fileName)
    assertExpectedVersion(finalSnapshot, expectedVersion)
    await rename(tempPath, filePath)
    tempCreated = false
    await syncDirectory(skillRoot)
    const nextStat = await stat(filePath)
    return {
      version: hashBytes(bytes),
      size: bytes.byteLength,
      updatedAt: nextStat.mtime.toISOString(),
    }
  } finally {
    if (tempCreated) {
      await rm(tempPath, { force: true }).catch(() => undefined)
    }
  }
}

export async function restoreFixedUtf8File(
  skillRoot: string,
  fileName: string,
  snapshot: IFixedFileSnapshot | null,
  expectedCurrentVersion: string,
): Promise<void> {
  assertFixedFileName(fileName)
  const currentSnapshot = await readFixedUtf8File(skillRoot, fileName)

  if (!currentSnapshot || currentSnapshot.version !== expectedCurrentVersion) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      `无法恢复 ${fileName}，文件已被外部修改。`,
    )
  }

  if (snapshot) {
    await writeFixedUtf8File(
      skillRoot,
      fileName,
      snapshot.content,
      currentSnapshot.version,
    )
    return
  }

  await rm(path.join(skillRoot, fileName), { force: false })
  await syncDirectory(skillRoot)
}

function assertExpectedVersion(
  snapshot: IFixedFileSnapshot | null,
  expectedVersion: string | null,
): void {
  if (expectedVersion === null && snapshot) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      '文件已经存在，请刷新后重试。',
    )
  }

  if (expectedVersion !== null && !snapshot) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      '文件已被删除，请刷新后重试。',
    )
  }

  if (expectedVersion !== null && snapshot?.version !== expectedVersion) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      '文件已在外部修改，请刷新后重试。',
    )
  }
}

/**
 * 按序列化选项把文本编码为字节，保留磁盘原有的换行与 BOM。
 *
 * @param content - 待写入的文本（调用方可能使用任意换行风格）。
 * @param options - 序列化选项；缺省时按 LF、无 BOM 处理。
 * @returns 用于写入并计算版本的字节序列。
 */
function serializeFixedFileContent(
  content: string,
  options?: IFixedFileSerializationOptions,
): Buffer {
  const normalizedLineEnding = options?.lineEnding ?? 'lf'
  const normalizedLfContent = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const serializedContent =
    normalizedLineEnding === 'crlf'
      ? normalizedLfContent.replace(/\n/g, '\r\n')
      : normalizedLfContent
  const contentBuffer = Buffer.from(serializedContent, 'utf-8')

  if (!options?.hasUtf8Bom) {
    return contentBuffer
  }

  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), contentBuffer])
}

function assertFixedFileName(fileName: string): void {
  if (
    !fileName ||
    path.basename(fileName) !== fileName ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new SkillManagerError('INVALID_FILE_PATH', '固定业务文件名不正确。')
  }
}

async function openWithoutFollowingSymlink(filePath: string) {
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0

  try {
    return await open(filePath, fsConstants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (noFollowFlag && getFileSystemErrorCode(error) === 'EINVAL') {
      return open(filePath, 'r')
    }

    throw error
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  const handle = await open(directoryPath, 'r')

  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

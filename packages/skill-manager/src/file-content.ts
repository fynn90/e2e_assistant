import { createHash } from 'node:crypto'
import { access, open } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { ISkillFileContent } from '@charlie_deng/e2e-assistant-types'
import { KNOWN_BINARY_EXTENSIONS, MAX_SKILL_FILE_BYTES } from './constants'
import { resolveSkill } from './detail'
import { SkillManagerError } from './errors'
import {
  resolveSafeSkillFilePath,
  type IResolvedSkillFilePath,
} from './path-guard'
import type { ISkillStorageOptions } from './storage'

export interface IRawSkillFileSnapshot {
  bytes: Buffer
  version: string
  lineEnding: 'lf' | 'crlf'
  hasUtf8Bom: boolean
  content: string
  updatedAt: string
  readOnly: boolean
  language: string
}

export async function readSkillFile (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
): Promise<ISkillFileContent> {
  const resolvedSkill = await resolveSkill(options, skillId)
  const resolvedPath = await resolveSafeSkillFilePath(
    resolvedSkill.skillRoot,
    relativePath,
  )
  const snapshot = await readResolvedSkillFile(resolvedPath)

  return {
    relativePath: resolvedPath.relativePath,
    content: snapshot.content,
    language: snapshot.language,
    readOnly: snapshot.readOnly,
    version: snapshot.version,
    size: snapshot.bytes.byteLength,
    updatedAt: snapshot.updatedAt,
    lineEnding: snapshot.lineEnding,
    hasUtf8Bom: snapshot.hasUtf8Bom,
  }
}

export async function readResolvedSkillFile (
  resolvedPath: IResolvedSkillFilePath,
): Promise<IRawSkillFileSnapshot> {
  if (resolvedPath.stat.size > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '文件大小超过 1 MiB 限制。')
  }

  if (resolvedPath.stat.nlink > 1) {
    throw new SkillManagerError('FILE_NOT_SUPPORTED', '不支持打开硬链接文件。')
  }

  if (
    KNOWN_BINARY_EXTENSIONS.has(
      path.extname(resolvedPath.relativePath).toLowerCase(),
    )
  ) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      '该文件类型不支持文本编辑。',
    )
  }

  const fileHandle = await openFileWithoutFollowingSymlink(
    resolvedPath.absolutePath,
  )

  try {
    const fileStat = await fileHandle.stat()

    if (!fileStat.isFile() || fileStat.nlink > 1) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        '只允许打开普通单链接文件。',
      )
    }

    const bytes = await readBoundedFile(fileHandle)

    if (bytes.includes(0)) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        '检测到二进制内容，无法打开。',
      )
    }

    const hasUtf8Bom =
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    const contentBytes = hasUtf8Bom ? bytes.subarray(3) : bytes
    let content: string

    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes)
    } catch (error) {
      throw new SkillManagerError(
        'FILE_NOT_SUPPORTED',
        '文件不是有效的 UTF-8 文本。',
        error,
      )
    }

    let writable = true

    try {
      await Promise.all([
        access(resolvedPath.absolutePath, fsConstants.W_OK),
        access(path.dirname(resolvedPath.absolutePath), fsConstants.W_OK),
      ])
    } catch {
      writable = false
    }

    return {
      bytes,
      content,
      version: hashBytes(bytes),
      lineEnding: detectLineEnding(content),
      hasUtf8Bom,
      updatedAt: fileStat.mtime.toISOString(),
      readOnly: resolvedPath.isManifest || !writable,
      language: detectLanguage(resolvedPath.relativePath),
    }
  } finally {
    await fileHandle.close()
  }
}

export function hashBytes (bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function serializeEditorContent (
  content: string,
  options: { lineEnding: 'lf' | 'crlf'; hasUtf8Bom: boolean },
): Buffer {
  const normalizedLfContent = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  const serializedContent =
    options.lineEnding === 'crlf'
      ? normalizedLfContent.replace(/\n/g, '\r\n')
      : normalizedLfContent
  const contentBuffer = Buffer.from(serializedContent, 'utf-8')

  if (!options.hasUtf8Bom) {
    return contentBuffer
  }

  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), contentBuffer])
}

async function openFileWithoutFollowingSymlink (filePath: string) {
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0

  try {
    return await open(filePath, fsConstants.O_RDONLY | noFollowFlag)
  } catch (error) {
    if (noFollowFlag && getErrorCode(error) === 'EINVAL') {
      return await open(filePath, 'r')
    }

    throw error
  }
}

async function readBoundedFile (
  fileHandle: Awaited<ReturnType<typeof open>>,
): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1)
  let bytesReadTotal = 0

  while (bytesReadTotal < buffer.length) {
    const { bytesRead } = await fileHandle.read(
      buffer,
      bytesReadTotal,
      buffer.length - bytesReadTotal,
      bytesReadTotal,
    )

    if (bytesRead === 0) {
      break
    }

    bytesReadTotal += bytesRead
  }

  if (bytesReadTotal > MAX_SKILL_FILE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '文件大小超过 1 MiB 限制。')
  }

  return buffer.subarray(0, bytesReadTotal)
}

function detectLineEnding (content: string): 'lf' | 'crlf' {
  return content.includes('\r\n') ? 'crlf' : 'lf'
}

function detectLanguage (relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase()
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.json': 'json',
    '.md': 'markdown',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.xml': 'xml',
    '.sh': 'shell',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.vue': 'vue',
  }

  return languageMap[extension] ?? 'plaintext'
}

function getErrorCode (error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined
}

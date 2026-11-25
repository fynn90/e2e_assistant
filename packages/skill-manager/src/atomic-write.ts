import { randomUUID } from 'node:crypto'
import { open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { lock } from 'proper-lockfile'
import {
  parseEnvFileContent,
  type IUpdateSkillFileRequest,
} from '@authine-e2e-agent/types'
import {
  E2E_SCHEMA_FILE_NAME,
  MAX_SKILL_FILE_BYTES,
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  SKILL_ENV_FILE_NAME,
} from './constants'
import { resolveSkill } from './detail'
import { SkillManagerError } from './errors'
import {
  hashBytes,
  readResolvedSkillFile,
  serializeEditorContent,
} from './file-content'
import { normalizeRelativePath, resolveSafeSkillFilePath } from './path-guard'
import { writeFixedUtf8File } from './transaction/fixed-file-atomic-write'
import { acquireSkillLock } from './transaction/skill-lock'
import type { ISkillStorageOptions } from './storage'

export interface IWriteSkillFileResult {
  relativePath: string
  version: string
  size: number
  updatedAt: string
}

/**
 * 写入前的内容校验钩子：校验失败抛出异常即阻断落盘（PRD 5.3）。
 *
 * 校验发生在版本比对之后、临时文件创建之前，因此被阻断的写入
 * 天然保留磁盘上的最近一份合法内容。
 */
type TWriteContentValidator = (content: string) => void

export async function writeSkillFile(
  options: ISkillStorageOptions,
  skillId: string,
  input: IUpdateSkillFileRequest,
): Promise<IWriteSkillFileResult> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedVersion)) {
    throw new SkillManagerError('INVALID_REQUEST', '文件版本值不正确。')
  }

  const normalizedRelativePath = normalizeRelativePath(input.relativePath)

  if (normalizedRelativePath === E2E_SCHEMA_FILE_NAME) {
    throw new SkillManagerError(
      'FILE_READ_ONLY',
      'e2e_schema.json 必须通过结构化 E2E 用例接口保存。',
    )
  }

  // v10：env.json 走专用校验闸门（PRD 5.3 阻断落盘，服务端兜底）——
  // 非法内容不允许落盘，磁盘上必须始终保留最近一次合法内容。
  if (normalizedRelativePath === SKILL_ENV_FILE_NAME) {
    return writeGenericTextFile(options, skillId, input, validateEnvFileContent)
  }

  if (normalizedRelativePath === PLAYWRIGHT_SCRIPT_FILE_NAME) {
    return writeManualPlaywrightScript(options, skillId, input)
  }

  return writeGenericTextFile(options, skillId, input)
}

/**
 * 校验 env.json 内容（PRD 4.2 R1–R5），不合法时抛出携带问题明细的阻断错误。
 *
 * 与前端保存前校验共用同一份 `parseEnvFileContent` 实现，两端判定必然一致。
 * @param content - 待写入的 env.json 文本。
 * @returns 校验通过时无返回值。
 * @throws SkillManagerError（ENV_FILE_INVALID）携带 `{ issues }` 明细，磁盘保持上一份合法内容。
 */
function validateEnvFileContent(content: string): void {
  const result = parseEnvFileContent(content)

  if (result.issues.length > 0) {
    throw new SkillManagerError(
      'ENV_FILE_INVALID',
      result.issues[0]?.message ??
        'env.json 校验未通过，已保留磁盘上的最近合法内容。',
      { issues: result.issues },
    )
  }
}

async function writeGenericTextFile(
  options: ISkillStorageOptions,
  skillId: string,
  input: IUpdateSkillFileRequest,
  validateContent?: TWriteContentValidator,
): Promise<IWriteSkillFileResult> {
  const resolvedSkill = await resolveSkill(options, skillId)
  const initialResolvedPath = await resolveSafeSkillFilePath(
    resolvedSkill.skillRoot,
    input.relativePath,
  )

  if (initialResolvedPath.isManifest) {
    throw new SkillManagerError(
      'FILE_READ_ONLY',
      'manifest.json 在当前版本中只读。',
    )
  }

  if (initialResolvedPath.stat.nlink > 1) {
    throw new SkillManagerError('FILE_READ_ONLY', '不允许保存硬链接文件。')
  }

  const releaseLock = await lock(initialResolvedPath.absolutePath, {
    retries: 5,
  })
  const tempFilePath = path.join(
    path.dirname(initialResolvedPath.absolutePath),
    `.${path.basename(initialResolvedPath.absolutePath)}.authine-tmp-${process.pid}-${randomUUID()}`,
  )
  let tempFileCreated = false

  try {
    const currentResolvedPath = await resolveSafeSkillFilePath(
      resolvedSkill.skillRoot,
      input.relativePath,
    )
    const currentSnapshot = await readResolvedSkillFile(currentResolvedPath)

    if (currentSnapshot.readOnly) {
      throw new SkillManagerError('FILE_READ_ONLY', '文件当前不可写。')
    }

    if (currentSnapshot.version !== input.expectedVersion) {
      throw new SkillManagerError(
        'FILE_VERSION_CONFLICT',
        '文件已在外部修改，请刷新后重试。',
      )
    }

    const nextBytes = serializeEditorContent(input.content, {
      lineEnding: currentSnapshot.lineEnding,
      hasUtf8Bom: currentSnapshot.hasUtf8Bom,
    })

    if (nextBytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new SkillManagerError('FILE_TOO_LARGE', '保存内容超过 1 MiB 限制。')
    }

    // 领域校验闸门（如 env.json 的 R1–R5）：在版本比对之后、写临时文件之前执行，
    // 抛错即中断本次写入，磁盘保持最近一份合法内容（写入尚未发生）。
    validateContent?.(input.content)

    const tempFileHandle = await open(
      tempFilePath,
      'wx',
      Number(currentResolvedPath.stat.mode) & 0o777,
    )
    tempFileCreated = true

    try {
      await tempFileHandle.writeFile(nextBytes)
      await tempFileHandle.sync()
    } finally {
      await tempFileHandle.close()
    }

    const finalResolvedPath = await resolveSafeSkillFilePath(
      resolvedSkill.skillRoot,
      input.relativePath,
    )

    if (
      finalResolvedPath.realPath !== currentResolvedPath.realPath ||
      finalResolvedPath.stat.dev !== currentResolvedPath.stat.dev ||
      finalResolvedPath.stat.ino !== currentResolvedPath.stat.ino ||
      finalResolvedPath.stat.nlink > 1
    ) {
      throw new SkillManagerError(
        'FILE_VERSION_CONFLICT',
        '文件已在外部修改，请刷新后重试。',
      )
    }

    const finalSnapshot = await readResolvedSkillFile(finalResolvedPath)

    if (finalSnapshot.version !== input.expectedVersion) {
      throw new SkillManagerError(
        'FILE_VERSION_CONFLICT',
        '文件已在外部修改，请刷新后重试。',
      )
    }

    await rename(tempFilePath, finalResolvedPath.absolutePath)
    tempFileCreated = false
    await syncDirectory(path.dirname(finalResolvedPath.absolutePath))
    const nextStat = await stat(finalResolvedPath.absolutePath)

    return {
      relativePath: finalResolvedPath.relativePath,
      version: hashBytes(nextBytes),
      size: nextBytes.byteLength,
      updatedAt: nextStat.mtime.toISOString(),
    }
  } finally {
    if (tempFileCreated) {
      await rm(tempFilePath, { force: true }).catch(() => undefined)
    }

    await releaseLock()
  }
}

async function writeManualPlaywrightScript(
  options: ISkillStorageOptions,
  skillId: string,
  input: IUpdateSkillFileRequest,
): Promise<IWriteSkillFileResult> {
  const releaseSkillLock = await acquireSkillLock(options, skillId)

  try {
    const resolvedSkill = await resolveSkill(options, skillId)
    const result = await writeFixedUtf8File(
      resolvedSkill.skillRoot,
      PLAYWRIGHT_SCRIPT_FILE_NAME,
      input.content,
      input.expectedVersion,
    )
    return {
      relativePath: PLAYWRIGHT_SCRIPT_FILE_NAME,
      version: result.version,
      size: result.size,
      updatedAt: result.updatedAt,
    }
  } finally {
    await releaseSkillLock()
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }

  const directoryHandle = await open(directoryPath, 'r')

  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

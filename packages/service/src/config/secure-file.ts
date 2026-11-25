import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const SECURE_DIRECTORY_MODE = 0o700
const SECURE_FILE_MODE = 0o600

export async function ensureSecureDirectory(
  directoryPath: string,
): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: SECURE_DIRECTORY_MODE })

  if (process.platform === 'win32') {
    await applyWindowsCurrentUserAcl(directoryPath)
    return
  }

  await chmod(directoryPath, SECURE_DIRECTORY_MODE)
}

export async function ensureSecureFile(filePath: string): Promise<void> {
  let exists = true

  try {
    await lstat(filePath)
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error
    }

    exists = false
  }

  if (!exists) {
    const fileHandle = await open(filePath, 'wx', SECURE_FILE_MODE)
    await fileHandle.close()
  }

  if (process.platform === 'win32') {
    await applyWindowsCurrentUserAcl(filePath)
    return
  }

  await chmod(filePath, SECURE_FILE_MODE)
}

export async function atomicWriteSecureFile(
  filePath: string,
  content: string,
): Promise<void> {
  const directoryPath = path.dirname(filePath)
  await ensureSecureDirectory(directoryPath)

  const tempFilePath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let tempFileCreated = false

  try {
    const fileHandle = await open(tempFilePath, 'wx', SECURE_FILE_MODE)
    tempFileCreated = true

    try {
      await fileHandle.writeFile(content, 'utf-8')
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }

    if (process.platform !== 'win32') {
      await chmod(tempFilePath, SECURE_FILE_MODE)
    }

    await rename(tempFilePath, filePath)
    tempFileCreated = false
    await ensureSecureFile(filePath)
    await syncDirectory(directoryPath)
  } finally {
    if (tempFileCreated) {
      await rm(tempFilePath, { force: true }).catch(() => undefined)
    }
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

async function applyWindowsCurrentUserAcl(targetPath: string): Promise<void> {
  const userName = process.env.USERNAME?.trim()

  if (!userName) {
    throw new Error('无法确定当前 Windows 用户，不能安全保存本地配置。')
  }

  await executeFile('icacls', [
    targetPath,
    '/inheritance:r',
    '/grant:r',
    `${userName}:(F)`,
  ])
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  )
}

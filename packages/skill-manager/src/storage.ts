/**
 * 管理 Skill 目录创建、全局索引读取和不可变目录身份。
 */
import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { lock } from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import {
  createDefaultE2ETestCase,
  type ISkillSummary,
} from '@charlie_deng/e2e-assistant-types'
import { DEFAULT_ENV_FILE_CONTENT } from '@charlie_deng/e2e-assistant-types'
import {
  E2E_SCHEMA_FILE_NAME,
  SKILL_ENV_FILE_NAME,
  SKILL_LIST_FILE_NAME,
  SKILL_MANIFEST_FILE_NAME,
  USER_WORKSPACE_DIRECTORY_NAME,
} from './constants'
import {
  getFileSystemErrorCode,
  isFileSystemMissingError,
  isFileSystemPermissionError,
  SkillManagerError,
} from './errors'
import { serializeE2ETestCase } from './e2e-test-case/serializer'
import {
  toSkillSummary,
  validateSkillManifest,
  type ISkillManifest,
} from './manifest/skill-manifest'

export interface ISkillStorageOptions {
  rootDir: string
}

export interface ICreateSkillOptions extends ISkillStorageOptions {
  title: string
  description?: string
}

export interface ICreateSkillResult {
  skillManifest: ISkillManifest
  skillDirectoryPath: string
}

export interface ISkillDeleteResult {
  skillId: string
  directoryName: string
}

/**
 * 创建一个包含 manifest 和默认 E2E 草稿的完整 Skill。
 *
 * Skill 首先在同一根目录的隐藏 staging 目录中构建，完成后再原子重命名为
 * 不可变的 directoryName，最后发布到 skill.list.json。
 *
 * @param options - Skill 根目录、标题和描述。
 * @returns 新 Skill 的持久化 manifest 与目录路径。
 * @throws SkillManagerError 当标题重复、ID 生成失败或文件系统操作失败时抛出。
 */
export async function createSkill (
  options: ICreateSkillOptions,
): Promise<ICreateSkillResult> {
  const normalizedTitle = validateSkillTitle(options.title)
  const normalizedDescription = validateSkillDescription(
    options.description ?? '',
  )
  const listPath = await ensureSkillListFile(options.rootDir)
  const releaseLock = await lock(listPath, { retries: 5 })
  let publishedDirectoryPath = ''
  let stagingDirectoryPath = ''

  try {
    const currentList = (await readRawSkillList(listPath)).map((item) =>
      validateSkillManifest(item),
    )

    if (currentList.some((skill) => skill.title === normalizedTitle)) {
      throw new SkillManagerError('SKILL_ALREADY_EXISTS', 'Skill 名称已存在。')
    }

    let skillId = ''
    let directoryName = ''

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidateId = createSkillId()
      const candidateDirectoryName = buildSkillDirectoryName(
        normalizedTitle,
        candidateId,
      )
      const candidateDirectoryPath = path.join(
        options.rootDir,
        candidateDirectoryName,
      )

      if (currentList.some((skill) => skill.id === candidateId)) {
        continue
      }

      try {
        await mkdir(candidateDirectoryPath, { recursive: false })
        await rm(candidateDirectoryPath, { recursive: true, force: true })
        skillId = candidateId
        directoryName = candidateDirectoryName
        break
      } catch (error) {
        if (getFileSystemErrorCode(error) === 'EEXIST') {
          continue
        }

        throw error
      }
    }

    if (!skillId || !directoryName) {
      throw new SkillManagerError(
        'INTERNAL_ERROR',
        '生成 Skill ID 失败，请重试。',
      )
    }

    const now = new Date().toISOString()
    const manifest: ISkillManifest = {
      id: skillId,
      title: normalizedTitle,
      description: normalizedDescription,
      version: '1.0.0',
      createdAt: now,
      updatedAt: now,
      directoryName,
    }
    stagingDirectoryPath = path.join(
      options.rootDir,
      `.authine-staging-${skillId}-${randomUUID()}`,
    )
    await mkdir(stagingDirectoryPath, { recursive: false, mode: 0o700 })
    await writeJsonFile(
      path.join(stagingDirectoryPath, SKILL_MANIFEST_FILE_NAME),
      manifest,
    )
    await writeFileAtomic(
      path.join(stagingDirectoryPath, E2E_SCHEMA_FILE_NAME),
      serializeE2ETestCase(
        createDefaultE2ETestCase({
          skillId,
          title: normalizedTitle,
          description: normalizedDescription,
        }),
      ),
      { encoding: 'utf-8', mode: 0o600, fsync: true },
    )
    // v10：新 Skill 默认携带 env.json（空对象），作为敏感数据真实值的唯一存放地（PRD 4.1）。
    // 与 manifest / e2e_schema 一同在 staging 中写入后整体原子重命名，创建事务原子性不变。
    await writeFileAtomic(
      path.join(stagingDirectoryPath, SKILL_ENV_FILE_NAME),
      DEFAULT_ENV_FILE_CONTENT,
      { encoding: 'utf-8', mode: 0o600, fsync: true },
    )
    // v14（W6/W7）：userWorkSpace 与 manifest/e2e_schema/env 一同在 staging 中创建，
    // 整体原子重命名——创建失败时 staging 被清理，不会发布缺少 userWorkSpace 的 Skill。
    await mkdir(
      path.join(stagingDirectoryPath, USER_WORKSPACE_DIRECTORY_NAME),
      { recursive: false },
    )
    await syncDirectory(stagingDirectoryPath)

    publishedDirectoryPath = path.join(options.rootDir, directoryName)
    await rename(stagingDirectoryPath, publishedDirectoryPath)
    stagingDirectoryPath = ''
    await syncDirectory(options.rootDir)

    currentList.push(manifest)
    await writeJsonFile(listPath, currentList)
    return {
      skillManifest: manifest,
      skillDirectoryPath: publishedDirectoryPath,
    }
  } catch (error) {
    if (stagingDirectoryPath) {
      await rm(stagingDirectoryPath, { recursive: true, force: true }).catch(
        () => undefined,
      )
    }

    if (publishedDirectoryPath) {
      await rm(publishedDirectoryPath, { recursive: true, force: true }).catch(
        () => undefined,
      )
    }

    throw error
  } finally {
    await releaseLock()
  }
}

/**
 * 删除 Skill 的持久化目录与全局索引条目，做一次彻底清理。
 *
 * 与 createSkill 对称，通过持有 skill.list.json 的锁串行化整个删除过程：
 * 先移除不可变目录（含 manifest、E2E 用例、测试脚本与文档等全部文件），
 * 再从索引剔除对应条目并原子回写；目录缺失（孤儿）时仍从索引剔除。
 *
 * @param options - Skill 存储根目录。
 * @param skillId - 九位 Skill ID。
 * @returns 被删除的 Skill 的 ID 与目录名。
 * @throws SkillManagerError 当 ID 非法、Skill 不存在、索引损坏、目录结构异常或权限不足时抛出。
 */
export async function deleteSkill (
  options: ISkillStorageOptions,
  skillId: string,
): Promise<ISkillDeleteResult> {
  if (!/^[a-z0-9]{9}$/.test(skillId)) {
    throw new SkillManagerError('INVALID_SKILL_ID', 'Skill ID 格式不正确。')
  }

  const listPath = await ensureSkillListFile(options.rootDir)
  const releaseLock = await lock(listPath, { retries: 5 })

  try {
    const rawList = await readRawSkillList(listPath)
    const rawEntry = rawList.find(
      (item) =>
        Boolean(item) &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as { id?: unknown }).id === skillId,
    )

    if (!rawEntry) {
      throw new SkillManagerError('SKILL_NOT_FOUND', 'Skill 不存在或已被删除。')
    }

    let manifest: ISkillManifest

    try {
      manifest = validateSkillManifest(rawEntry)
    } catch (error) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill 索引条目已损坏。',
        error,
      )
    }

    const directoryName = resolveSkillDirectoryName(manifest)
    const skillRoot = path.join(options.rootDir, directoryName)
    await removeSkillDirectoryIfPresent(skillRoot)

    const nextList = rawList.filter(
      (item) =>
        !(
          Boolean(item) &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as { id?: unknown }).id === skillId
        ),
    )
    await writeJsonFile(listPath, nextList)

    return { skillId, directoryName }
  } catch (error) {
    if (error instanceof SkillManagerError) {
      throw error
    }

    if (isFileSystemPermissionError(error)) {
      throw new SkillManagerError(
        'SKILL_PERMISSION_DENIED',
        '没有权限删除 Skill 目录。',
        error,
      )
    }

    throw error
  } finally {
    await releaseLock()
  }
}

/**
 * 移除已解析的 Skill 目录；目录缺失（孤儿）时静默跳过，允许继续从索引剔除。
 *
 * @param skillRoot - Skill 根目录绝对路径。
 * @throws SkillManagerError 当目录为符号链接、结构非法或权限不足时抛出。
 */
async function removeSkillDirectoryIfPresent (skillRoot: string): Promise<void> {
  try {
    const directoryStat = await lstat(skillRoot)

    if (directoryStat.isSymbolicLink()) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill 目录不允许是符号链接。',
      )
    }

    if (!directoryStat.isDirectory()) {
      throw new SkillManagerError('SKILL_CORRUPTED', 'Skill 目录结构不正确。')
    }

    await rm(skillRoot, { recursive: true, force: true })
  } catch (error) {
    if (getFileSystemErrorCode(error) === 'ENOENT') {
      // 目录已缺失（孤儿），允许继续从索引剔除。
      return
    }

    throw error
  }
}

/**
 * 查询 Skill 的持久化目录路径。
 *
 * @param options - Skill 存储配置。
 * @param skillId - 九位 Skill ID。
 * @returns Skill 目录路径；索引中不存在时返回 null。
 */
export async function getSkillStoragePath (
  options: ISkillStorageOptions,
  skillId: string,
): Promise<string | null> {
  const rawList = await readRawSkillIndex(options.rootDir)
  const rawSkill = rawList.find(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as { id?: unknown }).id === skillId,
  )

  if (!rawSkill) {
    return null
  }

  const manifest = validateSkillManifest(rawSkill)
  return path.join(options.rootDir, resolveSkillDirectoryName(manifest))
}

/**
 * 列出可用 Skill 的 API 摘要。
 *
 * @param options - Skill 存储配置。
 * @returns 按更新时间倒序排列的 Skill 摘要。
 */
export async function listSkills (
  options: ISkillStorageOptions,
): Promise<ISkillSummary[]> {
  const listPath = await ensureSkillListFile(options.rootDir)
  const releaseLock = await lock(listPath, { retries: 5 })

  try {
    const rawList = await readRawSkillList(listPath)
    return rawList
      .map((item) => {
        try {
          return toSkillSummary(validateSkillManifest(item))
        } catch {
          return null
        }
      })
      .filter((item): item is ISkillSummary => item !== null)
      .sort((leftSkill, rightSkill) =>
        rightSkill.updatedAt.localeCompare(leftSkill.updatedAt),
      )
  } finally {
    await releaseLock()
  }
}

/**
 * 读取全局索引的原始内容（不做结构校验）。
 *
 * **不加锁**：本函数是纯读，而写入侧（`writeJsonFile`）走
 * 「临时文件 + rename」的原子替换——读方要么读到旧的完整内容、要么读到新的
 * 完整内容，不存在读到半份文件的窗口。
 *
 * 为什么这一点重要（v17 修正）：此前这里持有 `proper-lockfile` 的排他锁，
 * 而 `resolveSkill` 会**每个用例调一次**本函数。清单卡要一次读 N 个用例，
 * 于是 N 个并发读互相抢锁——在 Windows 上 `proper-lockfile` 的退避粒度约 1 秒，
 * 表现为「读 2 个用例要 2 秒」（实测：串行 6 次读 20ms，并发 4 次读 7000ms）。
 * 去掉读锁后并发读不再互相阻塞；写入的互斥仍由写路径自己的锁保证。
 *
 * @param rootDir - 工作区根目录。
 * @returns 索引条目数组（未校验的原始 JSON 值）。
 * @throws SkillManagerError 索引文件不存在且无法创建、或 JSON 非法时抛出。
 */
export async function readRawSkillIndex (rootDir: string): Promise<unknown[]> {
  const listPath = await ensureSkillListFile(rootDir)
  return readRawSkillList(listPath)
}

export function buildSkillDirectoryName (
  title: string,
  skillId: string,
): string {
  return `${sanitizeSkillTitleForPath(title)}_${skillId}`
}

/**
 * 返回 manifest 指定的不可变目录名，并兼容没有 directoryName 的旧 Skill。
 *
 * @param manifest - 已校验的持久化 manifest。
 * @returns 运行时用于寻址的目录名。
 */
export function resolveSkillDirectoryName (manifest: ISkillManifest): string {
  return (
    manifest.directoryName ??
    buildSkillDirectoryName(manifest.title, manifest.id)
  )
}

export function sanitizeSkillTitleForPath (title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_')
}

export function validateSkillTitle (title: string): string {
  const normalizedTitle = title.trim()

  if (
    normalizedTitle.length < 1 ||
    normalizedTitle.length > 50 ||
    !/^[一-龥a-zA-Z0-9_-]+$/.test(normalizedTitle)
  ) {
    throw new SkillManagerError(
      'INVALID_REQUEST',
      'Skill 名称仅允许 1 到 50 个中英文、数字、下划线或中划线字符。',
    )
  }

  return normalizedTitle
}

export function validateSkillDescription (description: string): string {
  const normalizedDescription = description.trim()

  if (normalizedDescription.length > 1000) {
    throw new SkillManagerError(
      'INVALID_REQUEST',
      'Skill 描述不能超过 1000 个字符。',
    )
  }

  return normalizedDescription
}

export async function ensureSkillListFile (rootDir: string): Promise<string> {
  const listPath = path.join(rootDir, SKILL_LIST_FILE_NAME)
  await mkdir(rootDir, { recursive: true })

  try {
    await readFile(listPath, 'utf-8')
  } catch (error) {
    if (!isFileSystemMissingError(error)) {
      throw error
    }

    try {
      await writeFile(listPath, '[]\n', {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (writeError) {
      if (getFileSystemErrorCode(writeError) !== 'EEXIST') {
        throw writeError
      }
    }
  }

  return listPath
}

export async function readRawSkillList (listPath: string): Promise<unknown[]> {
  const listContent = await readFile(listPath, 'utf-8')
  let parsedList: unknown

  try {
    parsedList = JSON.parse(listContent)
  } catch (error) {
    throw new SkillManagerError(
      'SKILL_CORRUPTED',
      'Skill 索引文件已损坏。',
      error,
    )
  }

  if (!Array.isArray(parsedList)) {
    throw new SkillManagerError('SKILL_CORRUPTED', 'Skill 索引文件结构不正确。')
  }

  return parsedList
}

async function writeJsonFile (filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
    fsync: true,
  })
}

async function syncDirectory (directoryPath: string): Promise<void> {
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

function createSkillId (): string {
  return randomUUID().replace(/-/g, '').slice(0, 9)
}

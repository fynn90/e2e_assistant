/**
 * 解析 Skill 身份、不可变目录和 manifest，并生成对外详情投影。
 */
import { constants as fsConstants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ISkillDetail } from '@authine-e2e-agent/types'
import { SKILL_MANIFEST_FILE_NAME } from './constants'
import { ensureEnvFile } from './env-file'
import {
  isFileSystemMissingError,
  isFileSystemPermissionError,
  SkillManagerError,
} from './errors'
import {
  toSkillSummary,
  validateSkillManifest,
  type ISkillManifest,
} from './manifest/skill-manifest'
import { projectManifestToSkillList } from './manifest/manifest-projection'
import {
  readRawSkillIndex,
  resolveSkillDirectoryName,
  type ISkillStorageOptions,
} from './storage'
import { ensureUserWorkSpace } from './user-workspace'

export interface IResolvedSkill {
  skillRoot: string
  realSkillRoot: string
  manifest: ISkillManifest
  detail: ISkillDetail
}

/**
 * 根据 Skill ID 安全解析目录与持久化 manifest。
 *
 * @param options - Skill 存储根目录。
 * @param skillId - 九位 Skill ID。
 * @returns 解析后的真实目录、manifest 和 API 详情。
 * @throws SkillManagerError 当索引、目录、manifest 或权限不合法时抛出。
 */
export async function resolveSkill(
  options: ISkillStorageOptions,
  skillId: string,
): Promise<IResolvedSkill> {
  if (!/^[a-z0-9]{9}$/.test(skillId)) {
    throw new SkillManagerError('INVALID_SKILL_ID', 'Skill ID 格式不正确。')
  }

  const rawIndex = await readRawSkillIndex(options.rootDir)
  const rawEntry = rawIndex.find(
    (item) =>
      Boolean(item) &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as { id?: unknown }).id === skillId,
  )

  if (!rawEntry) {
    throw new SkillManagerError('SKILL_NOT_FOUND', 'Skill 不存在或已被删除。')
  }

  let indexManifest: ISkillManifest

  try {
    indexManifest = validateSkillManifest(rawEntry)
  } catch (error) {
    throw new SkillManagerError(
      'SKILL_CORRUPTED',
      'Skill 索引条目已损坏。',
      error,
    )
  }

  const directoryName = resolveSkillDirectoryName(indexManifest)
  const skillRoot = path.join(options.rootDir, directoryName)

  try {
    const rootStat = await lstat(skillRoot)

    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new SkillManagerError('SKILL_CORRUPTED', 'Skill 目录结构不正确。')
    }

    const realSkillRoot = await realpath(skillRoot)
    const manifestPath = path.join(skillRoot, SKILL_MANIFEST_FILE_NAME)
    const manifestStat = await lstat(manifestPath)

    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill manifest 文件结构不正确。',
      )
    }

    const manifestRealPath = await realpath(manifestPath)

    if (!isPathInside(realSkillRoot, manifestRealPath)) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill manifest 已逃逸 Skill 目录。',
      )
    }

    let manifest: ISkillManifest

    try {
      manifest = validateSkillManifest(
        JSON.parse(await readFile(manifestPath, 'utf-8')),
      )
    } catch (error) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill manifest 已损坏。',
        error,
      )
    }

    if (
      manifest.id !== indexManifest.id ||
      manifest.version !== indexManifest.version
    ) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill 索引与 manifest 身份不一致。',
      )
    }

    const persistedManifest = manifest
    const manifestDirectoryName = manifest.directoryName ?? directoryName

    if (manifestDirectoryName !== directoryName) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill 目录身份与 manifest 不一致。',
      )
    }

    if (!areManifestProjectionsEqual(indexManifest, persistedManifest)) {
      await projectManifestToSkillList(options, persistedManifest).catch(
        () => undefined,
      )
    }

    manifest = { ...manifest, directoryName: manifestDirectoryName }
    let readOnly = false

    try {
      await access(skillRoot, fsConstants.R_OK | fsConstants.W_OK)
    } catch {
      readOnly = true
    }

    return {
      skillRoot,
      realSkillRoot,
      manifest,
      detail: { ...toSkillSummary(manifest), readOnly },
    }
  } catch (error) {
    if (error instanceof SkillManagerError) {
      throw error
    }

    if (isFileSystemMissingError(error)) {
      throw new SkillManagerError(
        'SKILL_CORRUPTED',
        'Skill 目录或 manifest 不存在。',
        error,
      )
    }

    if (isFileSystemPermissionError(error)) {
      throw new SkillManagerError(
        'SKILL_PERMISSION_DENIED',
        '没有权限读取 Skill 目录。',
        error,
      )
    }

    throw new SkillManagerError('SKILL_CORRUPTED', 'Skill 加载失败。', error)
  }
}

export async function getSkillDetail(
  options: ISkillStorageOptions,
  skillId: string,
): Promise<ISkillDetail> {
  const resolved = await resolveSkill(options, skillId)
  // v10：打开 Skill 时保障 env.json 存在（PRD 4.1 存量补建）。
  // 补建失败内部降级、不抛出，不影响详情返回。
  await ensureEnvFile(options, skillId)
  // v14（W8/W11）：打开存量 Skill 时幂等补建 userWorkSpace（silent：浏览可继续）。
  // 补建失败静默降级；文件树入口会以 notice 展示原因，依赖 userWorkSpace 的
  // 生成/执行入口另有 strict 模式把关。
  await ensureUserWorkSpace(options, skillId, 'silent')
  return resolved.detail
}

function areManifestProjectionsEqual(
  indexManifest: ISkillManifest,
  persistedManifest: ISkillManifest,
): boolean {
  return JSON.stringify(indexManifest) === JSON.stringify(persistedManifest)
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  )
}

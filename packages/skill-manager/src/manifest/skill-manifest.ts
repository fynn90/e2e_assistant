/**
 * 定义 Skill manifest 的持久化模型、兼容解析和 API 投影。
 * manifest 字段与列表 API DTO 分离，避免新增持久化元数据时被旧校验器截断。
 */
import type { ISkillSummary } from '@charlie_deng/e2e-assistant-types'

export interface IGeneratedSkillMetadata {
  path: 'SKILL.md'
  sourceHash: string
  generatedAt: string
}

export interface IGeneratedScriptMetadata {
  path: 'test.spec.ts'
  sourceHash: string
  generatedAt: string
}

export interface ISkillManifest {
  id: string
  title: string
  description: string
  version: string
  createdAt: string
  updatedAt: string
  directoryName?: string
  generatedSkill?: IGeneratedSkillMetadata
  generatedScript?: IGeneratedScriptMetadata
}

/**
 * 解析未知的持久化 Skill manifest，并保留受支持的扩展元数据。
 *
 * @param input - 从 manifest.json 或 skill.list.json 读取的未知数据。
 * @returns 标准化后的持久化 manifest。
 * @throws Error 当身份、时间或生成脚本元数据不合法时抛出。
 */
export function validateSkillManifest (input: unknown): ISkillManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Skill manifest 结构不正确。')
  }

  const manifest = input as Partial<ISkillManifest>
  const normalizedId = typeof manifest.id === 'string' ? manifest.id.trim() : ''
  const normalizedTitle =
    typeof manifest.title === 'string' ? manifest.title.trim() : ''
  const normalizedDescription =
    typeof manifest.description === 'string' ? manifest.description.trim() : ''
  const normalizedVersion =
    typeof manifest.version === 'string' ? manifest.version.trim() : ''
  const normalizedCreatedAt =
    typeof manifest.createdAt === 'string' ? manifest.createdAt : ''
  const normalizedUpdatedAt =
    typeof manifest.updatedAt === 'string' ? manifest.updatedAt : ''
  const normalizedDirectoryName =
    typeof manifest.directoryName === 'string'
      ? manifest.directoryName.trim()
      : undefined

  if (!/^[a-z0-9]{9}$/.test(normalizedId)) {
    throw new Error('Skill manifest 的 id 字段不正确。')
  }

  if (!normalizedTitle) {
    throw new Error('Skill manifest 缺少 title 字段。')
  }

  if (!normalizedVersion) {
    throw new Error('Skill manifest 缺少 version 字段。')
  }

  if (!isIsoDate(normalizedCreatedAt) || !isIsoDate(normalizedUpdatedAt)) {
    throw new Error('Skill manifest 的时间字段不正确。')
  }

  if (
    normalizedDirectoryName &&
    !isSafeDirectoryName(normalizedDirectoryName)
  ) {
    throw new Error('Skill manifest 的 directoryName 字段不正确。')
  }

  const generatedSkill = parseGeneratedSkillMetadata(manifest.generatedSkill)
  const generatedScript = parseGeneratedScriptMetadata(manifest.generatedScript)
  return {
    id: normalizedId,
    title: normalizedTitle,
    description: normalizedDescription,
    version: normalizedVersion,
    createdAt: normalizedCreatedAt,
    updatedAt: normalizedUpdatedAt,
    ...(normalizedDirectoryName
      ? { directoryName: normalizedDirectoryName }
      : {}),
    ...(generatedSkill ? { generatedSkill } : {}),
    ...(generatedScript ? { generatedScript } : {}),
  }
}

/**
 * 将持久化 manifest 转换为对外 Skill 列表和详情使用的摘要 DTO。
 *
 * @param manifest - 已校验的持久化 manifest。
 * @returns 不包含目录和生成脚本内部元数据的 API 摘要。
 */
export function toSkillSummary (manifest: ISkillManifest): ISkillSummary {
  return {
    id: manifest.id,
    title: manifest.title,
    description: manifest.description,
    version: manifest.version,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  }
}

function parseGeneratedSkillMetadata (
  input: unknown,
): IGeneratedSkillMetadata | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Skill manifest 的 generatedSkill 字段不正确。')
  }

  const metadata = input as Partial<IGeneratedSkillMetadata>
  if (
    metadata.path !== 'SKILL.md' ||
    typeof metadata.sourceHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.sourceHash) ||
    typeof metadata.generatedAt !== 'string' ||
    !isIsoDate(metadata.generatedAt)
  ) {
    throw new Error('Skill manifest 的 generatedSkill 字段不正确。')
  }

  return {
    path: metadata.path,
    sourceHash: metadata.sourceHash,
    generatedAt: metadata.generatedAt,
  }
}
function parseGeneratedScriptMetadata (
  input: unknown,
): IGeneratedScriptMetadata | undefined {
  if (input === undefined) {
    return undefined
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Skill manifest 的 generatedScript 字段不正确。')
  }

  const metadata = input as Partial<IGeneratedScriptMetadata>

  if (
    metadata.path !== 'test.spec.ts' ||
    typeof metadata.sourceHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.sourceHash) ||
    typeof metadata.generatedAt !== 'string' ||
    !isIsoDate(metadata.generatedAt)
  ) {
    throw new Error('Skill manifest 的 generatedScript 字段不正确。')
  }

  return {
    path: metadata.path,
    sourceHash: metadata.sourceHash,
    generatedAt: metadata.generatedAt,
  }
}

function isSafeDirectoryName (value: string): boolean {
  return (
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  )
}

function isIsoDate (value: string): boolean {
  return Boolean(value && !Number.isNaN(Date.parse(value)))
}

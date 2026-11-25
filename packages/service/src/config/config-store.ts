import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants } from 'node:fs'
import type { IConfigSummary, TConfigIssue } from '@fynn90-e2e_assistant/types'
import { getAuthineConfigDirectory, getPlatformConfigPath } from './config-path'
import { buildStorageAccessError } from './storage-error'
import {
  atomicWriteSecureFile,
  ensureSecureDirectory,
  ensureSecureFile,
} from './secure-file'

export interface IAuthinePlatformConfig {
  projectDirectory: string
  llmApiKey: string
  llmApiBaseUrl: string
  llmModelName: string
  createdAt: string
  updatedAt: string
}

export interface IInitializationPayload {
  projectDirectory: string
  llmApiKey: string
  llmApiBaseUrl: string
  llmModelName: string
}

export interface IUpdatePlatformConfigPayload {
  projectDirectory: string
  llmApiKey?: string
  llmApiBaseUrl: string
  llmModelName: string
}

export type TPlatformConfigInspection =
  | { state: 'uninitialized'; config: null }
  | { state: 'corrupted'; config: null }
  | { state: 'configured'; config: IAuthinePlatformConfig }

export interface IPlatformConfigReadiness {
  workspaceReady: boolean
  chatReady: boolean
  issues: TConfigIssue[]
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

interface ISavePlatformConfigOptions {
  payload: IInitializationPayload
}

export async function hasPlatformConfig (): Promise<boolean> {
  try {
    await access(getPlatformConfigPath(), fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function ensurePlatformConfigStorage (): Promise<void> {
  const configDirectoryPath = getAuthineConfigDirectory()
  const configPath = getPlatformConfigPath()

  try {
    await ensureSecureDirectory(configDirectoryPath)
    await ensureSecureFile(configPath)
  } catch (error) {
    throw buildStorageAccessError({
      actionLabel: '初始化配置存储',
      targetPath: configPath,
      error,
    })
  }
}

export async function inspectPlatformConfig (): Promise<TPlatformConfigInspection> {
  const configPath = getPlatformConfigPath()

  try {
    const configContent = await readFile(configPath, 'utf-8')
    const normalizedContent = configContent.trim()

    if (!normalizedContent) {
      return { state: 'uninitialized', config: null }
    }

    let parsedConfig: unknown

    try {
      parsedConfig = JSON.parse(normalizedContent)
    } catch {
      return { state: 'corrupted', config: null }
    }

    if (
      !parsedConfig ||
      typeof parsedConfig !== 'object' ||
      Array.isArray(parsedConfig)
    ) {
      return { state: 'corrupted', config: null }
    }

    return {
      state: 'configured',
      config: normalizePlatformConfig(
        parsedConfig as Partial<IAuthinePlatformConfig>,
      ),
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { state: 'uninitialized', config: null }
    }

    throw error
  }
}

export async function loadPlatformConfig (): Promise<IAuthinePlatformConfig | null> {
  const inspection = await inspectPlatformConfig()
  return inspection.state === 'configured' ? inspection.config : null
}

export async function savePlatformConfig (
  options: ISavePlatformConfigOptions,
): Promise<IAuthinePlatformConfig> {
  const inspection = await inspectPlatformConfig()
  const currentTimestamp = new Date().toISOString()
  const nextConfig: IAuthinePlatformConfig = {
    projectDirectory: path.resolve(options.payload.projectDirectory),
    llmApiKey: options.payload.llmApiKey.trim(),
    llmApiBaseUrl: normalizeApiBaseUrl(options.payload.llmApiBaseUrl),
    llmModelName: options.payload.llmModelName.trim(),
    createdAt:
      inspection.state === 'configured' && inspection.config.createdAt
        ? inspection.config.createdAt
        : currentTimestamp,
    updatedAt: currentTimestamp,
  }

  await writePlatformConfigFile(nextConfig)
  return nextConfig
}

export async function validateInitializationPayload (
  payload: IInitializationPayload,
): Promise<IInitializationPayload> {
  const projectDirectoryInput = payload.projectDirectory.trim()

  if (!projectDirectoryInput) {
    throw new ConfigValidationError('请先输入项目空目录路径。')
  }

  const normalizedApiKey = payload.llmApiKey.trim()

  if (!normalizedApiKey) {
    throw new ConfigValidationError('请先输入大模型 API Key。')
  }

  const normalizedModelName = payload.llmModelName.trim()

  if (!normalizedModelName) {
    throw new ConfigValidationError('请先输入大模型模型名称。')
  }

  const normalizedProjectDirectory = path.resolve(projectDirectoryInput)
  const normalizedApiBaseUrl = normalizeApiBaseUrl(payload.llmApiBaseUrl)
  await ensureProjectDirectory(normalizedProjectDirectory, true)

  return {
    projectDirectory: normalizedProjectDirectory,
    llmApiKey: normalizedApiKey,
    llmApiBaseUrl: normalizedApiBaseUrl,
    llmModelName: normalizedModelName,
  }
}

export async function validateUpdatePayload (
  payload: IUpdatePlatformConfigPayload,
): Promise<IInitializationPayload> {
  const projectDirectoryInput = payload.projectDirectory.trim()

  if (!projectDirectoryInput) {
    throw new ConfigValidationError('请先输入项目目录路径。')
  }

  const inspection = await inspectPlatformConfig()
  const submittedApiKey = payload.llmApiKey?.trim() ?? ''
  const preservedApiKey =
    inspection.state === 'configured' ? inspection.config.llmApiKey.trim() : ''
  const nextApiKey = submittedApiKey || preservedApiKey

  if (!nextApiKey) {
    throw new ConfigValidationError(
      '当前配置无法恢复原 API Key，请输入新的大模型 API Key。',
    )
  }

  const normalizedModelName = payload.llmModelName.trim()

  if (!normalizedModelName) {
    throw new ConfigValidationError('请先输入大模型模型名称。')
  }

  const normalizedProjectDirectory = path.resolve(projectDirectoryInput)
  const normalizedApiBaseUrl = normalizeApiBaseUrl(payload.llmApiBaseUrl)
  await ensureProjectDirectory(normalizedProjectDirectory, false)

  return {
    projectDirectory: normalizedProjectDirectory,
    llmApiKey: nextApiKey,
    llmApiBaseUrl: normalizedApiBaseUrl,
    llmModelName: normalizedModelName,
  }
}

export async function evaluatePlatformConfig (
  platformConfig: IAuthinePlatformConfig,
): Promise<IPlatformConfigReadiness> {
  const issues: TConfigIssue[] = []
  const projectDirectory = platformConfig.projectDirectory.trim()

  if (!projectDirectory) {
    issues.push('PROJECT_DIRECTORY_MISSING')
  } else {
    try {
      const projectDirectoryStat = await stat(projectDirectory)

      if (!projectDirectoryStat.isDirectory()) {
        issues.push('PROJECT_DIRECTORY_UNAVAILABLE')
      } else {
        await access(projectDirectory, fsConstants.R_OK | fsConstants.W_OK)
      }
    } catch {
      issues.push('PROJECT_DIRECTORY_UNAVAILABLE')
    }
  }

  if (!platformConfig.llmApiKey.trim()) {
    issues.push('LLM_API_KEY_MISSING')
  }

  try {
    normalizeApiBaseUrl(platformConfig.llmApiBaseUrl)
  } catch {
    issues.push('LLM_API_BASE_URL_INVALID')
  }

  if (!platformConfig.llmModelName.trim()) {
    issues.push('LLM_MODEL_NAME_MISSING')
  }

  const workspaceReady = !issues.some(
    (issue) =>
      issue === 'PROJECT_DIRECTORY_MISSING' ||
      issue === 'PROJECT_DIRECTORY_UNAVAILABLE',
  )
  const chatReady =
    workspaceReady &&
    !issues.some(
      (issue) =>
        issue === 'LLM_API_KEY_MISSING' ||
        issue === 'LLM_API_BASE_URL_INVALID' ||
        issue === 'LLM_MODEL_NAME_MISSING',
    )

  return { workspaceReady, chatReady, issues }
}

export function isPlatformConfigInitialized (
  platformConfig: IAuthinePlatformConfig,
): boolean {
  return Boolean(
    platformConfig.projectDirectory.trim() &&
    platformConfig.llmApiKey.trim() &&
    platformConfig.llmApiBaseUrl.trim() &&
    platformConfig.llmModelName.trim(),
  )
}

export function toConfigSummary (
  platformConfig: IAuthinePlatformConfig,
): IConfigSummary {
  return {
    projectDirectory: platformConfig.projectDirectory,
    llmApiKeyMasked: maskApiKey(platformConfig.llmApiKey),
    llmApiBaseUrl: platformConfig.llmApiBaseUrl,
    llmModelName: platformConfig.llmModelName,
    createdAt: platformConfig.createdAt,
    updatedAt: platformConfig.updatedAt,
  }
}

export function normalizeApiBaseUrl (apiBaseUrl: string): string {
  const normalizedApiBaseUrl = apiBaseUrl.trim()

  if (!normalizedApiBaseUrl) {
    throw new ConfigValidationError('请先输入大模型 API 地址。')
  }

  let parsedApiBaseUrl: URL

  try {
    parsedApiBaseUrl = new URL(normalizedApiBaseUrl)
  } catch {
    throw new ConfigValidationError(
      '大模型 API 地址格式不正确，请输入合法的 URL。',
    )
  }

  if (
    parsedApiBaseUrl.protocol !== 'https:' &&
    parsedApiBaseUrl.protocol !== 'http:'
  ) {
    throw new ConfigValidationError('大模型 API 地址只支持 HTTP 或 HTTPS。')
  }

  if (parsedApiBaseUrl.username || parsedApiBaseUrl.password) {
    throw new ConfigValidationError('大模型 API 地址不能包含用户名或密码。')
  }

  if (parsedApiBaseUrl.hash || parsedApiBaseUrl.search) {
    throw new ConfigValidationError(
      '大模型 API 地址不能包含 query 或 fragment。',
    )
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

  if (
    parsedApiBaseUrl.protocol === 'http:' &&
    !loopbackHosts.has(parsedApiBaseUrl.hostname)
  ) {
    throw new ConfigValidationError(
      '大模型 API 地址必须使用 HTTPS，仅本机 loopback 地址允许 HTTP。',
    )
  }

  const normalizedPath = parsedApiBaseUrl.pathname.replace(/\/+$/, '')

  if (normalizedPath.toLowerCase().endsWith('/chat/completions')) {
    throw new ConfigValidationError(
      '大模型 API 地址应填写 API 根地址，而不是完整的 chat/completions 地址。',
    )
  }

  parsedApiBaseUrl.pathname = normalizedPath || '/'
  return parsedApiBaseUrl.toString().replace(/\/$/, '')
}

function normalizePlatformConfig (
  platformConfig: Partial<IAuthinePlatformConfig>,
): IAuthinePlatformConfig {
  return {
    projectDirectory:
      typeof platformConfig.projectDirectory === 'string'
        ? platformConfig.projectDirectory
        : '',
    llmApiKey:
      typeof platformConfig.llmApiKey === 'string'
        ? platformConfig.llmApiKey
        : '',
    llmApiBaseUrl:
      typeof platformConfig.llmApiBaseUrl === 'string'
        ? platformConfig.llmApiBaseUrl
        : '',
    llmModelName:
      typeof platformConfig.llmModelName === 'string'
        ? platformConfig.llmModelName
        : '',
    createdAt:
      typeof platformConfig.createdAt === 'string'
        ? platformConfig.createdAt
        : '',
    updatedAt:
      typeof platformConfig.updatedAt === 'string'
        ? platformConfig.updatedAt
        : '',
  }
}

async function writePlatformConfigFile (
  nextConfig: IAuthinePlatformConfig,
): Promise<void> {
  const configPath = getPlatformConfigPath()
  const serializedConfigContent = `${JSON.stringify(nextConfig, null, 2)}\n`

  try {
    await atomicWriteSecureFile(configPath, serializedConfigContent)
  } catch (error) {
    throw buildStorageAccessError({
      actionLabel: '写入配置文件',
      targetPath: configPath,
      error,
    })
  }
}

async function ensureProjectDirectory (
  projectDirectory: string,
  requireEmpty: boolean,
): Promise<void> {
  try {
    await mkdir(projectDirectory, { recursive: true })
    const directoryStat = await stat(projectDirectory)

    if (!directoryStat.isDirectory()) {
      throw new ConfigValidationError(
        requireEmpty
          ? '项目空目录必须是一个目录，不能是文件。'
          : '项目目录必须是一个目录。',
      )
    }

    await access(projectDirectory, fsConstants.R_OK | fsConstants.W_OK)

    if (!requireEmpty) {
      return
    }

    const directoryEntries = await readdir(projectDirectory)
    const businessEntries = directoryEntries.filter(
      (entryName) => entryName !== '.DS_Store' && entryName !== 'Thumbs.db',
    )

    if (businessEntries.length > 0) {
      throw new ConfigValidationError('项目空目录必须为空目录，请重新选择。')
    }
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error
    }

    throw new ConfigValidationError('项目目录无法访问，请检查路径和读写权限。')
  }
}

function maskApiKey (apiKey: string): string {
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}****`
  }

  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`
}

function isMissingFileError (error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT',
  )
}

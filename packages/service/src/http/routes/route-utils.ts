import { ApiError } from '../../shared/errors/api-error'
import {
  evaluatePlatformConfig,
  inspectPlatformConfig,
  type IAuthinePlatformConfig,
  type IPlatformConfigReadiness,
} from '../../config/config-store'

export async function requirePlatformConfig(
  options: {
    requireChat?: boolean
  } = {},
): Promise<{
  config: IAuthinePlatformConfig
  readiness: IPlatformConfigReadiness
}> {
  const inspection = await inspectPlatformConfig()

  if (inspection.state === 'uninitialized') {
    throw new ApiError({
      code: 'CONFIG_NOT_INITIALIZED',
      status: 400,
      message: '当前平台尚未完成初始化。',
    })
  }

  if (inspection.state === 'corrupted') {
    throw new ApiError({
      code: 'CONFIG_CORRUPTED',
      status: 400,
      message: '平台配置文件已损坏，请先修复配置。',
    })
  }

  const readiness = await evaluatePlatformConfig(inspection.config)

  if (!readiness.workspaceReady) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      status: 400,
      message: '项目目录配置无效，请先修复平台配置。',
    })
  }

  if (options.requireChat && !readiness.chatReady) {
    throw new ApiError({
      code: 'CONFIG_INVALID',
      status: 400,
      message: '模型配置无效，请先修复平台配置。',
    })
  }

  return { config: inspection.config, readiness }
}

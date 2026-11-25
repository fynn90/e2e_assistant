import { Hono } from 'hono'
import { z } from 'zod'
import type {
  IGetConfigResponse,
  IInitializeConfigSuccessResponse,
  IUpdateConfigResponse,
} from '@fynn90-e2e_assistant/types'
import { getPlatformConfigPath } from '../../config/config-path'
import {
  ensurePlatformConfigStorage,
  evaluatePlatformConfig,
  inspectPlatformConfig,
  savePlatformConfig,
  toConfigSummary,
  validateInitializationPayload,
  validateUpdatePayload,
} from '../../config/config-store'
import type { IAppEnv } from '../app-types'
import { parseJsonBody } from '../request-validation'

const CONFIG_BODY_LIMIT = 64 * 1024
const initializationSchema = z
  .object({
    projectDirectory: z.string(),
    llmApiKey: z.string(),
    llmApiBaseUrl: z.string(),
    llmModelName: z.string(),
  })
  .strict()
const updateSchema = z
  .object({
    projectDirectory: z.string(),
    llmApiKey: z.string().optional(),
    llmApiBaseUrl: z.string(),
    llmModelName: z.string(),
  })
  .strict()

export function createConfigRoutes (): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()

  routes.get('/', async (context) => {
    await ensurePlatformConfigStorage()
    const inspection = await inspectPlatformConfig()
    let responseBody: IGetConfigResponse

    if (inspection.state === 'uninitialized') {
      responseBody = {
        success: true,
        data: { state: 'uninitialized', configPath: getPlatformConfigPath() },
      }
    } else if (inspection.state === 'corrupted') {
      responseBody = {
        success: true,
        data: { state: 'corrupted', configPath: getPlatformConfigPath() },
      }
    } else {
      const readiness = await evaluatePlatformConfig(inspection.config)
      responseBody = {
        success: true,
        data: {
          state: 'configured',
          configPath: getPlatformConfigPath(),
          configSummary: toConfigSummary(inspection.config),
          ...readiness,
        },
      }
    }

    return context.json(responseBody)
  })

  routes.post('/init', async (context) => {
    await ensurePlatformConfigStorage()
    const requestPayload = await parseJsonBody(
      context,
      initializationSchema,
      CONFIG_BODY_LIMIT,
    )
    const validatedPayload = await validateInitializationPayload(requestPayload)
    const platformConfig = await savePlatformConfig({
      payload: validatedPayload,
    })
    const readiness = await evaluatePlatformConfig(platformConfig)
    const responseBody: IInitializeConfigSuccessResponse = {
      success: true,
      data: {
        message: '项目初始化完成。',
        configPath: getPlatformConfigPath(),
        configSummary: toConfigSummary(platformConfig),
        ...readiness,
      },
    }

    return context.json(responseBody)
  })

  routes.put('/', async (context) => {
    await ensurePlatformConfigStorage()
    const requestPayload = await parseJsonBody(
      context,
      updateSchema,
      CONFIG_BODY_LIMIT,
    )
    const validatedPayload = await validateUpdatePayload(requestPayload)
    const platformConfig = await savePlatformConfig({
      payload: validatedPayload,
    })
    const readiness = await evaluatePlatformConfig(platformConfig)
    const responseBody: IUpdateConfigResponse = {
      success: true,
      data: {
        message: '平台配置已更新。',
        configPath: getPlatformConfigPath(),
        configSummary: toConfigSummary(platformConfig),
        ...readiness,
      },
    }

    return context.json(responseBody)
  })

  return routes
}

/**
 * 注册 E2E 测试用例读取和保存 HTTP 路由。
 */
import type { Hono } from 'hono'
import type {
  IGetE2ETestCaseResponse,
  IUpdateE2ETestCaseResponse,
} from '@authine-e2e-agent/types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { skillIdSchema, updateE2ETestCaseSchema } from './validation'

const E2E_TEST_CASE_BODY_LIMIT = 1024 * 1024

/**
 * @param routes - Skill Hono router。
 * @param services - 可替换的 E2E 应用服务。
 */
export function registerE2ETestCaseRoutes(
  routes: Hono<IAppEnv>,
  services: IE2ETestCaseApplicationServices,
): void {
  routes.get('/:skillId/e2e-test-case', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const { config } = await requirePlatformConfig()
    const data = await services.get({
      rootDir: config.projectDirectory,
      skillId,
    })
    const response: IGetE2ETestCaseResponse = { success: true, data }
    return context.json(response)
  })

  routes.put('/:skillId/e2e-test-case', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const request = await parseJsonBody(
      context,
      updateE2ETestCaseSchema,
      E2E_TEST_CASE_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const data = await services.update({
      rootDir: config.projectDirectory,
      skillId,
      request,
    })
    const response: IUpdateE2ETestCaseResponse = { success: true, data }
    return context.json(response)
  })
}

function parseSkillId(value: string): string {
  const result = skillIdSchema.safeParse(value)

  if (!result.success) {
    throw new ApiError({
      code: 'INVALID_SKILL_ID',
      status: 400,
      message: 'Skill ID 格式不正确。',
    })
  }

  return result.data
}

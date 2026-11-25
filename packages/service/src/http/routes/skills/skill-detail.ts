import type { Hono } from 'hono'
import { getSkillDetail } from '@authine-e2e-agent/skill-manager'
import type { IGetSkillResponse } from '@authine-e2e-agent/types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { requirePlatformConfig } from '../route-utils'
import { skillIdSchema } from './validation'

export function registerSkillDetailRoutes(routes: Hono<IAppEnv>): void {
  routes.get('/:skillId', async (context) => {
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))

    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    const { config } = await requirePlatformConfig()
    const detail = await getSkillDetail(
      { rootDir: config.projectDirectory },
      skillIdResult.data,
    )
    const responseBody: IGetSkillResponse = { success: true, data: detail }
    return context.json(responseBody)
  })
}

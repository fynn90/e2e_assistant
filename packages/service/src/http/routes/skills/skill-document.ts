/**
 * 注册用户确认后的固定 SKILL.md 保存接口。
 */
import type { Hono } from 'hono'
import type { ISaveSkillDocumentResponse } from '@fynn90-e2e_assistant/types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { saveSkillDocumentSchema, skillIdSchema } from './validation'

const SKILL_DOCUMENT_BODY_LIMIT = 1024 * 1024

/**
 * 注册 SKILL.md 确认保存路由。
 *
 * @param routes - Skill 路由实例。
 * @param services - E2E 应用服务集合。
 * @returns 无返回值。
 * @throws ApiError 当 Skill ID 或请求参数不合法时抛出。
 */
export function registerSkillDocumentRoute (
  routes: Hono<IAppEnv>,
  services: IE2ETestCaseApplicationServices,
): void {
  routes.put('/:skillId/skill-document', async (context) => {
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))
    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }
    const saveSkillDocument = services.saveSkillDocument
    if (!saveSkillDocument) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        status: 500,
        message: 'SKILL.md 保存服务未配置。',
      })
    }

    const request = await parseJsonBody(
      context,
      saveSkillDocumentSchema,
      SKILL_DOCUMENT_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const data = await saveSkillDocument({
      rootDir: config.projectDirectory,
      skillId: skillIdResult.data,
      request,
    })
    const response: ISaveSkillDocumentResponse = { success: true, data }
    return context.json(response)
  })
}

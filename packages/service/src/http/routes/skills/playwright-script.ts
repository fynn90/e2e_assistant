/**
 * 注册用户确认后的固定 `test.spec.ts` 保存路由。
 */
import type { Hono } from 'hono'
import type { ISavePlaywrightScriptResponse } from '@fynn90-e2e_assistant/types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { savePlaywrightScriptSchema, skillIdSchema } from './validation'

/**
 * Playwright 脚本保存请求的最大字节数。
 *
 * 限制候选脚本请求体不超过 1 MiB，避免超大输入占用本地 CLI 服务的内存和
 * JSON 解析资源；实际脚本文件保存时还会在 Skill Manager 层再次检查大小。
 */
const PLAYWRIGHT_SCRIPT_BODY_LIMIT = 1024 * 1024

/**
 * 注册用户确认后的 Playwright 脚本保存接口。
 *
 * 该路由是“生成候选脚本”和“写入 test.spec.ts”之间的确认边界。前端只有在
 * 用户查看生成结果并明确确认后才调用此接口。路由负责校验 Skill ID、限制和
 * 解析请求体、读取当前平台配置，然后将业务处理交给应用服务。应用服务会重新
 * 校验 E2E sourceHash、脚本文件版本和 Playwright 静态安全规则，因此不能通过
 * 直接请求该接口绕过预览阶段的校验。
 *
 * @param routes - Skill Hono 路由实例；函数会注册
 * `PUT /:skillId/playwright-script` 路由。
 * @param services - 可替换的 E2E 应用服务集合，负责代码复验和固定文件原子保存。
 * @returns 无返回值；注册结果直接写入传入的路由实例。
 * @throws ApiError 当 Skill ID 格式不合法时抛出；其他请求或保存错误由下层统一
 * 转换为标准 API 错误响应。
 */
export function registerPlaywrightScriptRoute (
  routes: Hono<IAppEnv>,
  services: IE2ETestCaseApplicationServices,
): void {
  routes.put('/:skillId/playwright-script', async (context) => {
    // 在访问平台配置和文件系统前验证 Skill 身份，避免无效 ID 进入应用层。
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))

    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    // 使用共享 Zod Schema 和独立大小上限解析候选脚本保存请求。
    const request = await parseJsonBody(
      context,
      savePlaywrightScriptSchema,
      PLAYWRIGHT_SCRIPT_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    // 应用服务会重新校验 sourceHash、expectedScriptVersion 和脚本安全性后再持久化。
    const data = await services.saveScript({
      rootDir: config.projectDirectory,
      skillId: skillIdResult.data,
      request,
    })
    const response: ISavePlaywrightScriptResponse = { success: true, data }
    return context.json(response)
  })
}

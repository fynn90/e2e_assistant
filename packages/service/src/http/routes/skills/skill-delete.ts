/**
 * 提供删除 Skill 的 HTTP 路由：彻底清理文件层（不可变目录 + 全局索引）与数据库层关联数据。
 *
 * v17：删除逻辑抽到 `ISkillLifecycleService`（路由与工作台的用例删除提案共用
 * 同一段实现），并**补上任务冲突检查**（L2c）——此前三层都没有该检查，
 * 删掉正在执行的用例会 `rm -rf` 掉浏览器仍在使用的目录（F13/F28）。
 */

import type { Hono } from 'hono'
import type { IDeleteSkillResponse } from '@charlie_deng/e2e-assistant-types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { requirePlatformConfig } from '../route-utils'
import { skillIdSchema } from './validation'
import type { ISkillLifecycleService } from '../../../application/agent-workbench/skill-lifecycle-service'

/**
 * 注册删除 Skill 的路由。
 *
 * @param routes - 挂载到 /api/skills 下的路由组。
 * @param skillLifecycle - 共享的删除实现（含 L2c 的任务检查）。
 * @returns 无返回值。
 * @throws 不在注册阶段抛出异常。
 */
export function registerSkillDeleteRoute (
  routes: Hono<IAppEnv>,
  skillLifecycle: ISkillLifecycleService,
  taskRegistry: Parameters<
    ISkillLifecycleService['deleteCase']
  >[0]['taskRegistry'],
): void {
  routes.delete('/:skillId', async (context) => {
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))
    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    const skillId = skillIdResult.data
    const { config } = await requirePlatformConfig()

    // 文件层 + 数据库层：走共享实现（含「有任务运行中则拒绝」的检查）。
    await skillLifecycle.deleteCase({
      rootDir: config.projectDirectory,
      skillId,
      taskRegistry,
    })

    const responseBody: IDeleteSkillResponse = {
      success: true,
      data: { skillId },
    }
    return context.json(responseBody)
  })
}

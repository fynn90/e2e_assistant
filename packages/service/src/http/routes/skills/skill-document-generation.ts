/** 注册 Agent 写入并校验 SKILL.md 的 SSE 生成接口。 */
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { TSkillDocumentGenerationEvent } from '@charlie_deng/e2e-assistant-types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type { IAppEnv } from '../../app-types'
import { toApiError } from '../../error-mapper'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { generateSkillDocumentSchema, skillIdSchema } from './validation'

const SKILL_DOCUMENT_GENERATION_BODY_LIMIT = 64 * 1024

/**
 * 注册 Agent 写入并校验 SKILL.md 的生成 SSE 路由。
 *
 * @param routes - Skill 路由实例。
 * @param services - E2E 应用服务集合。
 * @returns 无返回值。
 * @throws ApiError 当请求身份、参数或平台配置不合法时抛出。
 */
export function registerSkillDocumentGenerationRoute (
  routes: Hono<IAppEnv>,
  services: IE2ETestCaseApplicationServices,
): void {
  routes.post('/:skillId/skill-generation', async (context) => {
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))
    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    const generateSkillDocument = services.generateSkillDocument
    if (!generateSkillDocument) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        status: 500,
        message: 'SKILL.md 生成服务未配置。',
      })
    }

    const request = await parseJsonBody(
      context,
      generateSkillDocumentSchema,
      SKILL_DOCUMENT_GENERATION_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig({ requireChat: true })
    const abortController = new AbortController()
    const abortFromRequest = (): void => abortController.abort()
    context.req.raw.signal.addEventListener('abort', abortFromRequest, {
      once: true,
    })

    // 会话 ID 在建立 SSE 流之前生成：start 事件需要先行下发，
    // 前端据此订阅工作事件流（/api/agent/...），无需等待生成完成。
    // 会话种类由运行时以 kind: 'generation' 声明，不依赖 ID 形状。
    const sessionId = randomUUID()

    context.header('Cache-Control', 'no-cache, no-transform')
    context.header('Connection', 'keep-alive')
    context.header('X-Accel-Buffering', 'no')

    return streamSSE(context, async (stream) => {
      stream.onAbort(() => abortController.abort())
      let writeChain = Promise.resolve()
      try {
        const startEvent: TSkillDocumentGenerationEvent = {
          type: 'start',
          requestId: context.get('requestId'),
          sessionId,
        }
        await stream.writeSSE({
          event: 'start',
          data: JSON.stringify(startEvent),
        })
        const data = await generateSkillDocument({
          config,
          skillId: skillIdResult.data,
          sessionId,
          request,
          signal: abortController.signal,
          onProgress: (stage) => {
            const event: TSkillDocumentGenerationEvent = {
              type: 'progress',
              stage,
            }
            writeChain = writeChain.then(() =>
              stream.writeSSE({
                event: 'progress',
                data: JSON.stringify(event),
              }),
            )
          },
        })
        await writeChain
        const completeEvent: TSkillDocumentGenerationEvent = {
          type: 'complete',
          data,
        }
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify(completeEvent),
        })
      } catch (error) {
        await writeChain.catch(() => undefined)
        if (!abortController.signal.aborted) {
          const apiError = toApiError(error)
          const errorEvent: TSkillDocumentGenerationEvent = {
            type: 'error',
            code: apiError.code,
            message: apiError.message,
          }
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify(errorEvent),
          })
        }
      } finally {
        abortController.abort()
        context.req.raw.signal.removeEventListener('abort', abortFromRequest)
      }
    })
  })
}

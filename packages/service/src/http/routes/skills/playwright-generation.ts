/**
 * 注册生成候选代码、不写正式脚本的 Playwright SSE 路由。
 *
 * v7 起本路由承担完整的生成任务编排：
 *   - 在建立 SSE 流前完成请求校验，并生成 Agent 会话 ID 先行下发，
 *     使全局侧边栏 Chat 能立即订阅工作内容（PRD 7.6 / AC-09）；
 *   - 通过组合根注入的浏览器宿主完成 Chromium 检查、浏览器会话创建与释放；
 *   - 通过生成任务注册表保证同一 Skill 同一时间只有一个生成任务（PRD 4.3）；
 *   - 无论成功、失败还是取消，都在终态释放浏览器资源（PRD 4.2 / 15.5）。
 */

import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type {
  IGeneratePlaywrightResponse,
  TPlaywrightGenerationEvent,
} from '@authine-e2e-agent/types'
import type { IE2ETestCaseApplicationServices } from '../../../application/e2e-test-case/application-types'
import type {
  IGenerationBrowserHost,
  IGenerationTaskRegistry,
} from '../../../generation-runtime/index'
import type { IAppEnv } from '../../app-types'
import { toApiError } from '../../error-mapper'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { generatePlaywrightSchema, skillIdSchema } from './validation'

/**
 * Playwright 生成请求体的最大字节数。
 *
 * 生成请求只包含用例文件版本和脚本文件版本，不携带完整用例或候选代码，因此
 * 使用 64 KiB 上限即可满足正常调用，并能提前拒绝异常超大请求。
 */
const GENERATION_BODY_LIMIT = 64 * 1024

/**
 * 注册 Playwright 候选脚本的 SSE 生成接口。
 *
 * 该接口读取当前权威用例与 SKILL.md，由 Agent 核对目标页面后生成候选脚本，
 * 并返回经过静态校验的候选代码。**不会创建或修改 `test.spec.ts`**：
 * 只有用户随后调用脚本确认保存接口，候选代码才会写入磁盘。
 *
 * @param routes - Skill Hono 路由实例；函数会注册
 * `POST /:skillId/playwright-generation` 路由。
 * @param services - 可替换的 E2E 应用服务集合，负责读取用例、调用模型和校验代码。
 * @param runtime - 生成任务运行时：浏览器宿主与并发注册表。
 * @returns 无返回值；注册结果直接写入传入的路由实例。
 * @throws ApiError 当 Skill ID、请求体、模型配置或并发状态不合法时抛出，
 * 并由全局错误处理中间件转换为标准 JSON 错误响应。
 */
export function registerPlaywrightGenerationRoute(
  routes: Hono<IAppEnv>,
  services: IE2ETestCaseApplicationServices,
  runtime: {
    browserHost: IGenerationBrowserHost
    taskRegistry: IGenerationTaskRegistry
  },
): void {
  routes.post('/:skillId/playwright-generation', async (context) => {
    // 在读取配置或建立长连接前校验 Skill ID，确保错误通过普通 JSON 响应返回。
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))

    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    // SSE 建立前完成请求 Schema、大小和模型配置校验，避免流内混入 HTTP 错误响应。
    const request = await parseJsonBody(
      context,
      generatePlaywrightSchema,
      GENERATION_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig({ requireChat: true })
    const skillId = skillIdResult.data

    // 生成前环境检查：Chromium 不可用时先自动安装，安装失败不请求模型（AC-01）。
    await runtime.browserHost.ensureChromium()

    // 并发排他：同一 Skill 只允许一个生成任务，避免争用本机资源（PRD 4.3）。
    // 会话 ID 在占用名额前生成：注册表需要它来标识本次任务。
    const sessionId = randomUUID()
    const lease = runtime.taskRegistry.acquire(skillId, sessionId)

    // 使用独立控制器统一接收 HTTP 请求终止和 SSE 流终止信号。
    const abortController = new AbortController()
    const abortFromRequest = (): void => abortController.abort()
    context.req.raw.signal.addEventListener('abort', abortFromRequest, {
      once: true,
    })

    if (context.req.raw.signal.aborted) {
      abortController.abort()
    }

    // 禁止浏览器、代理和反向代理缓存或缓冲 SSE，保证进度事件及时到达客户端。
    context.header('Cache-Control', 'no-cache, no-transform')
    context.header('Connection', 'keep-alive')
    context.header('X-Accel-Buffering', 'no')

    return streamSSE(context, async (stream) => {
      stream.onAbort(() => abortController.abort())
      // Progress 回调是同步接口，使用 Promise 链将异步 SSE 写入严格串行化，避免事件乱序。
      let writeChain = Promise.resolve()

      try {
        // start 事件携带会话 ID：前端据此自动展开全局侧边栏并订阅工作事件流。
        const startEvent: TPlaywrightGenerationEvent = {
          type: 'start',
          requestId: context.get('requestId'),
          sessionId,
        }
        await stream.writeSSE({
          event: 'start',
          data: JSON.stringify(startEvent),
        })
        const data = await services.generate({
          config,
          skillId,
          sessionId,
          request,
          signal: abortController.signal,
          // 每个生成阶段都排入 writeChain，确保 progress 顺序与应用服务回调顺序一致。
          onProgress: (stage) => {
            if (stage === 'completed') {
              return
            }

            const event: TPlaywrightGenerationEvent = {
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
          // 页面核对开始前登记浏览器宿主：Agent 的 browser_* 工具据此获得会话。
          registerBrowserHost: (hostContext) =>
            runtime.browserHost.acquire({
              sessionId: hostContext.sessionId,
              headed: hostContext.headed,
              baseUrl: hostContext.baseUrl,
              signal: hostContext.signal,
              ...(hostContext.skillRoot
                ? { skillRoot: hostContext.skillRoot }
                : {}),
              ...(hostContext.skillId ? { skillId: hostContext.skillId } : {}),
              // v20：工作区根目录，使宿主能构造凭据解析器读取 env.json。
              rootDir: config.projectDirectory,
            }),
        })
        // 等待全部 progress 写入完成后再发送唯一的 complete 终态事件。
        await writeChain
        const completeEvent: TPlaywrightGenerationEvent = {
          type: 'complete',
          data,
        }
        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify(completeEvent),
        })
      } catch (error) {
        // 先等待已经排队的 progress 写入结束，防止 error 事件越过前序进度事件。
        await writeChain.catch(() => undefined)

        // 客户端主动断开时不再尝试向已关闭的 SSE 流发送 error 事件。
        if (!abortController.signal.aborted) {
          const apiError = toApiError(error)
          const errorEvent: TPlaywrightGenerationEvent = {
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
        // 终态清理顺序：先释放浏览器（可能占用 temp 文件），再释放名额，
        // 最后终止下游工作。AskUserQuestion 宿主由工作运行时在 releaseSession 时
        // 注销，本路由不再介入。清理失败不改变已经上报的任务结果。
        await runtime.browserHost.release(sessionId).catch(() => undefined)
        lease.release()
        abortController.abort()
        context.req.raw.signal.removeEventListener('abort', abortFromRequest)
      }
    })
  })
}

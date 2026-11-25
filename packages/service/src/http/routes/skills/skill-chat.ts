import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type {
  ISkillChatRuntime,
  ISkillChatRuntimeOptions,
} from '@charlie_deng/e2e-assistant-agent'
import {
  getSkillDetail,
  listSkillFiles,
  readSkillFile,
  resolveSkill,
} from '@charlie_deng/e2e-assistant-skill-manager'
import type { TSkillChatEvent } from '@charlie_deng/e2e-assistant-types'
import type { IAppEnv } from '../../app-types'
import { toApiError } from '../../error-mapper'
import { ApiError } from '../../../shared/errors/api-error'
import type {
  ChatConcurrencyGate,
  IChatConcurrencyLease,
} from '../../chat-concurrency'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import { skillChatLimits, skillChatSchema, skillIdSchema } from './validation'

/**
 * Chat 请求体的最大字节数。
 *
 * 由字数上限推导而非独立硬编码：上限判定按**字符数**，而请求体的限制是**字节数**，
 * 中文在 UTF-8 下每字符最多 3 字节，因此必须按 3 倍留出余量再叠加 JSON 信封开销。
 * 若沿用 256KB，一个 240k 字符的中文历史（约 720KB）会在到达业务校验之前被 413 拒收。
 */
const CHAT_BODY_LIMIT = skillChatLimits.maxHistoryCharacters * 3 + 64 * 1024

export type TSkillChatRuntimeFactory = (
  options: ISkillChatRuntimeOptions,
) => ISkillChatRuntime

export function registerSkillChatRoute (
  routes: Hono<IAppEnv>,
  dependencies: {
    chatRuntimeFactory: TSkillChatRuntimeFactory
    chatConcurrencyGate: ChatConcurrencyGate
  },
): void {
  routes.post('/:skillId/chat', async (context) => {
    const skillIdResult = skillIdSchema.safeParse(context.req.param('skillId'))

    if (!skillIdResult.success) {
      throw new ApiError({
        code: 'INVALID_SKILL_ID',
        status: 400,
        message: 'Skill ID 格式不正确。',
      })
    }

    const abortController = new AbortController()
    const abortFromRequest = () => abortController.abort()
    context.req.raw.signal.addEventListener('abort', abortFromRequest, {
      once: true,
    })

    if (context.req.raw.signal.aborted) {
      abortController.abort()
    }

    let lease: IChatConcurrencyLease | null = null
    // runtime 提升到 try 块外，便于 open 抛错或 SSE 中断时在 finally 中显式释放。
    let runtime: ISkillChatRuntime | undefined
    let preparedStream: Awaited<ReturnType<ISkillChatRuntime['open']>>

    try {
      const request = await parseJsonBody(
        context,
        skillChatSchema,
        CHAT_BODY_LIMIT,
      )
      const { config } = await requirePlatformConfig({ requireChat: true })
      lease = dependencies.chatConcurrencyGate.acquire(skillIdResult.data)

      if (abortController.signal.aborted) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: 'Chat 请求已取消。',
        })
      }

      const storageOptions = { rootDir: config.projectDirectory }
      const [skill, fileTree, resolvedSkill] = await Promise.all([
        getSkillDetail(storageOptions, skillIdResult.data),
        listSkillFiles(storageOptions, skillIdResult.data),
        resolveSkill(storageOptions, skillIdResult.data),
      ])
      const currentFile = request.currentFile
        ? await readSkillFile(
          storageOptions,
          skillIdResult.data,
          request.currentFile.relativePath,
        )
        : undefined

      if (currentFile && currentFile.version !== request.currentFile?.version) {
        throw new ApiError({
          code: 'FILE_VERSION_CONFLICT',
          status: 409,
          message: '当前文件已发生变化，请刷新后重试 Chat。',
        })
      }

      if (abortController.signal.aborted) {
        throw new ApiError({
          code: 'INVALID_REQUEST',
          status: 400,
          message: 'Chat 请求已取消。',
        })
      }

      runtime = dependencies.chatRuntimeFactory({
        workspace: config.projectDirectory,
        apiKey: config.llmApiKey,
        apiBaseUrl: config.llmApiBaseUrl,
        model: config.llmModelName,
        signal: abortController.signal,
        // v11 A1：文件工具绑定当前 Skill 目录。
        skillRoot: resolvedSkill.skillRoot,
      })
      preparedStream = await runtime.open({
        skill,
        fileTreeSummary: JSON.stringify(fileTree),
        currentFile: currentFile
          ? {
            relativePath: currentFile.relativePath,
            version: currentFile.version,
            content: currentFile.content,
          }
          : undefined,
        messages: request.messages,
      })
    } catch (error) {
      await runtime?.close()
      lease?.release()
      context.req.raw.signal.removeEventListener('abort', abortFromRequest)
      throw error
    }

    context.header('Cache-Control', 'no-cache, no-transform')
    context.header('Connection', 'keep-alive')
    context.header('X-Accel-Buffering', 'no')

    return streamSSE(context, async (stream) => {
      stream.onAbort(() => abortController.abort())

      try {
        const startEvent: TSkillChatEvent = {
          type: 'start',
          requestId: context.get('requestId'),
          sessionId: preparedStream.sessionId,
          currentFile: preparedStream.currentFile,
          contextWarnings: preparedStream.contextWarnings,
          historyTruncated: preparedStream.historyTruncated,
          currentFileTruncated: preparedStream.currentFileTruncated,
        }
        await stream.writeSSE({
          event: 'start',
          data: JSON.stringify(startEvent),
        })

        for await (const event of preparedStream.events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          const apiError = toApiError(error)
          const errorEvent: TSkillChatEvent = {
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
        // 事件流由 runtime 内部的 withCleanup 在迭代结束时释放；
        // 这里兜底关闭，防止 open 之后 SSE 流未消费就中断的泄漏。
        await runtime?.close()
        context.req.raw.signal.removeEventListener('abort', abortFromRequest)
        lease?.release()
      }
    })
  })
}

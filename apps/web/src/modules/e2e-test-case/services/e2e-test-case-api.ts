/**
 * 封装 E2E 用例读取、保存、Playwright SSE 生成和脚本确认保存 API。
 */
import type {
  IGeneratePlaywrightRequest,
  IGetE2ETestCaseResponse,
  ISavePlaywrightScriptRequest,
  ISavePlaywrightScriptResponse,
  TPlaywrightGenerationEvent,
  IUpdateE2ETestCaseRequest,
  IUpdateE2ETestCaseResponse,
} from '@charlie_deng/e2e-assistant-types'
import { playwrightGenerationEventSchema } from '@charlie_deng/e2e-assistant-types'
import { ApiClientError, requestJson } from '../../../services/http-client'
import { consumeSseResponse } from '../../../services/sse'

export function fetchE2ETestCase (skillId: string, signal?: AbortSignal) {
  return requestJson<IGetE2ETestCaseResponse>({
    path: `/api/skills/${encodeURIComponent(skillId)}/e2e-test-case`,
    signal,
  })
}

export function updateE2ETestCase (
  skillId: string,
  request: IUpdateE2ETestCaseRequest,
  signal?: AbortSignal,
) {
  return requestJson<IUpdateE2ETestCaseResponse>({
    path: `/api/skills/${encodeURIComponent(skillId)}/e2e-test-case`,
    method: 'PUT',
    body: request,
    signal,
  })
}

export function savePlaywrightScript (
  skillId: string,
  request: ISavePlaywrightScriptRequest,
  signal?: AbortSignal,
) {
  return requestJson<ISavePlaywrightScriptResponse>({
    path: `/api/skills/${encodeURIComponent(skillId)}/playwright-script`,
    method: 'PUT',
    body: request,
    signal,
  })
}

/**
 * 发起 Playwright 生成并消费阶段/完成/错误 SSE 事件。
 *
 * @param options - Skill、期望版本、取消信号和事件回调。
 */
export async function streamPlaywrightGeneration (options: {
  skillId: string
  request: IGeneratePlaywrightRequest
  signal: AbortSignal
  onEvent: (event: TPlaywrightGenerationEvent) => void
}): Promise<void> {
  let response: Response

  try {
    response = await fetch(
      `/api/skills/${encodeURIComponent(options.skillId)}/playwright-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.request),
        signal: options.signal,
        credentials: 'same-origin',
      },
    )
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiClientError({ message: '生成已停止。', kind: 'aborted' })
    }

    throw new ApiClientError({
      message: '无法连接本地服务，请确认 CLI 服务正在运行。',
      kind: 'network',
    })
  }

  try {
    await consumeSseResponse(response, (frame) => {
      let input: unknown

      try {
        input = JSON.parse(frame.data)
      } catch {
        throw new ApiClientError({
          message: '生成事件不是合法 JSON。',
          kind: 'protocol',
        })
      }

      const parsed = playwrightGenerationEventSchema.safeParse(input)

      if (!parsed.success || frame.event !== parsed.data.type) {
        throw new ApiClientError({
          message: '生成事件格式不正确。',
          kind: 'protocol',
        })
      }

      options.onEvent(parsed.data)
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw new ApiClientError({ message: '生成已停止。', kind: 'aborted' })
    }

    throw error
  }
}

function isAbortError (error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError',
  )
}

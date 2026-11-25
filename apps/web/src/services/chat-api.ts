import type {
  IApiErrorResponse,
  ICreateSkillChatRequest,
  TSkillChatEvent,
} from '@charlie_deng/e2e-assistant-types'
import { ApiClientError } from './http-client'

export async function streamSkillChat (options: {
  skillId: string
  request: ICreateSkillChatRequest
  signal: AbortSignal
  onEvent: (event: TSkillChatEvent) => void
}): Promise<void> {
  let response: Response

  try {
    response = await fetch(
      `/api/skills/${encodeURIComponent(options.skillId)}/chat`,
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
      throw new ApiClientError({ message: '请求已停止。', kind: 'aborted' })
    }

    throw new ApiClientError({
      message: '无法连接本地服务，请确认 CLI 服务正在运行。',
      kind: 'network',
    })
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  if (!response.ok) {
    const errorBody = contentType.includes('application/json')
      ? ((await response.json()) as Partial<IApiErrorResponse>)
      : undefined
    throw new ApiClientError({
      message: errorBody?.message || 'Chat 请求失败。',
      status: response.status,
      code: errorBody?.code,
      requestId: errorBody?.requestId,
    })
  }

  if (!contentType.includes('text/event-stream') || !response.body) {
    throw new ApiClientError({
      message: '本地服务未返回有效的流式响应。',
      status: response.status,
      kind: 'protocol',
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const result = await reader.read()
      buffer += decoder.decode(result.value ?? new Uint8Array(), {
        stream: !result.done,
      })
      buffer = consumeSseFrames(buffer, options.onEvent, result.done)

      if (result.done) {
        break
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)

    if (isAbortError(error) || options.signal.aborted) {
      throw new ApiClientError({ message: '请求已停止。', kind: 'aborted' })
    }

    throw error
  } finally {
    reader.releaseLock()
  }
}

export function consumeSseFrames (
  input: string,
  onEvent: (event: TSkillChatEvent) => void,
  flush = false,
): string {
  const normalizedInput = input.replace(/\r\n/g, '\n')
  const frames = normalizedInput.split('\n\n')
  const remainder = flush ? '' : (frames.pop() ?? '')

  for (const frame of frames) {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())

    if (dataLines.length === 0) {
      continue
    }

    const parsedEvent = JSON.parse(dataLines.join('\n')) as TSkillChatEvent
    onEvent(parsedEvent)
  }

  if (flush && frames.length === 0 && normalizedInput.trim()) {
    const data = normalizedInput
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')

    if (data) {
      onEvent(JSON.parse(data) as TSkillChatEvent)
    }
  }

  return remainder
}

function isAbortError (error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError',
  )
}

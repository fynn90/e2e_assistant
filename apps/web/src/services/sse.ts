/**
 * 提供与业务事件类型解耦的 SSE frame 解析、错误信封保留和 fetch 消费能力。
 */
import { apiErrorResponseSchema } from '@charlie_deng/e2e-assistant-types'
import { ApiClientError } from './http-client'

export interface ISseFrame {
  event: string
  data: string
}

/**
 * 持续解析 fetch Response body 中的 SSE frame。
 *
 * @param response - SSE 或非 2xx JSON 错误响应。
 * @param onFrame - 每个完整 SSE frame 的同步处理函数。
 */
export async function consumeSseResponse (
  response: Response,
  onFrame: (frame: ISseFrame) => void,
): Promise<void> {
  if (!response.ok) {
    throw await createResponseError(response)
  }

  if (
    !(response.headers.get('content-type') ?? '')
      .toLowerCase()
      .includes('text/event-stream')
  ) {
    throw new ApiClientError({
      message: '本地服务未返回 SSE 响应。',
      status: response.status,
      kind: 'protocol',
    })
  }

  if (!response.body) {
    throw new ApiClientError({
      message: '流式响应缺少内容。',
      kind: 'protocol',
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pendingCarriageReturn = false
  const appendDecodedText = (text: string, final = false): void => {
    let combined = `${pendingCarriageReturn ? '\r' : ''}${text}`
    pendingCarriageReturn = false

    if (!final && combined.endsWith('\r')) {
      pendingCarriageReturn = true
      combined = combined.slice(0, -1)
    }

    buffer += combined.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  }
  const drainFrames = (flush = false): void => {
    let boundary = buffer.indexOf('\n\n')

    while (boundary >= 0) {
      const rawFrame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const frame = parseFrame(rawFrame)

      if (frame) {
        onFrame(frame)
      }

      boundary = buffer.indexOf('\n\n')
    }

    if (flush && buffer.length > 0) {
      const frame = parseFrame(buffer)
      buffer = ''

      if (frame) {
        onFrame(frame)
      }
    }
  }

  try {
    while (true) {
      const result = await reader.read()

      if (result.done) {
        appendDecodedText(decoder.decode(), true)
        drainFrames(true)
        break
      }

      appendDecodedText(decoder.decode(result.value, { stream: true }))
      drainFrames()
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw new ApiClientError({ message: '请求已停止。', kind: 'aborted' })
    }

    if (error instanceof ApiClientError) {
      throw error
    }

    throw new ApiClientError({
      message: '读取流式响应失败。',
      status: response.status,
      kind: 'network',
    })
  } finally {
    reader.releaseLock()
  }
}

async function createResponseError (
  response: Response,
): Promise<ApiClientError> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()

  if (contentType.includes('application/json')) {
    try {
      const parsed = apiErrorResponseSchema.safeParse(await response.json())

      if (parsed.success) {
        return new ApiClientError({
          message: parsed.data.message,
          status: response.status,
          code: parsed.data.code,
          requestId: parsed.data.requestId,
          kind: 'api',
          ...(Array.isArray(parsed.data.issues)
            ? { issues: parsed.data.issues }
            : {}),
        })
      }
    } catch {
      // Fall through to the stable protocol message below.
    }
  }

  return new ApiClientError({
    message: '流式请求失败。',
    status: response.status,
    kind:
      contentType && !contentType.includes('application/json')
        ? 'protocol'
        : 'api',
  })
}

function parseFrame (rawFrame: string): ISseFrame | null {
  let event = 'message'
  const dataLines: string[] = []

  for (const line of rawFrame.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue
    }

    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  return dataLines.length > 0 ? { event, data: dataLines.join('\n') } : null
}

function isAbortError (error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError',
  )
}

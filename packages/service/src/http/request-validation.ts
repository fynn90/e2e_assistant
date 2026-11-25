import type { Context } from 'hono'
import type { ZodType } from 'zod'
import { ApiError } from '../shared/errors/api-error'

export async function parseJsonBody<T>(
  context: Context,
  schema: ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const contentLength = Number(context.req.header('content-length') ?? 0)

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw requestTooLargeError()
  }

  const bodyStream = context.req.raw.body

  if (!bodyStream) {
    throw invalidRequestError()
  }

  const reader = bodyStream.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const readResult = await reader.read()

      if (readResult.done) {
        break
      }

      totalBytes += readResult.value.byteLength

      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw requestTooLargeError()
      }

      chunks.push(readResult.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bodyBytes = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let parsedBody: unknown

  try {
    parsedBody = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes),
    )
  } catch {
    throw invalidRequestError()
  }

  const parsedResult = schema.safeParse(parsedBody)

  if (!parsedResult.success) {
    throw invalidRequestError()
  }

  return parsedResult.data
}

function invalidRequestError(): ApiError {
  return new ApiError({
    code: 'INVALID_REQUEST',
    status: 400,
    message: '请求参数不正确。',
  })
}

function requestTooLargeError(): ApiError {
  return new ApiError({
    code: 'REQUEST_TOO_LARGE',
    status: 413,
    message: '请求内容超过允许大小。',
  })
}

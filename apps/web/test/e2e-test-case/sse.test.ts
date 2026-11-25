/**
 * 验证 SSE chunk 边界、尾帧、错误信封和取消映射。
 */
import { describe, expect, it, vi } from 'vitest'
import { consumeSseResponse } from '../../src/services/sse'
import { streamPlaywrightGeneration } from '../../src/modules/e2e-test-case/services/e2e-test-case-api'

const encoder = new TextEncoder()

function createStreamResponse(chunks: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    },
  )
}

describe('SSE response consumer', () => {
  it('handles split CRLF, comments, multiline data and a trailing frame', async () => {
    const frames: Array<{ event: string; data: string }> = []
    const response = createStreamResponse([
      ': heartbeat\r',
      '\nevent: progress\r',
      '\ndata: first\r\ndata: second\r',
      '\n\r\nevent: complete\ndata: done',
    ])

    await consumeSseResponse(response, (frame) => frames.push(frame))

    expect(frames).toEqual([
      { event: 'progress', data: 'first\nsecond' },
      { event: 'complete', data: 'done' },
    ])
  })

  it('preserves non-2xx JSON API error details', async () => {
    const response = new Response(
      JSON.stringify({
        success: false,
        code: 'LLM_AUTH_FAILED',
        message: '鉴权失败',
        requestId: 'request-1',
      }),
      {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      },
    )

    await expect(
      consumeSseResponse(response, () => undefined),
    ).rejects.toMatchObject({
      status: 403,
      code: 'LLM_AUTH_FAILED',
      requestId: 'request-1',
      message: '鉴权失败',
    })
  })

  it('maps body read aborts to an aborted client error', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new DOMException('aborted', 'AbortError')
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )

    await expect(
      consumeSseResponse(response, () => undefined),
    ).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('runtime-validates payloads and the SSE event name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createStreamResponse([
          `event: progress\ndata: ${JSON.stringify({ type: 'complete', data: {} })}\n\n`,
        ]),
      ),
    )

    await expect(
      streamPlaywrightGeneration({
        skillId: 'abc123def',
        request: {
          expectedTestCaseFileVersion: 'a'.repeat(64),
          expectedScriptVersion: null,
        },
        signal: new AbortController().signal,
        onEvent: () => undefined,
      }),
    ).rejects.toMatchObject({ kind: 'protocol' })
    vi.unstubAllGlobals()
  })
})

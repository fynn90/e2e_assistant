/**
 * Skill Chat SSE 帧解析测试。
 *
 * 验证文本与工具调用事件即使跨网络 chunk 到达，也能按共享协议传递给页面状态层。
 */

import { describe, expect, it } from 'vitest'
import type { TSkillChatEvent } from '@charlie_deng/e2e-assistant-types'
import { consumeSseFrames } from '../src/services/chat-api'

describe('SSE parser', () => {
  it('keeps partial frames and emits complete events', () => {
    const events: TSkillChatEvent[] = []
    let buffer = consumeSseFrames(
      'event: delta\r\ndata: {"type":"delta","text":"hel',
      (event) => events.push(event),
    )
    expect(events).toEqual([])

    buffer = consumeSseFrames(
      `${buffer}lo"}\r\n\r\nevent: complete\ndata: {"type":"complete"}\n\n`,
      (event) => events.push(event),
    )
    expect(buffer).toBe('')
    expect(events).toEqual([
      { type: 'delta', text: 'hello' },
      { type: 'complete' },
    ])
  })

  it('parses a tool event split across SSE chunks', () => {
    const events: TSkillChatEvent[] = []
    let buffer = consumeSseFrames(
      'event: tool\ndata: {"type":"tool","phase":"start","tool":{"toolCallId":"call-',
      (event) => events.push(event),
    )

    buffer = consumeSseFrames(
      `${buffer}1","toolName":"read","sequence":0,"status":"running","startedAt":1,"arguments":{"path":"a.txt"},"argumentsTruncated":false}}\n\n`,
      (event) => events.push(event),
    )

    expect(buffer).toBe('')
    expect(events).toEqual([
      {
        type: 'tool',
        phase: 'start',
        tool: {
          toolCallId: 'call-1',
          toolName: 'read',
          sequence: 0,
          status: 'running',
          startedAt: 1,
          arguments: { path: 'a.txt' },
          argumentsTruncated: false,
        },
      },
    ])
  })
})

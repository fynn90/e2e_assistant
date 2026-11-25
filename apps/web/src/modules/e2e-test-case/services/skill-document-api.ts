/**
 * 封装 SKILL.md 生成候选和用户确认保存 API。
 */
import type {
  IGenerateSkillDocumentRequest,
  ISaveSkillDocumentRequest,
  ISaveSkillDocumentResponse,
  TSkillDocumentGenerationEvent,
} from '@charlie_deng/e2e-assistant-types'
import { ApiClientError, requestJson } from '../../../services/http-client'
import { consumeSseResponse } from '../../../services/sse'
import { skillDocumentGenerationEventSchema } from '@charlie_deng/e2e-assistant-types'

/**
 * 保存已审阅的 SKILL.md。
 *
 * @param skillId - 当前 Skill ID。
 * @param request - 候选正文、来源哈希和期望文件版本。
 * @param signal - 可选取消信号。
 * @returns 保存后的文件版本和生成元数据。
 * @throws ApiClientError 当本地服务返回错误时抛出。
 */
export function saveSkillDocument (
  skillId: string,
  request: ISaveSkillDocumentRequest,
  signal?: AbortSignal,
) {
  return requestJson<ISaveSkillDocumentResponse>({
    path: `/api/skills/${encodeURIComponent(skillId)}/skill-document`,
    method: 'PUT',
    body: request,
    signal,
  })
}

/**
 * 发起 SKILL.md 候选生成并消费 SSE 事件。
 *
 * @param options - Skill ID、版本条件、取消信号和事件回调。
 * @returns SSE 消费完成后无返回值。
 * @throws ApiClientError 当网络、协议或服务端事件不合法时抛出。
 */
export async function streamSkillDocumentGeneration (options: {
  skillId: string
  request: IGenerateSkillDocumentRequest
  signal: AbortSignal
  onEvent: (event: TSkillDocumentGenerationEvent) => void
}): Promise<void> {
  let response: Response
  try {
    response = await fetch(
      `/api/skills/${encodeURIComponent(options.skillId)}/skill-generation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.request),
        signal: options.signal,
        credentials: 'same-origin',
      },
    )
  } catch (error) {
    if (options.signal.aborted)
      throw new ApiClientError({ message: '生成已停止。', kind: 'aborted' })
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
      const parsed = skillDocumentGenerationEventSchema.safeParse(input)
      if (!parsed.success || frame.event !== parsed.data.type) {
        throw new ApiClientError({
          message: 'SKILL.md 生成事件格式不正确。',
          kind: 'protocol',
        })
      }
      options.onEvent(parsed.data)
    })
  } catch (error) {
    if (options.signal.aborted)
      throw new ApiClientError({ message: '生成已停止。', kind: 'aborted' })
    throw error
  }
}

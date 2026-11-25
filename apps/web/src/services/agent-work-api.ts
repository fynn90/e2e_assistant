/**
 * Agent 工作通道 API 客户端：会话管理、历史恢复与 SSE 实时事件订阅。
 *
 * 基于统一 http-client 与 sse 解析器实现；SSE 订阅带类型化事件分发、
 * 指数退避自动重连（重连携带 afterSeq 无缝补齐断线缺口）。
 */
import type {
  IAgentSessionSummary,
  IAgentWorkBlock,
  TAgentClientEvent,
  TAgentInteractionAnswer,
} from '@authine-e2e-agent/types'
import { requestJson, ApiClientError } from './http-client'
import { consumeSseResponse } from './sse'

/** 会话列表响应。 */
interface IListSessionsResponse {
  success: true
  data: IAgentSessionSummary[]
}

/** 创建会话 / 发送消息响应。 */
interface ISessionIdResponse {
  success: true
  data: { sessionId: string }
}

/** 历史工作块响应。 */
interface IBlocksResponse {
  success: true
  data: { blocks: IAgentWorkBlock[]; currentSeq: number }
}

/** 中止响应。 */
interface IAbortResponse {
  success: true
  data: { aborted: boolean }
}

/**
 * 查询会话列表（恢复对话入口）。
 *
 * @returns 会话概要数组（按最近活跃倒序）。
 * @throws {ApiClientError} 网络 / 协议 / 业务错误。
 */
export async function listAgentSessions(): Promise<IAgentSessionSummary[]> {
  const response = await requestJson<IListSessionsResponse>({
    path: '/api/agent/sessions',
  })
  return response.data
}

/**
 * 创建会话并发送首条消息。
 *
 * @param message - 首条用户消息。
 * @returns 服务端分配的会话 ID。
 * @throws {ApiClientError} 网络 / 协议 / 业务错误。
 */
export async function createAgentSession(message: string): Promise<string> {
  const response = await requestJson<ISessionIdResponse>({
    path: '/api/agent/sessions',
    method: 'POST',
    body: { message },
  })
  return response.data.sessionId
}

/**
 * 在已有会话中续接新一轮对话。
 *
 * @param sessionId - 会话 ID。
 * @param message - 用户消息。
 * @throws {ApiClientError} 网络 / 协议 / 业务错误。
 */
export async function sendAgentMessage(
  sessionId: string,
  message: string,
): Promise<void> {
  await requestJson<ISessionIdResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`,
    method: 'POST',
    body: { message },
  })
}

/**
 * 查询会话的历史工作块（物化视图，恢复时间线用）。
 *
 * @param sessionId - 会话 ID。
 * @returns 按 seq 升序的工作块与服务端当前最大事件序号。
 * @throws {ApiClientError} 网络 / 协议 / 业务错误。
 */
export async function getAgentWorkBlocks(
  sessionId: string,
): Promise<{ blocks: IAgentWorkBlock[]; currentSeq: number }> {
  const response = await requestJson<IBlocksResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/blocks`,
  })
  return response.data
}

/**
 * 中止会话当前运行的轮次。
 *
 * @param sessionId - 会话 ID。
 * @returns 是否成功命中运行中的会话。
 * @throws {ApiClientError} 网络 / 协议 / 业务错误。
 */
export async function abortAgentSession(sessionId: string): Promise<boolean> {
  const response = await requestJson<IAbortResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/abort`,
    method: 'POST',
  })
  return response.data.aborted
}

/**
 * 提交交互卡片的回答（双向交互的上行半边）。
 *
 * @param sessionId - 会话 ID。
 * @param interactionId - 交互 ID（begin 事件携带）。
 * @param answer - 回答值（v14 D5：单问题 string（confirm 'yes'/'no'、choice value、
 *   input 文本、取消哨兵）或多问题形态的 questionId 回答表）。
 * @throws {ApiClientError} 交互不存在或已回答（404）/ 网络 / 协议 / 业务错误。
 */
export async function answerAgentInteraction(
  sessionId: string,
  interactionId: string,
  answer: TAgentInteractionAnswer,
): Promise<void> {
  await requestJson<{ success: true }>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}/answer`,
    method: 'POST',
    body: { answer },
  })
}

/** 动作点击响应。 */
interface IActionResponse {
  success: true
  data: { ok: boolean; message: string }
}

/**
 * 点击一张动作卡片（v16）：发起执行、生成或覆盖确认。
 *
 * 服务端负责全部校验（互斥、就绪、缺口相符、覆盖确认）；
 * `ok: false` 时 `message` 是面向用户的拒绝原因（如「脚本已被手工修改」）。
 *
 * @param sessionId - 会话 ID。
 * @param actionId - 动作 ID（动作卡片事件携带）。
 * @param options.confirmOverwrite - 覆盖确认（GEN-10）。
 * @returns 服务端处理结果。
 * @throws {ApiClientError} 动作不存在 / 网络 / 协议错误。
 */
export async function runAgentWorkbenchAction(
  sessionId: string,
  actionId: string,
  options: { confirmOverwrite?: boolean } = {},
): Promise<{ ok: boolean; message: string }> {
  const response = await requestJson<IActionResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(actionId)}`,
    method: 'POST',
    body: {
      ...(options.confirmOverwrite !== undefined
        ? { confirmOverwrite: options.confirmOverwrite }
        : {}),
    },
  })
  return response.data
}

/** 提案取消 / 批次确认等无载荷响应。 */
interface IOkResponse {
  success: true
}

/** 提案 apply 响应（v17 §6.3）。 */
interface IProposalApplyResponse {
  success: true
  data: { ok: boolean; message: string; state?: 'conflict' | 'failed' }
}

/** 连续执行 confirm 响应。 */
interface IBatchConfirmResponse {
  success: true
  data: { ok: boolean; message?: string }
}

/** 会话删除响应：`hadRunningTask` 供前端区分确认文案（S2）。 */
interface IDeleteSessionResponse {
  success: true
  data: { sessionId: string; hadRunningTask: boolean }
}

/** 建议问题响应。 */
interface ISuggestionsResponse {
  success: true
  data: { suggestions: string[] }
}

/**
 * 应用一份提案（v17 E2 / V2 / L1 / L2 的写操作唯一入口）。
 *
 * **只有本函数会触发写操作**：卡片按钮须先经二次弹框（`requiresModalConfirm`）
 * 或用户明确点击，才能走到这里。
 *
 * @param sessionId - 会话 ID。
 * @param proposalId - 提案 ID（提案卡片事件的 blockId）。
 * @param options.envValues - env-fill 的用户填值；**由前端直达平台**，
 *   不进入任何事件、工作块或模型上下文（D7）。
 * @returns 应用结果：`ok: false` 时 `state` 区分冲突（需重新提案）与失败。
 * @throws {ApiClientError} 提案不存在 / 网络 / 协议错误。
 */
export async function applyAgentProposal(
  sessionId: string,
  proposalId: string,
  options: { envValues?: Record<string, string> } = {},
): Promise<{ ok: boolean; message: string; state?: 'conflict' | 'failed' }> {
  const response = await requestJson<IProposalApplyResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/apply`,
    method: 'POST',
    body: {
      ...(options.envValues !== undefined
        ? { envValues: options.envValues }
        : {}),
    },
  })
  return response.data
}

/**
 * 取消一份提案（v17 L2 / E 组）。
 *
 * 注意：**弹框内取消不走本函数**——提案仍是 pending，用户还可以再点
 * （技术方案 §7.2）。只有卡片上的「取消」按钮才置 `cancelled`。
 *
 * @param sessionId - 会话 ID。
 * @param proposalId - 提案 ID。
 * @throws {ApiClientError} 提案不存在 / 网络 / 协议错误。
 */
export async function cancelAgentProposal(
  sessionId: string,
  proposalId: string,
): Promise<void> {
  await requestJson<IOkResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/proposals/${encodeURIComponent(proposalId)}/cancel`,
    method: 'POST',
  })
}

/**
 * 确认连续执行（v17 R4a：待确认 → 执行中）。
 *
 * @param sessionId - 会话 ID。
 * @param batchId - 批次 ID。
 * @returns `ok: false` 时 `message` 是拒绝原因（如批次已开始或已结束）。
 * @throws {ApiClientError} 批次不存在 / 网络 / 协议错误。
 */
export async function confirmAgentBatch(
  sessionId: string,
  batchId: string,
): Promise<{ ok: boolean; message?: string }> {
  const response = await requestJson<IBatchConfirmResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/batches/${encodeURIComponent(batchId)}/confirm`,
    method: 'POST',
  })
  return response.data
}

/**
 * 取消连续执行（v17 R4a：待确认态取消，不产生执行记录）。
 *
 * @param sessionId - 会话 ID。
 * @param batchId - 批次 ID。
 * @throws {ApiClientError} 批次不存在 / 网络 / 协议错误。
 */
export async function cancelAgentBatch(
  sessionId: string,
  batchId: string,
): Promise<void> {
  await requestJson<IOkResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/batches/${encodeURIComponent(batchId)}/cancel`,
    method: 'POST',
  })
}

/**
 * 停止连续执行（v17 R4e：停止当前条目并终止整个批次）。
 *
 * @param sessionId - 会话 ID。
 * @param batchId - 批次 ID。
 * @throws {ApiClientError} 批次不存在 / 网络 / 协议错误。
 */
export async function stopAgentBatch(
  sessionId: string,
  batchId: string,
): Promise<void> {
  await requestJson<IOkResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}/batches/${encodeURIComponent(batchId)}/stop`,
    method: 'POST',
  })
}

/**
 * 重命名会话（v17 S1）。
 *
 * @param sessionId - 会话 ID。
 * @param title - 新标题（服务端只 trim，长度与字符合法性由调用方把关）。
 * @throws {ApiClientError} 会话不存在（404）/ 网络 / 协议错误。
 */
export async function renameAgentSession(
  sessionId: string,
  title: string,
): Promise<void> {
  await requestJson<IOkResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    method: 'PATCH',
    body: { title },
  })
}

/**
 * 删除会话（v17 S2）。
 *
 * **只删对话记录**，不影响用例、产物与报告；有运行中任务时服务端不拒绝，
 * 但把「有无任务」如实告知，供前端区分确认文案。
 *
 * @param sessionId - 会话 ID。
 * @returns 被删除的会话 ID 与删除前是否有运行中任务。
 * @throws {ApiClientError} 会话不存在（404）/ 网络 / 协议错误。
 */
export async function deleteAgentSession(sessionId: string): Promise<{
  sessionId: string
  hadRunningTask: boolean
}> {
  const response = await requestJson<IDeleteSessionResponse>({
    path: `/api/agent/sessions/${encodeURIComponent(sessionId)}`,
    method: 'DELETE',
  })
  return response.data
}

/**
 * 查询空态建议问题（v17 H1）。
 *
 * @returns 建议问题（3–4 条）；服务端未配置或工作区不可读时为空数组。
 * @throws {ApiClientError} 网络 / 协议错误。
 */
export async function getAgentSuggestions(): Promise<string[]> {
  const response = await requestJson<ISuggestionsResponse>({
    path: '/api/agent/suggestions',
  })
  return response.data.suggestions
}

/** 事件流订阅句柄。 */
export interface IAgentWorkStreamSubscription {
  /** 断开事件流并停止自动重连。 */
  close(): void
}

/** 事件流订阅回调。 */
export interface IAgentWorkStreamHandlers {
  /** 收到一条工作事件。 */
  onEvent(event: TAgentClientEvent): void
  /** 连接状态变化。 */
  onConnectionChange?(
    state: 'connecting' | 'live' | 'reconnecting' | 'offline',
  ): void
}

/** 重连退避序列（毫秒）：1s → 2s → 4s，之后固定 4s。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000]

/**
 * 订阅会话的 SSE 实时事件流。
 *
 * 网络中断时按指数退避自动重连，重连 URL 携带 afterSeq（由 getAfterSeq 提供，
 * 通常为客户端已见最大 seq），服务端据此补发断线期间的事件。
 *
 * @param sessionId - 会话 ID。
 * @param getAfterSeq - 提供断线续传起点的回调（每次（重）连时调用）。
 * @param handlers - 事件与连接状态回调。
 * @returns 订阅句柄；close() 断开并停止重连。
 */
export function subscribeAgentWorkStream(
  sessionId: string,
  getAfterSeq: () => number | undefined,
  handlers: IAgentWorkStreamHandlers,
): IAgentWorkStreamSubscription {
  let closed = false
  let abortController: AbortController | undefined
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const notifyConnection =
    handlers.onConnectionChange ?? ((): void => undefined)

  async function connect(): Promise<void> {
    if (closed) return
    notifyConnection(reconnectAttempts === 0 ? 'connecting' : 'reconnecting')
    abortController = new AbortController()

    const afterSeq = getAfterSeq()
    const query = afterSeq === undefined ? '' : `?afterSeq=${afterSeq}`
    let response: Response
    try {
      response = await fetch(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/stream${query}`,
        { signal: abortController.signal, credentials: 'same-origin' },
      )
    } catch {
      scheduleReconnect()
      return
    }

    // 仅当响应确实可消费（2xx + SSE 内容类型）才认为连接建立：
    // 服务端返回 5xx 时 fetch 同样会 resolve，若在此处无条件重置退避，
    // 重试间隔会永远停在 1s，形成持续的请求风暴。
    if (response.ok) {
      reconnectAttempts = 0
      notifyConnection('live')
    }
    try {
      await consumeSseResponse(response, (frame) => {
        const event = parseWorkEvent(frame.data)
        if (event) {
          handlers.onEvent(event)
        }
      })
    } catch (error) {
      if (
        closed ||
        (error instanceof ApiClientError && error.kind === 'aborted')
      ) {
        return
      }
    }
    // 流结束或出错且未主动断开：安排重连补齐缺口。
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    if (closed) return
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)
      ]
    reconnectAttempts += 1
    notifyConnection('reconnecting')
    reconnectTimer = setTimeout(() => void connect(), delay)
  }

  void connect()

  return {
    close(): void {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      abortController?.abort()
      notifyConnection('offline')
    },
  }
}

/**
 * 解析一条 SSE data 为工作事件；解析失败返回 undefined（不炸流）。
 *
 * @param data - SSE frame 的 data 文本。
 * @returns 工作事件；JSON 非法或缺少判别字段时为 undefined。
 */
function parseWorkEvent(data: string): TAgentClientEvent | undefined {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; seq?: unknown }
    if (typeof parsed.type === 'string' && typeof parsed.seq === 'number') {
      return parsed as unknown as TAgentClientEvent
    }
    return undefined
  } catch {
    return undefined
  }
}

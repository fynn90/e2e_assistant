/**
 * 测试执行 API（v11，技术方案 §5.2 的浏览器端封装）。
 *
 * 覆盖执行链路的五个端点：发起、快照（最近/指定）、SSE 事件流与停止；
 * 报告 HTML 由报告视图路由以 iframe 直接引用 CLI 文件服务，不经本模块。
 */
import type {
  IExecutionSnapshot,
  IStartExecutionResponse,
} from '@fynn90-e2e_assistant/types'
import { requestJson } from './http-client'
import { consumeSseResponse, type ISseFrame } from './sse'

/** 发起执行的响应数据。 */
export type TStartExecutionResult = IStartExecutionResponse

/** 发起执行。就绪校验失败时抛出的 ApiClientError 携带 `issues`（全部问题）。 */
export async function startExecution (
  skillId: string,
  signal?: AbortSignal,
): Promise<TStartExecutionResult> {
  const response = await requestJson<{
    success: true
    data: IStartExecutionResponse
  }>({
    path: `/api/skills/${skillId}/test-executions`,
    method: 'POST',
    signal,
  })
  return response.data
}

/** 查询指定执行的快照（X16 恢复）。 */
export async function fetchExecutionSnapshot (
  skillId: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<IExecutionSnapshot> {
  const response = await requestJson<{
    success: true
    data: IExecutionSnapshot
  }>({
    path: `/api/skills/${skillId}/test-executions/${executionId}`,
    signal,
  })
  return response.data
}

/** 查询最近一次执行的快照；无记录时返回 null（404 降级，R7）。 */
export async function fetchLatestExecutionSnapshot (
  skillId: string,
  signal?: AbortSignal,
): Promise<IExecutionSnapshot | null> {
  try {
    const response = await requestJson<{
      success: true
      data: IExecutionSnapshot
    }>({
      path: `/api/skills/${skillId}/test-executions/current`,
      signal,
    })
    return response.data
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error as { status?: number }).status === 404
    ) {
      return null
    }
    throw error
  }
}

/** 停止执行（X10）。 */
export async function stopExecution (
  skillId: string,
  executionId: string,
): Promise<void> {
  await requestJson({
    path: `/api/skills/${skillId}/test-executions/${executionId}/stop`,
    method: 'POST',
  })
}

/** 删除一次执行的测试报告（`test_report/<runId>/` 整目录）。 */
export async function deleteTestReport (
  skillId: string,
  runId: string,
): Promise<void> {
  await requestJson({
    path: `/api/skills/${skillId}/test-reports/${runId}`,
    method: 'DELETE',
  })
}

/**
 * 消费执行事件流（SSE）。
 *
 * 服务端按 afterSeq 补发缺口；本函数只负责单次连接的消费，
 * 断线重连由 store 编排（指数退避 + afterSeq 续传）。
 *
 * @param options - Skill ID、执行 ID、补发起点与帧回调。
 * @returns 连接结束（服务端关闭或出错）后兑现。
 * @throws ApiClientError（aborted 除外）时由调用方决定是否重连。
 */
export async function streamExecutionEvents (options: {
  skillId: string
  executionId: string
  afterSeq?: number
  signal?: AbortSignal
  onEvent: (frame: ISseFrame) => void
}): Promise<void> {
  const query =
    options.afterSeq !== undefined ? `?afterSeq=${options.afterSeq}` : ''
  const response = await fetch(
    `/api/skills/${options.skillId}/test-executions/${options.executionId}/stream${query}`,
    {
      headers: { Accept: 'text/event-stream' },
      signal: options.signal,
      credentials: 'same-origin',
    },
  )

  await consumeSseResponse(response, options.onEvent)
}

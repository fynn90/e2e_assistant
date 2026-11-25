/**
 * 探测本地 CLI 服务是否真的在指定地址上运行。
 *
 * 存在的理由：运行态记录（runtime.json）只保存 PID，而 PID 会被操作系统回收给
 * 无关进程。仅凭「PID 仍存在」判断服务在运行，会导致把陈旧记录当作活跃服务，
 * 进而跳过启动、甚至在 stop 时误杀无关进程。
 *
 * 因此这里改为向目标地址发起 HTTP 健康请求并校验服务自报身份，用「响应者是谁」
 * 而不是「进程号是否还在」作为判据。三态结果刻意区分「无人应答」与「有人应答但
 * 不回应」，因为前者可以安全地判定陈旧，后者不能。
 */
import { localServiceHealthSchema } from '@charlie_deng/e2e-assistant-types'

const DEFAULT_PROBE_TIMEOUT_MS = 1000
// URL.hostname 对 IPv6 会保留方括号（形如 [::1]），因此这里按原样列出。
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * 探测结果。
 *
 * - `confirmed`：目标地址上确实在运行本平台 CLI；
 * - `foreign`：有服务应答，但不是本平台 CLI（或应答内容不是合法健康响应）；
 * - `unreachable`：拿不到任何应答，`reason` 说明原因。
 */
export type TLocalServiceProbeResult =
  | { outcome: 'confirmed'; version: number; pid: number | null }
  | { outcome: 'foreign'; httpStatus: number }
  | { outcome: 'unreachable'; reason: TProbeUnreachableReason }

/**
 * 无法应答的原因。
 *
 * - `refused`：连接被拒绝，说明该地址上无人监听，可安全判定记录陈旧；
 * - `timeout`：连接被接受但未在限时内响应，说明端口被占用但服务状态未知，
 *   调用方必须按「无法确认」处理，不可据此清理记录或结束进程；
 * - `invalid-url`：记录中的地址不是受支持的回环地址，未发起任何请求。
 */
export type TProbeUnreachableReason = 'refused' | 'timeout' | 'invalid-url'

interface IProbeLocalServiceOptions {
  /** 待探测的服务根地址，例如 http://127.0.0.1:5826。 */
  serverUrl: string
  /** 探测超时时间（毫秒），缺省 1000。 */
  timeoutMs?: number
  /** 可替换的请求实现，便于测试注入。 */
  fetchImplementation?: typeof fetch
}

/**
 * 探测指定地址上是否运行着本平台 CLI 服务。
 *
 * @param options 探测参数，包含服务地址、超时时间和可替换的请求实现。
 * @returns 三态探测结果；不会抛出异常，所有失败都收敛为 `unreachable`。
 * @throws 不抛出异常，网络错误、超时和非法地址都会被转换为结果对象。
 */
export async function probeLocalService (
  options: IProbeLocalServiceOptions,
): Promise<TLocalServiceProbeResult> {
  const requestUrl = resolveProbeUrl(options.serverUrl)

  if (!requestUrl) {
    return { outcome: 'unreachable', reason: 'invalid-url' }
  }

  const fetchImplementation = options.fetchImplementation ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  let response: Response

  try {
    response = await fetchImplementation(`${requestUrl}/health`, {
      method: 'GET',
      // AbortSignal.timeout 会真正中止底层连接；相比之下给 Promise 套超时会让
      // 被放弃的 socket 悬挂到系统超时为止。
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { outcome: 'unreachable', reason: classifyProbeFailure(error) }
  }

  // 只要拿到了 HTTP 应答，就说明该地址上确有服务在监听：
  // 要么是我们的 CLI，要么是别的服务。两种都不属于 unreachable。
  const responseBody = await readResponseBody(response)
  const parsedHealth = localServiceHealthSchema.safeParse(responseBody)

  if (!parsedHealth.success) {
    return { outcome: 'foreign', httpStatus: response.status }
  }

  return {
    outcome: 'confirmed',
    version: parsedHealth.data.version,
    pid: parsedHealth.data.pid ?? null,
  }
}

/**
 * 把记录中的服务地址解析为受支持的回环根地址。
 *
 * 该地址来自磁盘文件，即将被用于发起网络请求，因此只接受
 * 「http + 回环主机 + 显式端口」这一种形状，避免把文件内容当成任意 URL 使用。
 *
 * @param serverUrl 运行态记录中的服务地址。
 * @returns 规范化后的根地址（不含末尾斜杠）；不合法时返回 null。
 * @throws 不抛出异常，非法 URL 会被转换为 null。
 */
export function resolveProbeUrl (serverUrl: string): string | null {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(serverUrl)
  } catch {
    return null
  }

  if (parsedUrl.protocol !== 'http:') {
    return null
  }

  if (!LOOPBACK_HOSTNAMES.has(parsedUrl.hostname)) {
    return null
  }

  if (!parsedUrl.port) {
    return null
  }

  return `${parsedUrl.protocol}//${parsedUrl.host}`
}

/**
 * 读取应答体并解析为 JSON 对象。
 *
 * @param response 探测得到的 HTTP 应答。
 * @returns 解析成功的 JSON 值；不是 JSON 或读取失败时返回 null。
 * @throws 不抛出异常，读取和解析失败都会被转换为 null。
 */
async function readResponseBody (response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text())
  } catch {
    return null
  }
}

/**
 * 把请求失败归因为「无人监听」或「无法确认」。
 *
 * 仅当底层错误明确是「连接被拒绝」时才判定为 `refused`；其余情况（超时、
 * 连接被重置、未知网络错误）一律归为 `timeout`，因为调用方对 `timeout`
 * 采取保守策略，误判到这一侧是安全的。
 *
 * @param error 请求抛出的异常。
 * @returns 无法应答的原因。
 * @throws 不抛出异常。
 */
function classifyProbeFailure (error: unknown): TProbeUnreachableReason {
  // AbortSignal.timeout 触发时抛出 TimeoutError（DOMException）。
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'timeout'
  }

  // undici 把底层系统调用错误挂在 cause 上，例如 connect ECONNREFUSED。
  const causeCode = extractErrorCode(
    (error as { cause?: unknown } | null)?.cause,
  )

  if (causeCode === 'ECONNREFUSED') {
    return 'refused'
  }

  return 'timeout'
}

/**
 * 从异常对象中提取系统调用错误码。
 *
 * @param error 待检查的对象，通常是另一个异常的 cause。
 * @returns 形如 ECONNREFUSED 的错误码；不存在时返回 null。
 * @throws 不抛出异常。
 */
function extractErrorCode (error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }

  const errorCode = (error as { code?: unknown }).code

  return typeof errorCode === 'string' ? errorCode : null
}

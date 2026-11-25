/**
 * 向运行中的服务请求优雅关闭（v19 §4.4）。
 *
 * 存在的理由：Windows 上 `process.kill(pid, 'SIGTERM')` 是硬杀，信号监听根本
 * 不会执行——`stop` 需要一个让服务自己收尾的通道。
 *
 * 结果刻意收敛为四态而不是抛异常：调用方（stop 决策表）要对「不支持」「凭据
 * 不匹配」「够不着」分别给出不同的用户文案与回退动作。
 */
import { SHUTDOWN_TOKEN_HEADER } from '@fynn90-e2e_assistant/service'
import { resolveProbeUrl } from '../infrastructure/http/service-probe'

/** 请求优雅关闭的默认超时；端点应答很快，超时即视为够不着。 */
const DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS = 3000

/**
 * 请求结果。
 *
 * - `accepted`：服务已接受关闭请求（2xx），应等待进程退出；
 * - `unsupported`：服务没有该端点（404，旧版本），应回退信号方式；
 * - `rejected`：凭据不匹配（403，记录可能已被替换），应回退信号方式；
 * - `unreachable`：网络错误或超时，先观察进程是否自行退出，未退出再回退。
 */
export type TShutdownRequestOutcome =
  | 'accepted'
  | 'unsupported'
  | 'rejected'
  | 'unreachable'

interface IRequestServiceShutdownOptions {
  /** 服务根地址（来自运行态记录）。 */
  serverUrl: string
  /** 一次性凭据（来自运行态记录）。 */
  token: string
  /** 请求超时（毫秒），缺省 3000。 */
  timeoutMs?: number
  /** 可替换的请求实现，便于测试注入。 */
  fetchImplementation?: typeof fetch
}

/**
 * 请求服务优雅关闭。
 *
 * @param options - 服务地址、凭据、超时与可替换的请求实现。
 * @returns 四态结果；不抛出异常，所有失败都收敛为 `unreachable`。
 * @throws 不抛出异常，网络错误与超时都会被转换为结果对象。
 */
export async function requestServiceShutdown (
  options: IRequestServiceShutdownOptions,
): Promise<TShutdownRequestOutcome> {
  // 与健康探测同一份 URL 白名单（只接受 http + 回环 + 显式端口）：
  // 地址来自磁盘文件，不能当作任意 URL 使用；复制第二份会漂移。
  const requestUrl = resolveProbeUrl(options.serverUrl)

  if (!requestUrl) {
    return 'unreachable'
  }

  const fetchImplementation = options.fetchImplementation ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS

  let response: Response

  try {
    response = await fetchImplementation(`${requestUrl}/api/shutdown`, {
      method: 'POST',
      headers: { [SHUTDOWN_TOKEN_HEADER]: options.token },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return 'unreachable'
  }

  if (response.ok) {
    return 'accepted'
  }

  if (response.status === 404) {
    return 'unsupported'
  }

  if (response.status === 403) {
    return 'rejected'
  }

  // 其余状态（5xx 等）：服务在但拒绝了请求，按「够不着」处理——
  // 调用方会先观察进程是否自行退出，未退出才回退信号。
  return 'unreachable'
}

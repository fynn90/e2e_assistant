/**
 * 判定运行态记录所描述的服务当前处于什么状态。
 *
 * 这是「服务是否在运行」的唯一判据来源，start 与 stop 两条链路共用，
 * 避免两处各自判断导致行为漂移。
 *
 * 核心安全性质（不可削弱）：
 * **只有在拿到「服务确实已消失」的正面证据时才允许清理记录或结束进程。**
 * 任何无法确认身份的情形都必须保留记录并交由用户处置——PID 会被操作系统
 * 回收给无关进程，把「无法确认」当成「已消失」会导致误杀无关进程或让仍在
 * 运行的服务失去可管理性。
 */
import type { IPlatformRuntimeState } from '../infrastructure/config/runtime-store'
import {
  probeLocalService,
  type TLocalServiceProbeResult,
} from '../infrastructure/http/service-probe'

/**
 * 记录所描述服务的当前状态。
 *
 * - `absent`：没有记录，或已有正面证据表明服务已消失，可以安全清理并启动新服务；
 * - `active`：已确认记录对应的服务正在运行；
 * - `unknown`：无法确认服务状态（目标占用着端口但不回应）。既不可清理记录，
 *   也不可结束进程，必须向用户报告并让其处置。
 */
export type TServiceResolution =
  | { state: 'absent'; reason: 'no-record' | 'record-invalid' | 'service-gone' }
  | { state: 'active'; runtimeState: IPlatformRuntimeState; version: number }
  | { state: 'unknown'; runtimeState: IPlatformRuntimeState; detail: string }

/** 服务探测函数的签名；测试可注入替身以覆盖各条分支。 */
export type TServiceProbe = (options: {
  serverUrl: string
  timeoutMs?: number
}) => Promise<TLocalServiceProbeResult>

interface IResolveServiceStateOptions {
  /** 已读出的运行态记录；null 表示无记录或记录非法。 */
  runtimeState: IPlatformRuntimeState | null
  /** 记录是否因内容非法而不可用（与「无记录」区分，用于生成提示文案）。 */
  isRecordInvalid: boolean
  /** 可替换的探测实现，便于测试注入；缺省使用真实健康探测。 */
  probe?: TServiceProbe
  /** 探测超时时间（毫秒）。 */
  probeTimeoutMs?: number
}

/**
 * 结合健康探测判定服务的真实状态。
 *
 * 判定规则：
 * - 无记录 / 记录非法 ⇒ `absent`；
 * - 探测确认身份且 PID 与记录一致 ⇒ `active`；
 * - 探测确认身份但 PID 不一致 ⇒ `unknown`（记录指向的进程未必是本服务，不可结束）；
 * - 探测到非本平台服务应答 ⇒ `absent`（本服务未监听该地址）；
 * - 连接被拒绝 ⇒ `absent`（该地址无人监听）；
 * - 连接被接受但超时未应答 ⇒ `unknown`（端口被占用但服务状态未知）。
 *
 * @param options 判定参数，包含记录内容与可注入的探测实现。
 * @returns 服务状态判定结果。
 * @throws 不抛出异常，探测失败会收敛为 `unknown`。
 */
export async function resolveServiceState(
  options: IResolveServiceStateOptions,
): Promise<TServiceResolution> {
  if (!options.runtimeState) {
    return {
      state: 'absent',
      reason: options.isRecordInvalid ? 'record-invalid' : 'no-record',
    }
  }

  const probe = options.probe ?? probeLocalService
  const probeResult = await probe({
    serverUrl: options.runtimeState.serverUrl,
    ...(options.probeTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.probeTimeoutMs }),
  })

  return interpretProbeResult({
    runtimeState: options.runtimeState,
    probeResult,
  })
}

interface IInterpretProbeResultOptions {
  runtimeState: IPlatformRuntimeState
  probeResult: TLocalServiceProbeResult
}

/**
 * 把探测结果翻译为服务状态判定。
 *
 * @param options 原始探测结果与对应的运行态记录。
 * @returns 服务状态判定结果。
 * @throws 不抛出异常。
 */
function interpretProbeResult(
  options: IInterpretProbeResultOptions,
): TServiceResolution {
  const { runtimeState, probeResult } = options

  switch (probeResult.outcome) {
    case 'confirmed':
      // PID 不一致说明响应者不是记录所指向的进程（PID 已被回收给别的实例），
      // 此时结束记录中的 PID 会误杀无关进程，因此判定为无法确认。
      if (probeResult.pid !== null && probeResult.pid !== runtimeState.pid) {
        return {
          state: 'unknown',
          runtimeState,
          detail: `端口 ${runtimeState.port} 上的 CLI 服务进程号为 ${probeResult.pid}，与记录的 ${runtimeState.pid} 不一致，无法确认记录指向的进程。`,
        }
      }

      return { state: 'active', runtimeState, version: probeResult.version }

    case 'foreign':
      return { state: 'absent', reason: 'service-gone' }

    case 'unreachable':
      return interpretUnreachable({ runtimeState, reason: probeResult.reason })
  }
}

interface IInterpretUnreachableOptions {
  runtimeState: IPlatformRuntimeState
  reason: 'refused' | 'timeout' | 'invalid-url'
}

/**
 * 翻译「拿不到应答」这一类探测结果。
 *
 * @param options 无法应答的原因与对应的运行态记录。
 * @returns 服务状态判定结果。
 * @throws 不抛出异常。
 */
function interpretUnreachable(
  options: IInterpretUnreachableOptions,
): TServiceResolution {
  const { runtimeState, reason } = options

  if (reason === 'invalid-url') {
    // 记录中的地址不可用，说明记录本身已经不可信，按陈旧处理。
    return { state: 'absent', reason: 'service-gone' }
  }

  if (reason === 'refused') {
    return { state: 'absent', reason: 'service-gone' }
  }

  return {
    state: 'unknown',
    runtimeState,
    detail: `端口 ${runtimeState.port} 被占用，但该服务未在限时内响应健康探测，无法确认它是否仍是本平台 CLI。`,
  }
}

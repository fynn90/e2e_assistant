/**
 * 只读的服务状态查询，供 `e2e_assistant status` 使用。
 *
 * 与 start / stop 的分工：那两条命令**会改变状态**（启动进程、结束进程、清理
 * 记录），本模块只回答「现在是什么状态」。因此它有一条硬性质：
 *
 *   **绝不调用 `clearPlatformRuntimeState` / `savePlatformRuntimeState` /
 *   `rotateServiceLogIfNeeded`，也不结束任何进程。**
 *
 * 这条性质是刻意的：`status` 可能是用户排查问题时敲的第一条命令，它不该
 * 在用户尚未决定怎么做之前就动磁盘上的记录——尤其不能在「无法确认」时清理，
 * 那会让仍可能存活的服务失去可管理性（见 service-identity.ts 的核心安全性质）。
 *
 * 状态判定本身复用既有唯一来源 `resolveServiceState`，不另立平行逻辑，
 * 以免 status 与 start/stop 的判定发生漂移。
 */
import { inspectPlatformRuntimeState } from '../infrastructure/config/runtime-store'
import {
  resolveServiceState,
  type TServiceProbe,
  type TServiceResolution,
} from './service-identity'

/**
 * 服务状态查询结果。
 *
 * 直接复用 `TServiceResolution`：三态（active / absent / unknown）的语义
 * 由状态判定层定义，命令层只是消费者的角色，不应重新解释一遍。
 */
export type TServiceStatus = TServiceResolution

/**
 * 查询服务的当前状态（只读）。
 *
 * 与 `log` 命令的一处刻意差异：这里传入真实的 `isRecordInvalid`，因此能
 * 区分「从未启动」与「记录损坏」——`log` 只关心要不要展示日志，而 status
 * 的职责正是把状态说清楚，两个成因需要不同的提示文案。
 *
 * @param overrides - 可选的依赖覆盖项（探测实现），用于测试注入替身。
 * @returns 服务状态判定结果，永不抛出异常。
 * @throws 不抛出异常；读取与探测失败都收敛为可表达的状态取值。
 */
export async function readServiceStatus (
  overrides: {
    probe?: TServiceProbe
    inspectRuntimeState?: typeof inspectPlatformRuntimeState
  } = {},
): Promise<TServiceStatus> {
  const inspectRuntimeState =
    overrides.inspectRuntimeState ?? inspectPlatformRuntimeState
  const inspection = await inspectRuntimeState()

  return await resolveServiceStateSafely({
    runtimeState: inspection.runtimeState,
    isRecordInvalid: inspection.state === 'invalid',
    ...(overrides.probe ? { probe: overrides.probe } : {}),
  })
}

type IResolveServiceStateSafelyOptions = Parameters<
  typeof resolveServiceState
>[0]

/**
 * 包一层，把探测抛出的异常收敛为 `unknown`。
 *
 * 为什么必须收敛：`status` 的退出码里 `1` 表示「服务未运行」，而命令抛异常
 * 时命令包装器也会把退出码置为 1——两者会混淆，脚本会把一次「查询失败」
 * 误读成「服务没在跑」并据此去启动它。收敛为 `unknown`（退出码 2）后，
 * 语义是诚实的：「我没能确定它是什么状态」。
 *
 * 生产路径上真实的 `probeLocalService` 与 `inspectPlatformRuntimeState` 都
 * 自带「绝不抛异常」的契约，因此这层是防御性的；但 `status` 是排查问题的
 * 命令，它自己必须先保证不因查询失败而给出误导性的退出码。
 *
 * @param options - 状态判定参数。
 * @returns 状态判定结果；探测抛错时返回 unknown。
 * @throws 不抛出异常。
 */
async function resolveServiceStateSafely (
  options: IResolveServiceStateSafelyOptions,
): Promise<TServiceStatus> {
  try {
    return await resolveServiceState(options)
  } catch (error) {
    // 无记录时不会走到探测，也就不会抛错；因此这里必然有记录可用。
    const runtimeState = options.runtimeState

    if (!runtimeState) {
      return { state: 'absent', reason: 'no-record' }
    }

    return {
      state: 'unknown',
      runtimeState,
      detail: `健康探测未能完成（${formatErrorMessage(error)}），无法确认该服务是否仍在运行。`,
    }
  }
}

/**
 * 把异常转成一句话说明。
 *
 * @param error - 捕获到的异常。
 * @returns 异常消息；非 Error 时退化为字符串表示。
 * @throws 不抛出异常。
 */
function formatErrorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读写本地 CLI 服务的运行态记录（runtime.json）。
 *
 * 本模块只负责「存取与形状校验」，不含任何「服务是否在运行」的判断策略：
 * 记录中的 PID 会被操作系统回收给无关进程，因此单凭本文件的内容无法判定
 * 服务存活。存活判定由应用层结合健康探测完成，见 infrastructure/http/service-probe.ts。
 */
import { access, readFile, rm } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { buildStorageAccessError } from './storage-error'
import {
  atomicWriteSecureFile,
  ensureSecureDirectory,
  ensureSecureFile,
} from './secure-file'
import { getAuthineConfigDirectory, getPlatformRuntimePath } from './config-path'

export interface IPlatformRuntimeState {
  pid: number
  port: number
  serverUrl: string
  startedAt: string
  /**
   * 运行形态。
   *
   * 缺省按前台处理（旧记录无此字段）——这让解析器不因新字段缺失而把整条记录
   * 判废，升级后的第一次 `stop` 不会直接报「记录损坏」。
   */
  mode: 'foreground' | 'background'
  /**
   * 优雅关闭的一次性凭据；CLI 生成并随记录保存，服务端点用于比对。
   *
   * 仅新版服务写入，旧记录为 undefined——`stop` 据此判断能否走端点（§4.4）。
   * 凭据只存在于本文件（0600），不进 `/health`、不进任何 API 响应、不进前端。
   */
  shutdownToken?: string
}

/**
 * 运行态记录的读取结果。
 *
 * - `missing`：没有记录文件，属正常情况（服务从未启动或已被清理）；
 * - `invalid`：文件存在但内容不可用（JSON 损坏或字段非法），调用方应视为陈旧记录覆盖；
 * - `present`：记录可用。
 */
export type TPlatformRuntimeInspection =
  | { state: 'missing'; runtimeState: null }
  | { state: 'invalid'; runtimeState: null }
  | { state: 'present'; runtimeState: IPlatformRuntimeState }

/**
 * 读取并校验运行态记录。
 *
 * 与直接读取不同，本函数把「文件损坏」和「字段非法」都归为 `invalid` 而不是抛出异常：
 * 让损坏的记录能够被后续启动正常覆盖，而不是要求用户手工删除文件。
 *
 * @returns 运行态记录的读取结果，永不抛出异常。
 * @throws 不抛出异常；读取失败或内容非法都会收敛为 `invalid`。
 */
export async function inspectPlatformRuntimeState(): Promise<TPlatformRuntimeInspection> {
  const runtimePath = getPlatformRuntimePath()

  if (!(await hasPlatformRuntimeState())) {
    return { state: 'missing', runtimeState: null }
  }

  let storedRuntimeState: unknown

  try {
    storedRuntimeState = JSON.parse(await readFile(runtimePath, 'utf-8'))
  } catch {
    return { state: 'invalid', runtimeState: null }
  }

  const runtimeState = parseRuntimeState(storedRuntimeState)

  if (!runtimeState) {
    return { state: 'invalid', runtimeState: null }
  }

  return { state: 'present', runtimeState }
}

/**
 * 读取运行态记录，内容非法时返回 null。
 *
 * @returns 可用的运行态记录；文件不存在或内容非法时返回 null。
 * @throws 不抛出异常。
 */
export async function loadPlatformRuntimeState(): Promise<IPlatformRuntimeState | null> {
  return (await inspectPlatformRuntimeState()).runtimeState
}

/**
 * 写入运行态记录。
 *
 * 采用「临时文件 + 重命名」的原子覆盖写入，因此成功写入即代表旧记录被完整取代，
 * 调用方无需在启动前单独清理陈旧记录。
 *
 * @param runtimeState 待持久化的运行态记录，只保存契约字段（含 v19 的 `mode` 与
 *   可选的 `shutdownToken`）。
 * @returns 写入完成后无返回值。
 * @throws 当配置目录不可写或文件写入失败时抛出带有处理建议的异常。
 */
export async function savePlatformRuntimeState(
  runtimeState: IPlatformRuntimeState,
): Promise<void> {
  const runtimePath = getPlatformRuntimePath()
  const persistedRuntimeState: IPlatformRuntimeState = {
    pid: runtimeState.pid,
    port: runtimeState.port,
    serverUrl: runtimeState.serverUrl,
    startedAt: runtimeState.startedAt,
    mode: runtimeState.mode,
    ...(runtimeState.shutdownToken
      ? { shutdownToken: runtimeState.shutdownToken }
      : {}),
  }
  const serializedRuntimeContent = `${JSON.stringify(persistedRuntimeState, null, 2)}\n`

  try {
    await ensureSecureDirectory(getAuthineConfigDirectory())
    await atomicWriteSecureFile(runtimePath, serializedRuntimeContent)
    await ensureSecureFile(runtimePath)
  } catch (error) {
    throw buildStorageAccessError({
      actionLabel: '写入运行态文件',
      targetPath: runtimePath,
      error,
    })
  }
}

/**
 * 删除运行态记录，文件本就不存在时视为成功。
 *
 * @returns 删除完成后无返回值。
 * @throws 当文件存在但无法删除时抛出带有处理建议的异常。
 */
export async function clearPlatformRuntimeState(): Promise<void> {
  const runtimePath = getPlatformRuntimePath()

  try {
    await rm(runtimePath)
  } catch (error) {
    if (isMissingFileError(error)) {
      return
    }

    throw buildStorageAccessError({
      actionLabel: '清理运行态文件',
      targetPath: runtimePath,
      error,
    })
  }
}

/**
 * 判断指定 PID 对应的进程是否仍然存在。
 *
 * 注意：本函数只回答「进程号是否还存在」，不能证明它就是我们的 CLI 服务——
 * PID 会被回收给无关进程。它只能用于「进程已消失」这类可以让结论更保守的场景，
 * 不可单独作为服务存活的依据。
 *
 * @param pid 待检查的进程号。
 * @returns 进程存在时返回 true；进程号非法、进程不存在或无权限查询时返回 false。
 * @throws 不抛出异常。
 */
export function isPlatformProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但当前用户无权向它发信号，仍应视为「存在」：
    // 若误判为已退出，等待退出的轮询会立刻返回成功，导致服务仍在运行时被报告为已停止。
    return extractErrorCode(error) === 'EPERM'
  }
}

async function hasPlatformRuntimeState(): Promise<boolean> {
  try {
    await access(getPlatformRuntimePath(), fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并规范化记录内容：四个基础契约字段必须俱全且取值合法，v19 新增字段
 * 按防御性默认处理。
 *
 * `mode` 缺失或非法退化为 `foreground`；`shutdownToken` 非字符串时丢弃——
 * 这两项都不是「记录损坏」的理由，否则升级后的第一次 stop 会直接报错。
 *
 * @param storedRuntimeState JSON 解析后的原始内容。
 * @returns 通过校验的运行态记录；基础字段缺失或非法时返回 null。
 * @throws 不抛出异常。
 */
function parseRuntimeState(
  storedRuntimeState: unknown,
): IPlatformRuntimeState | null {
  if (!storedRuntimeState || typeof storedRuntimeState !== 'object') {
    return null
  }

  const candidate = storedRuntimeState as Partial<IPlatformRuntimeState>

  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) {
    return null
  }

  if (!Number.isInteger(candidate.port) || (candidate.port ?? 0) <= 0) {
    return null
  }

  if (typeof candidate.serverUrl !== 'string' || !candidate.serverUrl) {
    return null
  }

  if (typeof candidate.startedAt !== 'string') {
    return null
  }

  return {
    pid: candidate.pid as number,
    port: candidate.port as number,
    serverUrl: candidate.serverUrl,
    startedAt: candidate.startedAt,
    mode: candidate.mode === 'background' ? 'background' : 'foreground',
    ...(typeof candidate.shutdownToken === 'string' && candidate.shutdownToken
      ? { shutdownToken: candidate.shutdownToken }
      : {}),
  }
}

function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }

  const errorCode = (error as { code?: unknown }).code

  return typeof errorCode === 'string' ? errorCode : null
}

function isMissingFileError(error: unknown): boolean {
  return extractErrorCode(error) === 'ENOENT'
}

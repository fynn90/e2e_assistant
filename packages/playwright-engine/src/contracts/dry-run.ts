/** 定义生成期候选脚本受控试运行的预留契约，实际实现属于阶段 2。 */

import type { IEngineEventSink } from './events'
import type { INetworkPolicy } from './network'

/**
 * 试运行超时配置。
 */
export interface IDryRunTimeouts {
  testMs?: number
  overallMs?: number
  shutdownMs?: number
}

/**
 * 候选脚本试运行请求。
 */
export interface IDryRunRequest {
  workspaceDir: string
  specCode: string
  baseUrl: string
  envWhitelist: Readonly<Record<string, string>>
  networkPolicy?: INetworkPolicy
  timeout?: IDryRunTimeouts
  signal?: AbortSignal
  eventSink?: IEngineEventSink
}

/**
 * 试运行失败分类。
 */
export interface IDryRunFailure {
  kind:
    | 'assertion'
    | 'selector'
    | 'navigation'
    | 'timeout'
    | 'cancelled'
    | 'infrastructure'
  message: string
  file?: string
  line?: number
}

/**
 * 试运行结果。
 */
export interface IDryRunResult {
  status: 'passed' | 'failed' | 'skipped'
  attempts: number
  exitCode: number | null
  durationMs: number
  sanitizedOutput: string
  failure?: IDryRunFailure
}

/**
 * 受控试运行器公共接口，阶段 2 才提供默认实现。
 */
export interface IDryRunRunner {
  /**
   * 执行静态校验通过的候选脚本。
   *
   * @param request - 工作区、源码、网络和环境变量边界。
   * @returns 脱敏后的试运行结果。
   * @throws 执行环境错误、取消和整体超时时抛出结构化错误。
   */
  run(request: IDryRunRequest): Promise<IDryRunResult>
}

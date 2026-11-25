/**
 * Agent 工作通道运行时注册表：按工作区缓存常驻运行时。
 *
 * 运行时创建依赖平台配置（模型密钥等），同一路径的工作区共享同一实例，
 * 保证会话跨请求、跨 SSE 连接存活；服务关闭时统一释放。
 */

import { join } from 'node:path'
import {
  createAgentWorkRuntime,
  RUNTIME_DATA_DIR,
  type IAgentWorkRuntime,
  type IAgentWorkRuntimeOptions,
} from './agent-work-runtime'

export {
  createAgentWorkRuntime,
  type IAgentWorkRuntime,
  type IAgentWorkRuntimeOptions,
} from './agent-work-runtime'
export {
  createSessionEventBus,
  type ISessionEventBus,
  type TSessionEventListener,
} from './session-event-bus'
export { createWorkBlockStore, type IWorkBlockStore } from './work-block-store'
export {
  createInteractionRegistry,
  type IInteractionRegistry,
} from './interaction-registry'
export {
  createSkillGenerationSessionRunner,
  type ISkillGenerationSessionRunnerOptions,
} from './skill-generation-session-runner'

/**
 * 解析指定工作区下运行时数据库文件的绝对路径。
 *
 * @param workspace - Agent 工作目录（平台 projectDirectory）。
 * @returns 会话库与工作块库的绝对路径。
 * @throws 不抛出异常。
 */
export function resolveRuntimeDbPaths(workspace: string): {
  sessionsDbPath: string
  workBlocksDbPath: string
} {
  const dataDirPath = join(workspace, RUNTIME_DATA_DIR)
  return {
    sessionsDbPath: join(dataDirPath, 'sessions.db'),
    workBlocksDbPath: join(dataDirPath, 'work-blocks.db'),
  }
}

/** 工作通道运行时注册表构造选项。 */
export interface IAgentWorkRuntimeRegistryOptions {
  /** bash 可执行文件绝对路径（CLI 启动时探测注入）；创建运行时自动合并。 */
  shellPath?: string
}

/** 工作通道运行时注册表接口。 */
export interface IAgentWorkRuntimeRegistry {
  /** 按工作区获取（或惰性创建）常驻运行时。 */
  getRuntime(options: IAgentWorkRuntimeOptions): IAgentWorkRuntime
  /** 释放全部缓存的运行时。 */
  disposeAll(): Promise<void>
}

/**
 * 创建工作通道运行时注册表。
 *
 * @param options - 注册表级配置（bash 路径等进程级常量），惰性创建运行时
 *   时合并进每个运行时的构造选项，调用方（路由层/生成器工厂）无需感知。
 * @returns 注册表实例。
 */
export function createAgentWorkRuntimeRegistry(
  options: IAgentWorkRuntimeRegistryOptions = {},
): IAgentWorkRuntimeRegistry {
  const runtimes = new Map<string, IAgentWorkRuntime>()

  return {
    getRuntime(runtimeOptions: IAgentWorkRuntimeOptions): IAgentWorkRuntime {
      const existing = runtimes.get(runtimeOptions.workspace)
      if (existing) return existing
      // 合并注册表级配置（bash 路径）：调用方只感知工作区与模型配置。
      const runtime = createAgentWorkRuntime({
        ...runtimeOptions,
        ...(options.shellPath ? { shellPath: options.shellPath } : {}),
      })
      runtimes.set(runtimeOptions.workspace, runtime)
      return runtime
    },

    async disposeAll(): Promise<void> {
      const all = [...runtimes.values()]
      runtimes.clear()
      await Promise.all(all.map((runtime) => runtime.dispose()))
    },
  }
}

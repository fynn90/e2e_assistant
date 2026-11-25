/**
 * Harness 插件解析器：用 Noop / 透传默认实现补齐未配置的插件插槽。
 *
 * 保证 AgentLoop 拿到的是 IResolvedPlugins（所有插槽必有实现），
 * 避免核心代码到处判空；同时向后兼容——老调用方不传 plugins 即用默认值。
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type {
  IEventAdapter,
  IHarnessPlugins,
  IResolvedPlugins,
} from './interfaces'
import {
  createAllowAllToolGuard,
  createNoopContextPolicy,
  createNoopObservability,
  createNoopRetryPolicy,
  createNoopSessionStore,
  createPassthroughEventAdapter,
} from './defaults'

/**
 * 解析插件集合：对每个未配置的插槽填入默认实现。
 *
 * @param plugins - 调用方传入的插件集合，可只配置其中若干项。
 * @returns 所有插槽均有实现的插件集合；TAppEvent 由事件适配器类型推导。
 */
export function resolvePlugins<TAppEvent = AgentEvent>(
  plugins: IHarnessPlugins = {},
): IResolvedPlugins<TAppEvent> {
  return {
    sessionStore: plugins.sessionStore ?? createNoopSessionStore(),
    contextPolicy: plugins.contextPolicy ?? createNoopContextPolicy(),
    retryPolicy: plugins.retryPolicy ?? createNoopRetryPolicy(),
    // 未配置适配器时缺省透传 AgentEvent；此时 TAppEvent 应为 AgentEvent。
    eventAdapter: (plugins.eventAdapter ??
      createPassthroughEventAdapter()) as IEventAdapter<TAppEvent>,
    observability: plugins.observability ?? createNoopObservability(),
    toolGuard: plugins.toolGuard ?? createAllowAllToolGuard(),
  }
}

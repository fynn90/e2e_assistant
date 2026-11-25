/**
 * Harness 插件缺省实现。
 *
 * 为每个插件插槽提供 Noop / 透传默认值，保证 AgentLoop 在未配置任何插件时
 * 行为与旧版一致（不持久化、不压缩、不重试、事件原样透传、放行所有工具）。
 */

import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  IContextPolicy,
  IEventAdapter,
  IObservability,
  IRetryPolicy,
  ISessionStore,
  IToolGuard,
} from './interfaces'

/**
 * 创建默认会话层实现：不持久化，load 恒返回空、列表恒为空。
 *
 * @returns 无操作 ISessionStore 实现。
 */
export function createNoopSessionStore(): ISessionStore {
  return {
    id: 'noop-session-store',
    load: async (_sessionId: string) => [],
    save: async (_sessionId: string, _messages: AgentMessage[]) => {},
    getSession: async () => undefined,
    listSessions: async () => [],
    remove: async (_sessionId: string) => {},
    removeBySkillId: async (_skillId: string) => [],
    upsertToolCall: async (_record) => {},
    listToolCalls: async (_sessionId: string, _query) => [],
  }
}

/**
 * 创建默认上下文层实现：不压缩、不主动收尾。
 *
 * @returns 原样透传消息的 IContextPolicy 实现。
 */
export function createNoopContextPolicy(): IContextPolicy {
  return {
    id: 'noop-context-policy',
    transform: async (messages: AgentMessage[]) => messages,
    shouldStopAfterTurn: async () => false,
  }
}

/**
 * 创建默认重试层实现：永不重试。
 *
 * @returns 无操作 IRetryPolicy 实现。
 */
export function createNoopRetryPolicy(): IRetryPolicy {
  return {
    id: 'noop-retry-policy',
    shouldRetry: async () => false,
    delayMs: async () => 0,
  }
}

/**
 * 创建默认事件适配器：原样透传 AgentEvent。
 *
 * @returns 保持旧版订阅行为的 IEventAdapter<AgentEvent> 实现。
 */
export function createPassthroughEventAdapter(): IEventAdapter<AgentEvent> {
  return {
    id: 'passthrough-event-adapter',
    translate: (event) => event,
  }
}

/**
 * 创建默认可观测层实现：所有钩子均为空操作。
 *
 * @returns 无操作 IObservability 实现。
 */
export function createNoopObservability(): IObservability {
  return { id: 'noop-observability' }
}

/**
 * 创建默认工具守卫：放行所有工具调用。
 *
 * @returns 无操作 IToolGuard 实现。
 */
export function createAllowAllToolGuard(): IToolGuard {
  return { id: 'allow-all-tool-guard' }
}

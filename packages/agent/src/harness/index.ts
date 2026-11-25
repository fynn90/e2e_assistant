/**
 * Harness 插件机制统一出口。
 *
 * 对外提供插件接口、插件集合与默认实现补齐函数，供 AgentLoop 与上层调用方使用。
 */

export { resolvePlugins } from './resolver'
export {
  createAllowAllToolGuard,
  createNoopContextPolicy,
  createNoopObservability,
  createNoopRetryPolicy,
  createNoopSessionStore,
  createPassthroughEventAdapter,
} from './defaults'
export type {
  IContextPolicy,
  IEventAdapter,
  IHarnessPlugins,
  IHarnessRunContext,
  IObservability,
  IResolvedPlugins,
  IRetryPolicy,
  IRunEndInfo,
  ISessionMeta,
  ISessionQuery,
  ISessionStatus,
  ISessionStore,
  ISessionSummary,
  IToolGuard,
} from './interfaces'
export {
  ClientEventBlockState,
  ClientEventTranslator,
  extractCommand,
  extractFileChange,
  isCommandTool,
  newBlockId,
  presentTool,
  type IClientEventTranslatorOptions,
  type IFileChangeInfo,
  type IToolPresentation,
} from './client-events'
export type {
  IToolCallQuery,
  IToolCallRecord,
  ToolCallStatus,
} from '../tool-trace/types'

/**
 * 客户端事件翻译层统一出口。
 *
 * 把 pi-agent-core 原始事件翻译为客户端渲染协议事件（TAgentClientEventDraft），
 * 供 CLI 网关装配信封后经 SSE 分发给 Web 客户端。
 */

export {
  ClientEventTranslator,
  type IClientEventTranslatorOptions,
} from './translator'
export { ClientEventBlockState, newBlockId } from './block-state'
export {
  presentTool,
  isCommandTool,
  extractCommand,
  extractFileChange,
  type IToolPresentation,
  type IFileChangeInfo,
} from './tool-presenter'

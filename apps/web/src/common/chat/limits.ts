export const CHAT_MAX_MESSAGES = 100
/**
 * 单条消息的最大字符数（v12-pre：与服务端 skill-chat 的 MAX_MESSAGE_CHARACTERS 对齐）。
 *
 * 调大理由：Agent 在页面核对阶段读取的页面快照上限从 24_000 提到 240_000，
 * 下游链路的单条上限必须同步抬升，否则 Agent 看到的与用户回看的不是同一份内容。
 */
export const CHAT_MAX_MESSAGE_CHARACTERS = 240_000
/** 历史总字符上限：保持为单条上限的 3 倍，避免单条就把整段历史挤空。 */
export const CHAT_MAX_REQUEST_CHARACTERS = 720_000

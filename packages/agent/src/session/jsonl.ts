/**
 * JSONL 版会话存储（规划中）。
 *
 * 基于 pi-agent-core 的 JsonlSessionRepo，把对话消息以 JSONL 落盘，
 * 实现进程重启后的对话恢复。属 Harness 阶段一「会话层」的下一个迭代项。
 */

// 待实现：createJsonlSessionStore({ dir, sessionId }): ISessionStore
// 参照 @earendil-works/pi-agent-core 的 JsonlSessionRepo 用法。

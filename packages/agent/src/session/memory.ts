/**
 * 内存版会话存储。
 *
 * 实现 ISessionStore 多会话仓库语义，数据保存在闭包 Map 内、随进程结束而丢失。
 * 仅用于本地调试 / 测试；生产环境应改用 createSqliteSessionStore（better-sqlite3），
 * 以支持历史会话查询与服务中断后的断点续跑。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ISessionMeta,
  ISessionQuery,
  ISessionStore,
  ISessionSummary,
} from '../harness/interfaces'
import type { IToolCallQuery, IToolCallRecord } from '../tool-trace/types'

/** 内存会话记录：消息快照 + 元信息 + 时间戳。 */
interface MemorySessionRecord {
  messages: AgentMessage[]
  meta?: ISessionMeta
  createdAt: number
  updatedAt: number
}

/**
 * 创建内存版会话存储。
 *
 * @returns 基于闭包 Map 的 ISessionStore 实现。
 * @remarks 覆盖式保存完整消息快照；列表按更新时间倒序、支持分页过滤。
 */
export function createMemorySessionStore(): ISessionStore {
  // 闭包内保存的会话记录，键为 sessionId。
  const records = new Map<string, MemorySessionRecord>()
  // 工具调用记录独立按会话保存，键为 sessionId -> runId/toolCallId。
  const toolCalls = new Map<string, Map<string, IToolCallRecord>>()

  return {
    id: 'memory-session-store',

    /**
     * 覆盖保存某会话的完整消息快照与元信息。
     *
     * @param sessionId - 会话 ID。
     * @param messages - 完整消息列表。
     * @param meta - 可选的会话元信息（skillId / status / title 等）。
     */
    save: async (
      sessionId: string,
      messages: AgentMessage[],
      meta?: ISessionMeta,
    ) => {
      const now = Date.now()
      const existing = records.get(sessionId)
      records.set(sessionId, {
        messages: [...messages],
        meta,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    },

    /**
     * 加载某会话的完整消息。
     *
     * @param sessionId - 会话 ID。
     * @returns 消息快照副本；会话不存在返回空数组。
     */
    load: async (sessionId: string) =>
      records.get(sessionId)?.messages.map((m) => ({ ...m })) ?? [],

    /**
     * 查询某会话的概要信息。
     *
     * @param sessionId - 会话 ID。
     * @returns 会话概要；不存在返回 undefined。
     */
    getSession: async (
      sessionId: string,
    ): Promise<ISessionSummary | undefined> => {
      const record = records.get(sessionId)
      if (!record) return undefined
      return toSummary(sessionId, record)
    },

    /**
     * 按条件查询会话列表（默认按更新时间倒序）。
     *
     * @param query - 过滤与分页条件。
     * @returns 会话概要数组。
     */
    listSessions: async (
      query: ISessionQuery = {},
    ): Promise<ISessionSummary[]> => {
      let list = [...records.entries()].map(([id, record]) =>
        toSummary(id, record),
      )

      if (query.skillId !== undefined) {
        list = list.filter((s) => s.skillId === query.skillId)
      }
      if (query.status !== undefined) {
        list = list.filter((s) => s.status === query.status)
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt)

      const page = query.page ?? 0
      const pageSize = query.pageSize ?? list.length
      return list.slice(page * pageSize, (page + 1) * pageSize)
    },

    /**
     * 增量写入一条工具调用记录。
     *
     * @param record - 已 JSON 安全化的完整工具调用事实。
     */
    upsertToolCall: async (record: IToolCallRecord) => {
      const sessionRecords = toolCalls.get(record.sessionId) ?? new Map()
      sessionRecords.set(toolCallKey(record), cloneToolCallRecord(record))
      toolCalls.set(record.sessionId, sessionRecords)
    },

    /**
     * 查询某个会话的工具调用记录。
     *
     * @param sessionId - 会话 ID。
     * @param query - 可选运行 ID 过滤条件。
     * @returns 按开始时间和稳定调用顺序排列的记录副本。
     */
    listToolCalls: async (
      sessionId: string,
      query: IToolCallQuery = {},
    ): Promise<IToolCallRecord[]> => {
      return [...(toolCalls.get(sessionId)?.values() ?? [])]
        .filter(
          (record) => query.runId === undefined || record.runId === query.runId,
        )
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt || left.sequence - right.sequence,
        )
        .map(cloneToolCallRecord)
    },

    /**
     * 删除会话及其全部消息和工具调用记录。
     *
     * @param sessionId - 会话 ID。
     */
    remove: async (sessionId: string) => {
      records.delete(sessionId)
      toolCalls.delete(sessionId)
    },

    /**
     * 删除所有关联某 Skill 的会话及其全部消息和工具调用记录。
     *
     * @param skillId - Skill ID。
     * @returns 被删除的会话 ID 列表。
     */
    removeBySkillId: async (skillId: string) => {
      const matchedIds = [...records.entries()]
        .filter(([, record]) => record.meta?.skillId === skillId)
        .map(([sessionId]) => sessionId)
      matchedIds.forEach((sessionId) => {
        records.delete(sessionId)
        toolCalls.delete(sessionId)
      })
      return matchedIds
    },
  }
}

/**
 * 把内存会话记录转换为概要对象。
 *
 * @param sessionId - 会话 ID。
 * @param record - 内存会话记录。
 * @returns 会话概要。
 */
function toSummary(
  sessionId: string,
  record: MemorySessionRecord,
): ISessionSummary {
  return {
    id: sessionId,
    messageCount: record.messages.length,
    status: record.meta?.status,
    skillId: record.meta?.skillId,
    workspace: record.meta?.workspace,
    title: record.meta?.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * 生成会话内工具调用记录的唯一键。
 *
 * @param record - 工具调用记录。
 * @returns 由运行 ID 与工具调用 ID 组成的唯一键。
 */
function toolCallKey(record: IToolCallRecord): string {
  return `${record.runId}:${record.toolCallId}`
}

/**
 * 深复制已 JSON 安全化的工具调用记录。
 *
 * @param record - 原始记录。
 * @returns 不与存储内部状态共享引用的副本。
 */
function cloneToolCallRecord(record: IToolCallRecord): IToolCallRecord {
  return JSON.parse(JSON.stringify(record)) as IToolCallRecord
}

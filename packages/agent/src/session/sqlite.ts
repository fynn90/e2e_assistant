/**
 * SQLite 版会话存储（better-sqlite3）。
 *
 * 实现 ISessionStore 多会话仓库语义，会话与消息持久化到本地 SQLite 数据库，
 * 支持历史会话查询（按 skillId / 状态过滤 + 分页）与服务中断后的断点续跑。
 *
 * 数据模型：
 *   - agent_sessions  会话主表（id 主键，冗余 skill_id / status / title 等过滤字段）
 *   - agent_messages  消息表（(session_id, seq) 复合主键，完整 AgentMessage 以 JSON 存储）
 *   - agent_tool_calls 工具调用审计表（按 session/run/toolCallId 增量 UPSERT）
 *
 * 打开连接时启用 WAL 与外键级联删除；save 在单个事务内完成「UPSERT 会话 + 覆盖消息」，
 * 工具调用事件则独立增量写入，避免长时间工具执行或中断时丢失已发生的审计事实。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  ISessionMeta,
  ISessionQuery,
  ISessionStatus,
  ISessionStore,
  ISessionSummary,
} from '../harness/interfaces'
import type { IToolCallQuery, IToolCallRecord } from '../tool-trace/types'

/** SQLite 会话存储的创建选项。 */
export interface ISqliteSessionStoreOptions {
  /** 数据库文件路径；支持 `~` 展开，父目录不存在会自动创建；`:memory:` 用于测试。 */
  dbPath: string
}

/** 会话主表行结构。 */
interface SessionRow {
  id: string
  skill_id: string | null
  workspace: string | null
  status: string
  title: string | null
  message_count: number
  created_at: number
  updated_at: number
}

/**
 * 创建基于 better-sqlite3 的会话存储。
 *
 * @param options - 数据库文件路径等选项。
 * @returns 实现 ISessionStore 的存储实例，额外提供 close() 用于显式关闭数据库。
 * @throws {Error} 当数据库文件无法打开、目录无法创建或建表失败时，透传 better-sqlite3 异常。
 */
export function createSqliteSessionStore(
  options: ISqliteSessionStoreOptions,
): ISessionStore & { close(): void } {
  const dbPath = normalizeDbPath(options.dbPath)
  const db = openDatabase(dbPath)

  // 预编译语句，避免每次调用重复解析 SQL。
  const stmtSelectSession = db.prepare(
    'SELECT * FROM agent_sessions WHERE id = ?',
  )
  const stmtInsertSession = db.prepare(`
    INSERT INTO agent_sessions
      (id, skill_id, workspace, status, title, message_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      skill_id = excluded.skill_id,
      workspace = excluded.workspace,
      status = excluded.status,
      title = excluded.title,
      message_count = excluded.message_count,
      updated_at = excluded.updated_at
  `)
  const stmtDeleteMessages = db.prepare(
    'DELETE FROM agent_messages WHERE session_id = ?',
  )
  const stmtInsertMessage = db.prepare(`
    INSERT INTO agent_messages (session_id, seq, role, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  // 工具事件可能先于本轮完整消息快照到达，因此先创建最小会话行以满足外键约束。
  const stmtEnsureSession = db.prepare(`
    INSERT INTO agent_sessions
      (id, skill_id, workspace, status, title, message_count, created_at, updated_at)
    VALUES (?, NULL, NULL, 'active', NULL, 0, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
  const stmtUpsertToolCall = db.prepare(`
    INSERT INTO agent_tool_calls
      (session_id, run_id, tool_call_id, call_sequence, tool_name, tool_label, status, record, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, run_id, tool_call_id) DO UPDATE SET
      call_sequence = excluded.call_sequence,
      tool_name = excluded.tool_name,
      tool_label = excluded.tool_label,
      status = excluded.status,
      record = excluded.record,
      updated_at = excluded.updated_at
  `)
  const stmtSelectToolCalls = db.prepare(
    'SELECT record FROM agent_tool_calls WHERE session_id = ? ORDER BY created_at ASC, call_sequence ASC',
  )
  const stmtSelectToolCallsByRun = db.prepare(
    'SELECT record FROM agent_tool_calls WHERE session_id = ? AND run_id = ? ORDER BY created_at ASC, call_sequence ASC',
  )
  const stmtSelectMessages = db.prepare(
    'SELECT message FROM agent_messages WHERE session_id = ? ORDER BY seq',
  )
  const stmtDeleteSession = db.prepare(
    'DELETE FROM agent_sessions WHERE id = ?',
  )
  const stmtSelectSessionIdsBySkill = db.prepare(
    'SELECT id FROM agent_sessions WHERE skill_id = ?',
  )
  const stmtDeleteSessionsBySkill = db.prepare(
    'DELETE FROM agent_sessions WHERE skill_id = ?',
  )

  // 覆盖式保存：单个事务内 UPSERT 会话 + 清空重写消息，保证幂等与原子性。
  const saveTransaction = db.transaction(
    (
      sessionId: string,
      messages: AgentMessage[],
      meta: ISessionMeta | undefined,
    ) => {
      const now = Date.now()
      const existing = stmtSelectSession.get(sessionId) as
        Pick<SessionRow, 'created_at' | 'status'> | undefined
      const createdAt = existing?.created_at ?? now
      const status: ISessionStatus =
        meta?.status ??
        (existing ? (existing.status as ISessionStatus) : 'active')

      stmtInsertSession.run(
        sessionId,
        toNullable(meta?.skillId),
        toNullable(meta?.workspace),
        status,
        toNullable(meta?.title),
        messages.length,
        createdAt,
        now,
      )
      stmtDeleteMessages.run(sessionId)
      messages.forEach((message, seq) => {
        stmtInsertMessage.run(
          sessionId,
          seq,
          message.role,
          JSON.stringify(message),
          now,
        )
      })
    },
  )

  return {
    id: 'sqlite-session-store',

    /**
     * 覆盖保存某会话的完整消息快照与元信息。
     *
     * @param sessionId - 会话 ID。
     * @param messages - 完整消息列表。
     * @param meta - 可选的会话元信息；未指定 status 时保留会话既有状态。
     */
    save: async (
      sessionId: string,
      messages: AgentMessage[],
      meta?: ISessionMeta,
    ) => {
      saveTransaction(sessionId, messages, meta)
    },

    /**
     * 加载某会话的完整消息（按会话内序号有序）。
     *
     * @param sessionId - 会话 ID。
     * @returns 反序列化后的消息数组；会话不存在返回空数组。
     * @throws {SyntaxError} 当存储中的消息 JSON 损坏无法解析时抛出。
     */
    load: async (sessionId: string) => {
      const rows = stmtSelectMessages.all(sessionId) as {
        message: string
      }[]
      return rows.map((row) => JSON.parse(row.message) as AgentMessage)
    },

    /**
     * 查询某会话的概要信息。
     *
     * @param sessionId - 会话 ID。
     * @returns 会话概要；不存在返回 undefined。
     */
    getSession: async (
      sessionId: string,
    ): Promise<ISessionSummary | undefined> => {
      const row = stmtSelectSession.get(sessionId) as SessionRow | undefined
      return row ? toSummary(row) : undefined
    },

    /**
     * 按条件查询会话列表（默认按更新时间倒序、可分页）。
     *
     * @param query - 过滤与分页条件。
     * @returns 会话概要数组。
     */
    listSessions: async (query: ISessionQuery = {}) => {
      const conditions: string[] = []
      const params: unknown[] = []
      if (query.skillId !== undefined) {
        conditions.push('skill_id = ?')
        params.push(query.skillId)
      }
      if (query.status !== undefined) {
        conditions.push('status = ?')
        params.push(query.status)
      }
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      let limitClause = ''
      if (query.pageSize !== undefined) {
        const page = query.page ?? 0
        limitClause = ' LIMIT ? OFFSET ?'
        params.push(query.pageSize, page * query.pageSize)
      }

      const rows = db
        .prepare(
          `SELECT * FROM agent_sessions ${where} ORDER BY updated_at DESC${limitClause}`,
        )
        .all(...params) as SessionRow[]
      return rows.map(toSummary)
    },

    /**
     * 增量写入或更新一条工具调用审计记录。
     *
     * @param record - 已 JSON 安全化的工具调用完整事实。
     * @throws {Error} 当 SQLite 写入失败时透传数据库异常。
     */
    upsertToolCall: async (record: IToolCallRecord) => {
      const now = Date.now()
      // 工具事件先于消息快照发生时，确保其所属会话可被外键引用。
      stmtEnsureSession.run(record.sessionId, record.startedAt, now)
      stmtUpsertToolCall.run(
        record.sessionId,
        record.runId,
        record.toolCallId,
        record.sequence,
        record.toolName,
        toNullable(record.toolLabel),
        record.status,
        JSON.stringify(record),
        record.startedAt,
        record.updatedAt,
      )
    },

    /**
     * 按会话读取工具调用审计记录。
     *
     * @param sessionId - 会话 ID。
     * @param query - 可选运行 ID 过滤条件。
     * @returns 按调用开始时间与调用顺序排序的记录数组。
     * @throws {SyntaxError} 当存储的工具记录 JSON 损坏时抛出。
     */
    listToolCalls: async (
      sessionId: string,
      query: IToolCallQuery = {},
    ): Promise<IToolCallRecord[]> => {
      const rows = (
        query.runId === undefined
          ? stmtSelectToolCalls.all(sessionId)
          : stmtSelectToolCallsByRun.all(sessionId, query.runId)
      ) as {
        record: string
      }[]
      return rows.map((row) => JSON.parse(row.record) as IToolCallRecord)
    },

    /**
     * 删除某会话及其全部消息和工具调用记录（外键级联）。
     *
     * @param sessionId - 会话 ID。
     */
    remove: async (sessionId: string) => {
      stmtDeleteSession.run(sessionId)
    },

    /**
     * 删除所有关联某 Skill 的会话及其全部消息和工具调用记录（外键级联）。
     *
     * @param skillId - Skill ID。
     * @returns 被删除的会话 ID 列表。
     */
    removeBySkillId: async (skillId: string) => {
      const rows = stmtSelectSessionIdsBySkill.all(skillId) as { id: string }[]
      stmtDeleteSessionsBySkill.run(skillId)
      return rows.map((row) => row.id)
    },

    /**
     * 关闭数据库连接。使用 `:memory:` 或测试完成后应显式调用以释放资源。
     */
    close: () => {
      db.close()
    },
  }
}

/**
 * 规范化数据库路径：展开 `~` 并转为绝对路径。
 *
 * @param dbPath - 原始路径。
 * @returns 规范化后的绝对路径。
 */
function normalizeDbPath(dbPath: string): string {
  if (dbPath === ':memory:') return dbPath
  const expanded = dbPath.startsWith('~')
    ? dbPath.replace('~', homedir())
    : dbPath
  return resolve(expanded)
}

/**
 * 打开数据库并执行初始化：确保父目录存在、设置 WAL 与外键、建表建索引。
 *
 * @param dbPath - 规范化后的数据库路径。
 * @returns 已初始化的 better-sqlite3 数据库实例。
 * @throws {Error} 当目录创建或建表失败时透传底层异常。
 */
function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  return db
}

/** 会话表与消息表 DDL。 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_sessions (
    id            TEXT PRIMARY KEY,
    skill_id      TEXT,
    workspace     TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    title         TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_messages (
    session_id  TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL,
    message     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS agent_tool_calls (
    session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    run_id        TEXT NOT NULL,
    tool_call_id  TEXT NOT NULL,
    call_sequence INTEGER NOT NULL,
    tool_name     TEXT NOT NULL,
    tool_label    TEXT,
    status        TEXT NOT NULL,
    record        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (session_id, run_id, tool_call_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON agent_messages (session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON agent_tool_calls (session_id, created_at, call_sequence);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON agent_tool_calls (session_id, run_id, call_sequence);
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON agent_sessions (updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_skill   ON agent_sessions (skill_id);
`

/**
 * 把会话主表行转换为概要对象。
 *
 * @param row - 会话行。
 * @returns 会话概要。
 */
function toSummary(row: SessionRow): ISessionSummary {
  return {
    id: row.id,
    messageCount: row.message_count,
    status: row.status as ISessionStatus,
    skillId: toUndefined(row.skill_id),
    workspace: toUndefined(row.workspace),
    title: toUndefined(row.title),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 把可空字符串转成 undefined（undefined 交由 better-sqlite3 绑定为 NULL）。
 *
 * @param value - 可空字符串。
 * @returns null（数据库绑定用）或原值。
 */
function toNullable(value: string | undefined): string | null {
  return value ?? null
}

/**
 * 把数据库 NULL 转成 undefined，对齐 ISessionSummary 的可选字段。
 *
 * @param value - 可空字符串。
 * @returns undefined 或原值。
 */
function toUndefined(value: string | null): string | undefined {
  return value ?? undefined
}

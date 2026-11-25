/**
 * 工作块存储（SQLite）：Agent 工作过程的物化展示存储。
 *
 * 本存储服务「用户视图恢复」：把事件总线发布的客户端事件就地物化为
 * 「一个工作块一行」的当前状态，供会话列表与历史时间线接口直接查询，
 * 客户端恢复时无需重放事件。
 *
 * 与 agent 层的 ISessionStore（模型上下文存储）职责分离：
 * 那边管「模型需要什么」，这边管「人想看什么」。
 *
 * 数据模型：
 *   - work_sessions  会话表（种类 / 标题 / 状态 / 最近事件序号）
 *   - work_blocks    工作块表（(session_id, block_id) 主键，payload 为按 kind 累积的 JSON）
 *
 * 瞬态事件（status / heartbeat / file_change）不落盘——文件树恢复以磁盘为准。
 *
 * 表结构变更约定（开发阶段）：
 *   本存储不实现列迁移。`CREATE TABLE IF NOT EXISTS` 对已存在的表整体跳过、
 *   不会补列，因此**修改表结构后必须重建数据库**，否则旧库会在首次写入时
 *   报「no such column」。执行 `pnpm db:reset` 删除全部本地数据并重建。
 *   该库只存展示数据（模型上下文另存 sessions.db），重建不影响业务正确性。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type {
  IAgentSessionSummary,
  IAgentWorkBlock,
  TAgentClientEvent,
  TAgentSessionKind,
  TAgentWorkBlockKind,
  TAgentWorkBlockStatus,
} from '@authine-e2e-agent/types'

/** 会话标题的最大字符数（首条用户消息截断生成）。 */
const MAX_TITLE_CHARACTERS = 80

/** 工作块存储接口。 */
export interface IWorkBlockStore {
  /** 把一条事件物化到工作块 / 会话表。 */
  applyEvent(event: TAgentClientEvent): void
  /**
   * 声明会话种类（创建期属性，与事件流解耦）。
   *
   * @param sessionId - 会话 ID。
   * @param kind - 会话种类：'chat' 为用户对话，'generation' 为平台生成任务。
   */
  registerSession(sessionId: string, kind: TAgentSessionKind): void
  /**
   * 查询会话列表（按最近活跃倒序）。
   *
   * @param options.kind - 只返回指定种类的会话；缺省返回全部。
   */
  listSessions(options?: { kind?: TAgentSessionKind }): IAgentSessionSummary[]
  /** 查询指定会话的全部工作块（按 seq 升序）。 */
  listBlocks(sessionId: string): IAgentWorkBlock[]
  /** 查询指定会话已物化的最大事件序号（断线补发起点）。 */
  maxSeq(sessionId: string): number
  /**
   * 重命名一个会话（v17 S1）。只改标题，不动工作块与 seq 进度。
   *
   * @param sessionId - 会话 ID。
   * @param title - 新标题（已 trim）。空标题会被拒绝（保持原值）。
   * @returns 是否找到并更新了会话。
   * @throws 不抛出异常。
   */
  renameSession(sessionId: string, title: string): boolean
  /** 删除指定会话的全部数据。 */
  removeSession(sessionId: string): void
  /** 批量删除多个会话的全部数据。 */
  removeSessions(sessionIds: string[]): void
  /** 关闭数据库连接。 */
  close(): void
}

/** 工作块表行结构。 */
interface IWorkBlockRow {
  session_id: string
  block_id: string
  seq: number
  run_id: string
  kind: string
  status: string
  payload: string
  created_at: number
  updated_at: number
}

/** 会话表行结构。 */
interface IWorkSessionRow {
  session_id: string
  kind: string
  title: string
  status: string
  max_seq: number
  created_at: number
  updated_at: number
}

/**
 * 创建基于 better-sqlite3 的工作块存储。
 *
 * @param options.dbPath - 数据库文件路径；`:memory:` 用于测试。
 * @returns 工作块存储实例。
 * @throws {Error} 当数据库文件无法打开、目录无法创建或建表失败时，透传 better-sqlite3 异常。
 */
export function createWorkBlockStore(options: {
  dbPath: string
}): IWorkBlockStore {
  const db = openDatabase(options.dbPath)

  // 事件驱动的会话行 upsert：不触碰 kind——会话种类是创建期属性，
  // 由 registerSession 单独声明，避免每次事件都覆写。
  const stmtUpsertSession = db.prepare(`
    INSERT INTO work_sessions (session_id, title, status, max_seq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE work_sessions.title END,
      status = CASE WHEN excluded.status != '' THEN excluded.status ELSE work_sessions.status END,
      max_seq = excluded.max_seq,
      updated_at = excluded.updated_at
  `)
  // 会话种类声明：行不存在时先建（max_seq=0），已存在时只更新 kind。
  const stmtRegisterSession = db.prepare(`
    INSERT INTO work_sessions (session_id, kind, title, status, max_seq, created_at, updated_at)
    VALUES (?, ?, '', 'idle', 0, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET kind = excluded.kind
  `)
  const stmtUpsertBlock = db.prepare(`
    INSERT INTO work_blocks
      (session_id, block_id, seq, run_id, kind, status, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, block_id) DO UPDATE SET
      status = excluded.status,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `)
  const stmtSelectBlock = db.prepare(
    'SELECT * FROM work_blocks WHERE session_id = ? AND block_id = ?',
  )
  const stmtListSessions = db.prepare(
    'SELECT * FROM work_sessions ORDER BY updated_at DESC',
  )
  const stmtListBlocks = db.prepare(
    'SELECT * FROM work_blocks WHERE session_id = ? ORDER BY seq ASC',
  )
  const stmtMaxSeq = db.prepare(
    'SELECT max_seq FROM work_sessions WHERE session_id = ?',
  )
  const stmtDeleteSession = db.prepare(
    'DELETE FROM work_sessions WHERE session_id = ?',
  )
  // v17 S1：重命名只改标题与活跃时间——**不碰** max_seq
  //（那是 seq 分配的起点，改了会让后续事件的序号与已物化的块错位）。
  const stmtRenameSession = db.prepare(
    'UPDATE work_sessions SET title = ?, updated_at = ? WHERE session_id = ?',
  )
  // 在单个事务内批量删除多个会话（外键级联清空对应工作块）。
  const stmtDeleteSessions = db.transaction((sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      stmtDeleteSession.run(sessionId)
    }
  })

  /** 读取已有块（物化更新需要基于当前状态累积）。 */
  function getBlock(
    sessionId: string,
    blockId: string,
  ): IAgentWorkBlock | undefined {
    const row = stmtSelectBlock.get(sessionId, blockId) as
      IWorkBlockRow | undefined
    return row ? toWorkBlock(row) : undefined
  }

  /** 写出一个块的最新状态（不存在则创建）。 */
  function putBlock(block: IAgentWorkBlock): void {
    stmtUpsertBlock.run(
      block.sessionId,
      block.blockId,
      block.seq,
      block.runId,
      block.kind,
      block.status,
      JSON.stringify(block.payload),
      block.createdAt,
      block.updatedAt,
    )
  }

  /**
   * 推进会话行：确保会话存在（满足工作块外键）并把 max_seq 推进到当前事件序号。
   *
   * 所有事件（含瞬态）都必须调用——max_seq 是重启后 seq 分配的起点，
   * 瞬态事件不落块但同样消耗序号。title / status 传空串表示保持原值。
   */
  function touchSession(
    sessionId: string,
    event: TAgentClientEvent,
    patch: { title?: string; status?: string },
  ): void {
    stmtUpsertSession.run(
      sessionId,
      patch.title ?? '',
      patch.status ?? '',
      event.seq,
      event.timestamp,
      event.timestamp,
    )
  }

  /** 基于已有块（或新块）应用一次物化更新。 */
  function mutateBlock(
    event: TAgentClientEvent,
    kind: TAgentWorkBlockKind,
    runId: string,
    mutate: (
      payload: Record<string, unknown>,
      block: IAgentWorkBlock,
    ) => TAgentWorkBlockStatus,
  ): void {
    const existing = getBlock(event.sessionId, event.blockId)
    const block: IAgentWorkBlock = existing ?? {
      sessionId: event.sessionId,
      blockId: event.blockId,
      seq: event.seq,
      runId,
      kind,
      status: 'streaming',
      payload: {},
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    }
    block.status = mutate(block.payload, block)
    block.updatedAt = event.timestamp
    putBlock(block)
  }

  return {
    applyEvent(event: TAgentClientEvent): void {
      // 所有事件先推进会话行：保证工作块外键有依托、max_seq 覆盖瞬态事件。
      touchSession(event.sessionId, event, {})
      switch (event.type) {
        case 'turn':
          if (event.phase === 'begin') {
            touchSession(event.sessionId, event, {
              title: event.inputPreview
                ? event.inputPreview.slice(0, MAX_TITLE_CHARACTERS)
                : undefined,
              status: 'running',
            })
            mutateBlock(event, 'turn', event.runId, (payload) => {
              payload.runId = event.runId
              payload.inputPreview = event.inputPreview
              return 'streaming'
            })
          } else {
            touchSession(event.sessionId, event, {
              status: event.outcome === 'failed' ? 'error' : 'idle',
            })
            mutateBlock(event, 'turn', event.runId, (payload) => {
              payload.outcome = event.outcome
              payload.errorMessage = event.errorMessage
              payload.usage = event.usage
              return event.outcome === 'failed' ? 'failed' : 'done'
            })
          }
          return

        case 'thinking':
          mutateBlock(
            event,
            'thinking',
            currentRunId(event),
            (payload, block) => {
              if (event.phase === 'begin') return 'streaming'
              if (event.phase === 'append') {
                payload.text = `${(payload.text as string) ?? ''}${event.text}`
                return block.status
              }
              payload.durationMs = event.durationMs
              return 'done'
            },
          )
          return

        case 'content':
          mutateBlock(
            event,
            'content',
            currentRunId(event),
            (payload, block) => {
              if (event.phase === 'begin') {
                payload.contentType = event.contentType
                payload.language = event.language
                return 'streaming'
              }
              if (event.phase === 'append') {
                payload.text = `${(payload.text as string) ?? ''}${event.text}`
                return block.status
              }
              return 'done'
            },
          )
          return

        case 'tool':
          mutateBlock(event, 'tool', currentRunId(event), (payload, block) => {
            if (event.phase === 'begin') {
              payload.category = event.tool.category
              // 动作必须一并物化：会话恢复时客户端靠它选图标，
              // 漏存会让历史会话的图标全部退化为兜底扳手。
              payload.action = event.tool.action
              payload.title = event.tool.title
              payload.subtitle = event.tool.subtitle
              payload.toolName = event.tool.toolName
              payload.argumentsPreview = event.tool.argumentsPreview
              return 'streaming'
            }
            if (event.phase === 'append') {
              payload.text = `${(payload.text as string) ?? ''}${event.text}`
              return block.status
            }
            payload.summary = event.summary
            payload.durationMs = event.durationMs
            return event.status === 'failed' ? 'failed' : 'done'
          })
          return

        case 'todo':
          // 清单是整体替换语义：每次更新覆盖同一块的 payload，
          // 客户端拿到的是「当前完整清单」，无需重放历史事件。
          mutateBlock(event, 'todo', currentRunId(event), (payload) => {
            payload.items = event.items
            return 'done'
          })
          return

        case 'command':
          mutateBlock(
            event,
            'command',
            currentRunId(event),
            (payload, block) => {
              if (event.phase === 'begin') {
                payload.command = event.command
                payload.cwd = event.cwd
                return 'streaming'
              }
              if (event.phase === 'append') {
                const key = event.stream === 'stderr' ? 'stderr' : 'stdout'
                payload[key] = `${(payload[key] as string) ?? ''}${event.text}`
                return block.status
              }
              payload.exitCode = event.exitCode
              payload.durationMs = event.durationMs
              return event.exitCode === 0 ? 'done' : 'failed'
            },
          )
          return

        case 'interaction':
          // 等待用户回答期间会话进入 waiting_user（会话列表据此展示角标）。
          touchSession(event.sessionId, event, {
            status: event.phase === 'begin' ? 'waiting_user' : 'running',
          })
          mutateBlock(event, 'interaction', currentRunId(event), (payload) => {
            if (event.phase === 'begin') {
              payload.interaction = event.interaction
              return 'pending'
            }
            payload.answer = event.answer
            payload.answeredBy = event.answeredBy
            return 'answered'
          })
          return

        case 'notice':
          mutateBlock(event, 'notice', currentRunId(event), (payload) => {
            payload.level = event.level
            payload.message = event.message
            return event.level === 'error' ? 'failed' : 'done'
          })
          return

        case 'workbench_action':
          // 动作卡片（v16）：一次性入口，状态由 pending 定格为 consumed/expired。
          // 服务端以同一 blockId 重发事件表达状态变化，此处整体覆盖 payload。
          mutateBlock(
            event,
            'workbench_action',
            currentRunId(event),
            (payload) => {
              payload.actionId = event.actionId
              payload.action = event.action
              payload.skillId = event.skillId
              payload.skillTitle = event.skillTitle
              payload.label = event.label
              payload.description = event.description
              payload.requiresConfirm = event.requiresConfirm
              payload.state = event.state
              return event.state === 'pending' ? 'pending' : 'done'
            },
          )
          return

        case 'workbench_task':
          // 任务卡片（v16）：启动时 running，终态时以同一 blockId 重发并携带摘要。
          // 摘要必须一并物化——历史回看的卡片终态完全依赖它（PRD LOG-2）。
          mutateBlock(
            event,
            'workbench_task',
            currentRunId(event),
            (payload) => {
              payload.taskId = event.taskId
              payload.taskKind = event.taskKind
              payload.skillId = event.skillId
              payload.skillTitle = event.skillTitle
              payload.status = event.status
              payload.startedAt = event.startedAt
              payload.executionId = event.executionId
              payload.summary = event.summary
              payload.errorMessage = event.errorMessage
              payload.artifacts = event.artifacts
              // v17 batch 分支：条目进度与批次状态必须一并物化——历史回看时
              // 连续执行卡的汇总完全依赖它（与执行卡的 summary 同源约束）。
              payload.batchStatus = event.batchStatus
              payload.items = event.items
              payload.batchLimit = event.batchLimit
              return event.status === 'running'
                ? 'streaming'
                : event.status === 'failed'
                  ? 'failed'
                  : 'done'
            },
          )
          return

        case 'workbench_report':
          // 报告卡片（v16，RPT-2/RPT-3）：与执行卡片平级的独立一块，只在执行
          // 终态发布一次、不更新。统计与报告路径必须整体物化——历史回看时
          // 报告总结完全依赖它（PRD LOG-2）。
          mutateBlock(
            event,
            'workbench_report',
            currentRunId(event),
            (payload) => {
              payload.executionId = event.executionId
              payload.skillId = event.skillId
              payload.skillTitle = event.skillTitle
              payload.taskStatus = event.taskStatus
              payload.summary = event.summary
              return event.taskStatus === 'failed' ? 'failed' : 'done'
            },
          )
          return

        case 'workbench_view':
          // 只读视图卡（v17）：发布即终态，没有状态迁移。同一 viewId 重发即
          // 原位更新（清单卡筛选后走这条路），因此 payload 整体覆盖。
          // payload 由宿主自取后填充——存储层不理解它的内部结构（协议分层）。
          mutateBlock(
            event,
            'workbench_view',
            currentRunId(event),
            (payload) => {
              payload.viewId = event.viewId
              payload.viewKind = event.viewKind
              payload.skillId = event.skillId
              payload.payload = event.payload
              return 'done'
            },
          )
          return

        case 'workbench_proposal':
          // 提案卡（v17）：与动作卡片同构——创建时 pending，用户操作后以同一
          // proposalId 重发表达终态。整体覆盖保证终态字段（resultMessage）落盘，
          // 历史回看时卡片按终态定格（C6）。
          //
          // 安全约定：载荷里**永远没有值**——env 补齐只物化 key（D7）。
          mutateBlock(
            event,
            'workbench_proposal',
            currentRunId(event),
            (payload) => {
              payload.proposalId = event.proposalId
              payload.proposalKind = event.proposalKind
              payload.skillId = event.skillId
              payload.skillTitle = event.skillTitle
              payload.label = event.label
              payload.description = event.description
              payload.state = event.state
              payload.changes = event.changes
              payload.envKeys = event.envKeys
              payload.envKeyOps = event.envKeyOps
              payload.requiresModalConfirm = event.requiresModalConfirm
              payload.reportCount = event.reportCount
              payload.releaseBytes = event.releaseBytes
              payload.evidence = event.evidence
              payload.resultMessage = event.resultMessage
              return event.state === 'pending' ? 'pending' : 'done'
            },
          )
          return

        default:
          // status / heartbeat / file_change：瞬态旁路事件，不产生物化块
          //（会话行与 max_seq 已在函数入口推进）。
          return
      }
    },

    registerSession(sessionId: string, kind: TAgentSessionKind): void {
      const now = Date.now()
      stmtRegisterSession.run(sessionId, kind, now, now)
    },

    listSessions(
      options: { kind?: TAgentSessionKind } = {},
    ): IAgentSessionSummary[] {
      const rows = stmtListSessions.all() as IWorkSessionRow[]
      return rows
        .filter(
          (row) => options.kind === undefined || row.kind === options.kind,
        )
        .map((row) => ({
          sessionId: row.session_id,
          kind: row.kind as TAgentSessionKind,
          title: row.title,
          status: row.status as IAgentSessionSummary['status'],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }))
    },

    listBlocks(sessionId: string): IAgentWorkBlock[] {
      const rows = stmtListBlocks.all(sessionId) as IWorkBlockRow[]
      return rows.map(toWorkBlock)
    },

    maxSeq(sessionId: string): number {
      const row = stmtMaxSeq.get(sessionId) as { max_seq: number } | undefined
      return row?.max_seq ?? 0
    },

    renameSession(sessionId: string, title: string): boolean {
      // 空标题按「不修改」处理：会话列表的展示依赖标题，清空会让条目变成
      // 「未命名会话」而用户以为自己输入成功了。
      if (!title) return false
      const result = stmtRenameSession.run(title, Date.now(), sessionId)
      return result.changes > 0
    },

    removeSession(sessionId: string): void {
      stmtDeleteSession.run(sessionId)
    },

    removeSessions(sessionIds: string[]): void {
      if (sessionIds.length === 0) return
      stmtDeleteSessions(sessionIds)
    },

    close(): void {
      db.close()
    },
  }
}

/** 从事件中推断所属运行 ID（turn 事件自带，其余块事件从块记录延续，缺省空串）。 */
function currentRunId(event: TAgentClientEvent): string {
  return event.type === 'turn' ? event.runId : ''
}

/** 数据库行 → 工作块对象。 */
function toWorkBlock(row: IWorkBlockRow): IAgentWorkBlock {
  return {
    sessionId: row.session_id,
    blockId: row.block_id,
    seq: row.seq,
    runId: row.run_id,
    kind: row.kind as TAgentWorkBlockKind,
    status: row.status as TAgentWorkBlockStatus,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 打开数据库并初始化表结构（WAL + 外键级联删除 + 增量列升级）。 */
function openDatabase(dbPath: string): Database.Database {
  const normalized = dbPath === ':memory:' ? dbPath : resolve(dbPath)
  if (normalized !== ':memory:') {
    mkdirSync(dirname(normalized), { recursive: true })
  }
  const db = new Database(normalized)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_sessions (
      session_id   TEXT PRIMARY KEY,
      kind         TEXT NOT NULL DEFAULT 'chat',
      title        TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'idle',
      max_seq      INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_blocks (
      session_id   TEXT NOT NULL REFERENCES work_sessions(session_id) ON DELETE CASCADE,
      block_id     TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      run_id       TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      payload      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, block_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_blocks_session ON work_blocks(session_id, seq);
  `)
  return db
}

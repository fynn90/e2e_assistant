/**
 * 会话层统一出口。
 *
 * 提供 ISessionStore（会话持久化 / 历史查询 / 断点续跑）与 IContextPolicy（上下文压缩）的实现。
 * 主选 better-sqlite3 存储；内存版仅作本地调试 / 测试备选。
 */

export {
  createSqliteSessionStore,
  type ISqliteSessionStoreOptions,
} from './sqlite'
export { createMemorySessionStore } from './memory'

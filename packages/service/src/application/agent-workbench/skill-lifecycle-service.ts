/**
 * 用例生命周期服务（v17 §6.6）：把删除逻辑从路由抽出，并补上任务冲突检查。
 *
 * ## 为什么必须抽出来（F12）
 *
 * 原实现里 `deleteSkill`（文件层 + 索引）与 `purgeSkillDatabaseData`（DB 级联）
 * 都写在 `skill-delete.ts` 路由的 handler 里，**不可复用**——而 v17 要求
 * 「用例删除」在对话流内也能走（L2），两条入口必须共享同一段逻辑
 *（否则安全边界会分叉，这是最不该分叉的地方）。
 *
 * ## L2c 的任务检查（F13/F28 的修正）
 *
 * 三层（路由、文件层、DB 层）**都没有**「有任务运行中」的检查。后果比初稿描述
 * 更重：**当前删掉正在执行的用例会 `rm -rf` 掉浏览器仍在使用的目录**，
 * 报告写入落到已删目录仅记日志。
 *
 * 为什么一次 `currentSessionId` 检查对生成与执行都够用：生成侧在
 * `playwright-generation.ts` 与 `generation-orchestrator.ts` 各自 acquire，
 * 执行侧在就绪校验通过后 acquire——**两侧共用同一个 `runningTasks` 映射**，
 * 因此一次查询同时覆盖两个方向。
 *
 * 这一处修正**顺带修好了 Skill 管理页的同一缺陷**（R13：行为变化是有意的，
 * 删除入口在任务运行时被拒是正确行为）。
 */

import { existsSync } from 'node:fs'
import { deleteSkill } from '@fynn90-e2e_assistant/skill-manager'
import { createSqliteSessionStore } from '@fynn90-e2e_assistant/agent'
import { ApiError } from '../../shared/errors/api-error'
import {
  createWorkBlockStore,
  resolveRuntimeDbPaths,
} from '../../agent-runtime/index'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'

/**
 * 用例删除的输入。
 */
export interface IDeleteCaseInput {
  /** 工作区根目录。 */
  rootDir: string
  /** 目标用例 ID（9 位 [a-z0-9]）。 */
  skillId: string
  /**
   * 任务注册表（L2c 的判定来源）。
   *
   * 必填而非可选：漏传等于把「删掉正在执行的用例」这个缺陷重新引入，
   * 让它在编译期就不可能发生（接口隔离 + 依赖倒转）。
   */
  taskRegistry: IGenerationTaskRegistry
}

/** 用例生命周期服务接口。 */
export interface ISkillLifecycleService {
  /**
   * 删除一个用例（文件层 + 索引 + 数据库级联）。
   *
   * @param input - 工作区、目标与任务注册表。
   * @returns 删除用时（毫秒），供卡片的「已删除」终态展示。
   * @throws ApiError（EXECUTION_MUTEX_CONFLICT / 429）该用例有运行中的任务（L2c）。
   * @throws SkillManagerError 目标不存在、索引损坏或权限不足时抛出（由路由映射为 HTTP）。
   */
  deleteCase (input: IDeleteCaseInput): Promise<void>
}

/**
 * 创建用例生命周期服务。
 *
 * @returns 服务实例。
 * @throws 不抛出异常。
 */
export function createSkillLifecycleService (): ISkillLifecycleService {
  return {
    async deleteCase (input) {
      const { rootDir, skillId, taskRegistry } = input

      // L2c：有任务在跑就拒绝——不区分生成还是执行（两侧共用同一映射）。
      // 错误码沿用任务注册表自身的 `CHAT_CONCURRENCY_LIMITED`（429），
      // 与「已有任务在运行」在同一套语义里，前端可统一按「先停任务」处理。
      const running = taskRegistry.currentSessionId(skillId)
      if (running) {
        throw new ApiError({
          code: 'CHAT_CONCURRENCY_LIMITED',
          status: 429,
          message:
            '该用例正在执行或有生成任务在跑，删除会破坏正在使用的目录与报告写入。请先停止任务（执行卡片上的「停止执行」或生成卡片上的中止），再删除。',
        })
      }

      // 文件层：删除不可变目录并从全局索引剔除（skill-manager 的既有能力）。
      await deleteSkill({ rootDir }, skillId)

      // 数据库层：best-effort 清理关联会话 / 工作块，失败不影响删除结果
      //（与路由的既有处置一致：DB 数据只是展示层，删不掉不影响业务正确性）。
      await purgeSkillDatabaseData(rootDir, skillId)
    },
  }
}

/**
 * 清理用例关联的数据库数据（会话与工作块）。
 *
 * @param workspace - 工作区根目录。
 * @param skillId - 用例 ID。
 * @returns 清理完成时兑现；失败时记日志并返回（不抛出）。
 * @throws 不抛出异常。
 */
async function purgeSkillDatabaseData (
  workspace: string,
  skillId: string,
): Promise<void> {
  const { sessionsDbPath, workBlocksDbPath } = resolveRuntimeDbPaths(workspace)
  try {
    const removedSessionIds = await removeSessionsBySkillId(
      sessionsDbPath,
      skillId,
    )
    removeWorkBlocksBySessionIds(workBlocksDbPath, removedSessionIds)
  } catch (error) {
    console.warn(`清理 Skill ${skillId} 的数据库数据失败：`, error)
  }
}

/**
 * 删除会话库中绑定该用例的会话，返回被删的会话 ID。
 *
 * @param sessionsDbPath - 会话数据库路径。
 * @param skillId - 用例 ID。
 * @returns 被删除的会话 ID 列表；库不存在时为空数组。
 * @throws 数据库异常透传（由调用方兜底）。
 */
async function removeSessionsBySkillId (
  sessionsDbPath: string,
  skillId: string,
): Promise<string[]> {
  if (!existsSync(sessionsDbPath)) return []
  const store = createSqliteSessionStore({ dbPath: sessionsDbPath })
  try {
    return await store.removeBySkillId(skillId)
  } finally {
    store.close()
  }
}

/**
 * 删除工作块库中属于指定会话的全部数据。
 *
 * @param workBlocksDbPath - 工作块数据库路径。
 * @param sessionIds - 会话 ID 列表。
 * @returns 无返回值；库不存在或列表为空时不做任何事。
 * @throws 数据库异常透传（由调用方兜底）。
 */
function removeWorkBlocksBySessionIds (
  workBlocksDbPath: string,
  sessionIds: string[],
): void {
  if (sessionIds.length === 0 || !existsSync(workBlocksDbPath)) return
  const store = createWorkBlockStore({ dbPath: workBlocksDbPath })
  try {
    store.removeSessions(sessionIds)
  } finally {
    store.close()
  }
}

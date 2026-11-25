/**
 * userWorkSpace 目录的存在性保障（v14，PRD 4.2/W8-W11，技术方案 §4.3）。
 *
 * 单一职责：确保 Skill 存在可用的 `userWorkSpace` 目录，并对失败给出
 * 可区分的错误语义（被同名文件占用 / 创建失败 / 不可用）。
 *
 * 与 env-file 的「打开页面级补建」模式对齐，但失败语义不同：
 *   - env.json 是静默降级（补建失败只影响文件树少一个文件）；
 *   - userWorkSpace 是测试产物的统一根，浏览入口（详情/文件树）仍静默降级
 *     为状态返回（W11：打开和浏览可以继续），生成/执行入口则以 strict 模式
 *     抛出明确错误（W11：依赖 userWorkSpace 的能力必须明确失败提示）。
 *
 * 挂载点：详情（detail.ts）/ 文件树（file-tree.ts）为 silent；
 * 生成链路与执行链路（CLI 应用层）为 strict。
 */

import { constants as fsConstants } from 'node:fs'
import { access, lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { normalizeUserWorkspaceRelativePath } from '@fynn90-e2e_assistant/types'
import { USER_WORKSPACE_DIRECTORY_NAME } from './constants'
import type { ISkillStorageOptions } from './storage'
import { resolveSkill } from './detail'
import {
  getFileSystemErrorCode,
  isFileSystemMissingError,
  isFileSystemPermissionError,
  SkillManagerError,
} from './errors'
import { resolveSafeSkillEntryPath } from './path-guard'

/** userWorkSpace 不可用或降级的原因（与场景 14 的三分错误语义一一对应）。 */
export interface TUserWorkspaceIssue {
  /**
   * 错误码：
   * - USER_WORKSPACE_OCCUPIED：路径被同名普通文件（或符号链接等非目录项）占用；
   * - USER_WORKSPACE_CREATE_FAILED：目录创建失败（非权限类 IO 错误）；
   * - USER_WORKSPACE_NOT_WRITABLE：权限不足（创建被拒或目录不可写）。
   */
  code:
  | 'USER_WORKSPACE_OCCUPIED'
  | 'USER_WORKSPACE_CREATE_FAILED'
  | 'USER_WORKSPACE_NOT_WRITABLE'
  /** 面向用户的中文说明（含处理建议）。 */
  message: string
}

/**
 * userWorkSpace 的可用状态。
 * - ready：已存在或本次补建成功；
 * - ready-degraded：目录可用但补建/可写性有告警（如只读文件系统上的既有目录）；
 * - unavailable：不可用（被占用 / 创建失败 / 权限不足）。
 */
export type TUserWorkspaceStatus =
  | { state: 'ready' }
  | { state: 'ready-degraded'; issue: TUserWorkspaceIssue }
  | { state: 'unavailable'; issue: TUserWorkspaceIssue }

/**
 * 可用性检查模式，决定「哪种状态算致命」：
 * - `silent`：详情 / 文件树入口，永不抛出；
 * - `generation`：生成 Playwright 脚本，仅 `unavailable` 抛出；
 * - `strict`：执行测试，`unavailable` 与 `ready-degraded` 都抛出。
 */
export type TUserWorkspaceCheckMode = 'silent' | 'generation' | 'strict'

/**
 * 确保 Skill 存在可用的 userWorkSpace 目录（幂等，W8/W9：不删除、不移动、不覆盖已有文件）。
 *
 * 判定流程（与场景 13/14 对应）：
 *   1. lstat(userWorkSpace)：
 *      - 是目录 → 探测 W_OK：可写 → ready；不可写 → ready-degraded（目录不可写）；
 *      - 是普通文件或其他类型（符号链接）→ 不覆盖不删除（W10）→ unavailable（占用）；
 *   2. 不存在 → mkdir：权限类失败 → 不可写；其他 IO 失败 → 创建失败；成功 → ready；
 *   3. 三种模式对「不可用」与「降级」的处理不同：
 *      - `silent`（详情 / 文件树）：永不抛出，失败降级为状态，浏览可继续（W11）；
 *      - `generation`（生成脚本）：仅 `unavailable` 抛出——详见下方说明；
 *      - `strict`（执行测试）：`unavailable` 与 `ready-degraded` 都抛出。
 *
 * @param options - Skill 存储根目录配置。
 * @param skillId - 九位 Skill ID。
 * @param mode - 见上；决定「哪种状态算致命」。
 * @returns userWorkSpace 的可用状态。
 * @throws SkillManagerError 当状态对本模式致命时抛出（code 取 issue.code）。
 */
export async function ensureUserWorkSpace (
  options: ISkillStorageOptions,
  skillId: string,
  mode: TUserWorkspaceCheckMode,
): Promise<TUserWorkspaceStatus> {
  const resolvedSkill = await resolveSkill(options, skillId)
  const workspacePath = path.join(
    resolvedSkill.skillRoot,
    USER_WORKSPACE_DIRECTORY_NAME,
  )

  let status: TUserWorkspaceStatus
  try {
    status = await probeOrCreate(workspacePath)
  } catch {
    // silent 模式永不抛出（W11：浏览可继续）；探测中的意外 IO 错误按创建失败降级。
    status = {
      state: 'unavailable',
      issue: {
        code: 'USER_WORKSPACE_CREATE_FAILED',
        message: 'userWorkSpace 目录状态检查失败，请检查磁盘状态后重试。',
      },
    }
  }

  const fatalIssue = fatalIssueFor(mode, status)

  if (fatalIssue) {
    throw new SkillManagerError(fatalIssue.code, fatalIssue.message)
  }

  return status
}

/**
 * 判定某个探测结果对指定模式是否致命，致命时返回应上报的问题。
 *
 * 纯函数，与文件系统无关，因此可用四态 × 三模式的矩阵直接测（见 user-workspace.test.ts）。
 *
 * `generation` 只把 `unavailable` 视为致命：生成脚本本身**不写** userWorkSpace，
 * 它只是把 `SKILL_USER_WORKSPACE` 注入脚本、由脚本在执行期使用。因此「目录存在
 * 但不可写」（`ready-degraded`）不该拦下生成——那会让用户在生成阶段就撞上一个
 * 到执行时才成为问题、且与自己当前操作无关的错误。
 *
 * `strict`（执行测试）保持原语义：执行会真实写入 userWorkSpace，不可写必须提前拦下，
 * 否则会以脚本运行错误的形式在测试中途爆出来，比提前失败更难定位。
 *
 * @param mode - 检查模式。
 * @param status - 探测结果。
 * @returns 致命时返回应抛出的问题；不致命时返回 null。
 * @throws 不抛出异常。
 */
export function fatalIssueFor (
  mode: TUserWorkspaceCheckMode,
  status: TUserWorkspaceStatus,
): TUserWorkspaceIssue | null {
  if (status.state === 'ready' || mode === 'silent') return null
  if (mode === 'generation') {
    return status.state === 'unavailable' ? status.issue : null
  }
  return status.issue
}

/**
 * 探测（或创建）指定路径上的 userWorkSpace 目录。
 *
 * @param workspacePath - userWorkSpace 绝对路径。
 * @returns 探测/创建后的状态。
 * @throws 不抛出异常——所有失败都转换为 unavailable/ready-degraded 状态。
 */
async function probeOrCreate (
  workspacePath: string,
): Promise<TUserWorkspaceStatus> {
  try {
    const stat = await lstat(workspacePath)

    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // 已是目录：探测可写性，决定 ready 或 ready-degraded。
      try {
        await access(workspacePath, fsConstants.W_OK)
        return { state: 'ready' }
      } catch {
        return {
          state: 'ready-degraded',
          issue: {
            code: 'USER_WORKSPACE_NOT_WRITABLE',
            message: 'userWorkSpace 目录不可写，请检查 Skill 目录权限。',
          },
        }
      }
    }

    // 普通文件或符号链接占用：不覆盖、不删除（W10），交由用户处理。
    return {
      state: 'unavailable',
      issue: {
        code: 'USER_WORKSPACE_OCCUPIED',
        message:
          'userWorkSpace 已被同名文件占用，请手动备份并删除或改名该文件后重试。',
      },
    }
  } catch (error) {
    if (!isFileSystemMissingError(error)) {
      // lstat 自身的权限类失败：按不可写处理（无法确认状态即不可依赖）。
      if (isFileSystemPermissionError(error)) {
        return {
          state: 'unavailable',
          issue: {
            code: 'USER_WORKSPACE_NOT_WRITABLE',
            message: '无法访问 userWorkSpace 路径，请检查 Skill 目录权限。',
          },
        }
      }
      throw error
    }
  }

  // 不存在：补建（幂等——并发窗口内被他人创建时 EEXIST 视为成功）。
  try {
    await mkdir(workspacePath, { recursive: false })
    return { state: 'ready' }
  } catch (error) {
    if (getFileSystemErrorCode(error) === 'EEXIST') {
      // 并发补建：目录刚被另一入口创建，重新探测确认。
      return probeExistingDirectory(workspacePath)
    }

    if (isFileSystemPermissionError(error)) {
      return {
        state: 'unavailable',
        issue: {
          code: 'USER_WORKSPACE_NOT_WRITABLE',
          message: '没有权限创建 userWorkSpace 目录，请检查 Skill 目录权限。',
        },
      }
    }

    return {
      state: 'unavailable',
      issue: {
        code: 'USER_WORKSPACE_CREATE_FAILED',
        message: 'userWorkSpace 目录创建失败，请检查磁盘状态后重试。',
      },
    }
  }
}

/**
 * 并发补建后的再探测：确认占位者确为目录。
 *
 * @param workspacePath - userWorkSpace 绝对路径。
 * @returns 探测结果；再探测失败时按占用处理（保守拒绝）。
 * @throws 不抛出异常。
 */
async function probeExistingDirectory (
  workspacePath: string,
): Promise<TUserWorkspaceStatus> {
  try {
    const stat = await lstat(workspacePath)
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return { state: 'ready' }
    }
    return {
      state: 'unavailable',
      issue: {
        code: 'USER_WORKSPACE_OCCUPIED',
        message:
          'userWorkSpace 已被同名文件占用，请手动备份并删除或改名该文件后重试。',
      },
    }
  } catch {
    return {
      state: 'unavailable',
      issue: {
        code: 'USER_WORKSPACE_CREATE_FAILED',
        message: 'userWorkSpace 目录创建失败，请检查磁盘状态后重试。',
      },
    }
  }
}

/**
 * 安全检查 userWorkSpace 内相对路径的存在性（供 ask host 的 use-existing/capture 判定，D7）。
 *
 * 路径经 types 共享的 D2 归一化后，再走 `resolveSafeSkillEntryPath` 家族
 * （逐段符号链接检测 + realpath 二次校验），确保判定对象始终位于当前
 * Skill 的 userWorkSpace 之内。
 *
 * @param options - Skill 存储根目录配置。
 * @param skillId - 九位 Skill ID。
 * @param relativePath - userWorkSpace 内相对路径（允许带一次前导 userWorkSpace 段）。
 * @returns 目标存在（文件或目录）时返回 true；不存在或路径非法时返回 false。
 * @throws SkillManagerError 当 Skill 本身无法解析时抛出（调用方应视为能力失败）。
 */
export async function userWorkspacePathExists (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
): Promise<boolean> {
  const normalized = normalizeUserWorkspaceRelativePath(relativePath)
  if (normalized === undefined) return false

  const resolvedSkill = await resolveSkill(options, skillId)

  try {
    await resolveSafeSkillEntryPath(
      resolvedSkill.skillRoot,
      `${USER_WORKSPACE_DIRECTORY_NAME}/${normalized}`,
    )
    return true
  } catch {
    // 不存在、越界或符号链接：一律按「不存在」处理——捕获与新建是安全默认。
    return false
  }
}

/**
 * Skill 内文件与目录的删除（v13，v14 扩展保护面）：供文件树的删除入口使用。
 *
 * **保护边界（用户明确要求）**：Skill 创建时生成的文件与受保护根目录不可删除——
 * `manifest.json`、`e2e_schema.json`、`env.json`（创建期文件）以及 `userWorkSpace`
 * 根目录（v14 W12）。清单与判定在 types 包，与前端共用同一份
 * （见 `isProtectedSkillRootEntry`）。其余内容（基线、报告、脚本、文档、
 * userWorkSpace 子内容、用户自建目录）一律可删。
 *
 * 与既有删除入口的分工：
 *   - `deleteTestReportRun` 只删 `test_report/<runId>` 时间戳子目录；
 *   - 本模块提供**通用**的相对路径删除，安全边界依赖
 *     `resolveSafeSkillEntryPath`（逐段符号链接检测 + 归一化前缀校验，
 *     允许目标是目录）叠加上述受保护清单。
 *
 * **根目录保护**：`normalizeRelativePath` 拒绝空路径，因此「删除 Skill 根目录」
 * 天然被挡下（根目录即相对路径为空）。删除整个 Skill 属于 `deleteSkill` 的职责
 * （W17：userWorkSpace 随 Skill 一并删除，不受 W12 约束）。
 *
 * **立约（W13，v14）**：平台没有重命名/移动 API，userWorkSpace 根目录
 * 「不可重命名」结构性满足；今后新增任何重命名/移动 API 时，必须把
 * userWorkSpace 根目录列入禁改清单。
 */

import { rm } from 'node:fs/promises'
import { isProtectedSkillRootEntry } from '@charlie_deng/e2e-assistant-types'
import { USER_WORKSPACE_DIRECTORY_NAME } from './constants'
import { resolveSkill } from './detail'
import {
  isFileSystemMissingError,
  isFileSystemPermissionError,
  SkillManagerError,
} from './errors'
import { normalizeRelativePath, resolveSafeSkillEntryPath } from './path-guard'
import type { ISkillStorageOptions } from './storage'

/**
 * 删除 Skill 内的一个文件或目录（递归）。
 *
 * @param options - Skill 存储根目录（`rootDir`）。
 * @param skillId - 九位 Skill ID。
 * @param relativePath - 待删除内容在 Skill 内的相对路径；目录会被递归删除。
 * @returns 删除完成；返回被删除内容的类型，供调用方组织提示文案。
 * @throws {SkillManagerError} 路径非法或指向根目录（INVALID_FILE_PATH）、
 *   命中创建期文件或 userWorkSpace 根目录保护（FILE_READ_ONLY）、目标不存在
 *   （FILE_NOT_FOUND）、无权限（FILE_PERMISSION_DENIED）或删除失败
 *   （SKILL_CORRUPTED）时抛出。
 */
export async function deleteSkillEntry (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
): Promise<{ relativePath: string; kind: 'file' | 'directory' }> {
  const resolvedSkill = await resolveSkill(options, skillId)

  // 归一化校验独立做一次：需要它的分段结果做「根目录/保护清单」判定，
  // 且要在触盘之前就拒绝非法路径。
  // normalizeRelativePath 会拒绝空路径，因此「删除 Skill 根目录」在此已被挡下
  // （根目录即 relativePath 为空），无需额外判定——那是 deleteSkill 的职责。
  const normalizedRelativePath = normalizeRelativePath(relativePath)

  // userWorkSpace 根目录给出专门文案（W12/场景 7）：它是脚本、Agent 与平台
  // 之间的稳定契约，Skill 存续期间不可删除；其子内容不受此限制。
  if (
    normalizedRelativePath.toLowerCase() ===
    USER_WORKSPACE_DIRECTORY_NAME.toLowerCase()
  ) {
    throw new SkillManagerError(
      'FILE_READ_ONLY',
      'userWorkSpace 是受保护目录，不允许删除；可以删除其中的子目录或文件。删除整个 Skill 时它会随 Skill 一并删除。',
    )
  }

  if (isProtectedSkillRootEntry(normalizedRelativePath)) {
    throw new SkillManagerError(
      'FILE_READ_ONLY',
      '该文件是创建 Skill 时生成的，不允许删除。',
    )
  }

  // 路径安全统一由 path-guard 把关：逐段符号链接检测 + 归一化前缀校验，
  // 且拒绝目标自身为符号链接（删除链接会作用到其指向的真实目标）。
  // 与本模块的差异：此处允许目标是目录（删除目录是本次需求）。
  const resolvedPath = await resolveSafeSkillEntryPath(
    resolvedSkill.skillRoot,
    relativePath,
  )
  const kind = resolvedPath.stat.isDirectory() ? 'directory' : 'file'

  try {
    // 目录递归删除；文件同样用 rm 处理（recursive 对普通文件是空操作）。
    await rm(resolvedPath.absolutePath, { recursive: true, force: false })
  } catch (error) {
    if (isFileSystemMissingError(error)) {
      throw new SkillManagerError(
        'FILE_NOT_FOUND',
        '目标不存在，可能已被删除。',
      )
    }
    throw new SkillManagerError(
      isFileSystemPermissionError(error)
        ? 'FILE_PERMISSION_DENIED'
        : 'SKILL_CORRUPTED',
      kind === 'directory' ? '删除目录失败。' : '删除文件失败。',
      error,
    )
  }

  return { relativePath: normalizedRelativePath, kind }
}

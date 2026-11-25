/**
 * 页面探查产物（v12-pre）：Agent 在生成阶段截取的页面截图。
 *
 * 为什么需要它：引擎契约明确「截图不落盘」，截图只作为 base64 在内存中流转，
 * 模型能通过 vision 通道看到，但**用户看不到**——而「Agent 到底看到了什么页面」
 * 恰恰是判断其核对结论是否可信的关键信息。
 *
 * **落盘位置**：`<skillRoot>/temp/exploration/<sessionId>/`，即 Agent 临时工作区
 * （temp-workspace.ts）之下的子目录。归属于 temp/ 意味着两件事：
 *   - 用户侧**不需要**看到它——它的价值在生成过程中（判断 Agent 核对质量），
 *     而不是生成之后；用户真正要长期维护的是 baselines/ 下的视觉基线；
 *   - 生命周期**随 temp/ 走**——任务终态整体删除，异常遗留由下次任务启动前清理。
 *
 * 因此本模块**没有**保留数量上限与淘汰逻辑：整棵 temp/ 树在任务结束即消失，
 * 不存在「长期使用后累积」的问题（该结论替代了先前的 20 会话淘汰机制）。
 *
 * 与 baselines/、test_report/ 共用的安全约定：目录名与文件名都走白名单正则，
 * 再做归一化后的前缀校验，确保路径始终落在预期目录内，杜绝目录穿越。
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SkillManagerError } from './errors'
import {
  EXPLORATION_DIRECTORY_NAME,
  MAX_EXPLORATION_SCREENSHOT_BYTES,
  TEMP_DIRECTORY_NAME,
} from './constants'

/**
 * 探查产物的会话目录名规则。
 *
 * 会话 ID 由 CLI 生成（生成任务是 `randomUUID()` 的 uuid），只要求安全字符集，
 * 杜绝目录穿越（与 runId 白名单同构的第一道防线）。
 *
 * 注意：会话目录名**不含时间序**，因此不可按字典序推断先后。
 * 本模块不做任何按顺序的清理，故这一点不影响正确性。
 */
const EXPLORATION_SESSION_DIR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** 截图文件名规则：时间戳 + 可选序号，只允许数字与连字符。 */
const SCREENSHOT_FILE_PATTERN = /^[0-9]{13}-[0-9]{2}\.png$/

/**
 * 校验并归一化会话目录名。
 *
 * @param sessionId - 生成会话 ID。
 * @returns 校验通过的会话目录名。
 * @throws {SkillManagerError} 格式非法时抛出 INVALID_FILE_PATH。
 */
function assertSafeSessionId(sessionId: string): string {
  if (!EXPLORATION_SESSION_DIR_PATTERN.test(sessionId)) {
    throw new SkillManagerError('INVALID_FILE_PATH', '探查会话 ID 不合法。')
  }
  return sessionId
}

/**
 * 校验截图文件名。
 *
 * @param fileName - 待校验的文件名。
 * @returns 校验通过的文件名。
 * @throws {SkillManagerError} 格式非法时抛出 INVALID_FILE_PATH。
 */
export function assertSafeScreenshotFileName(fileName: string): string {
  if (!SCREENSHOT_FILE_PATTERN.test(fileName)) {
    throw new SkillManagerError('INVALID_FILE_PATH', '截图文件名不合法。')
  }
  return fileName
}

/**
 * 解析探查产物的根目录绝对路径。
 *
 * 探查产物是 temp/ 的子目录，因此根目录为 `<skillRoot>/temp/exploration`。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 探查产物根目录的绝对路径。
 * @throws 不抛出异常。
 */
function resolveExplorationBaseDirectory(skillRoot: string): string {
  return path.join(skillRoot, TEMP_DIRECTORY_NAME, EXPLORATION_DIRECTORY_NAME)
}

/**
 * 解析某个会话的探查产物目录，必要时创建。
 *
 * 与 `resolveRunDirectory`（test_report）同构：先做名字白名单，
 * 再做归一化后的前缀校验，确保目录始终落在 `<skillRoot>/temp/exploration/` 内。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param sessionId - 生成会话 ID。
 * @returns 会话产物目录的绝对路径。
 * @throws {SkillManagerError} 会话 ID 非法或目录创建失败时抛出。
 */
export async function resolveExplorationSessionDirectory(
  skillRoot: string,
  sessionId: string,
): Promise<string> {
  const safeSessionId = assertSafeSessionId(sessionId)
  const baseDirectory = resolveExplorationBaseDirectory(skillRoot)
  const sessionDirectory = path.join(baseDirectory, safeSessionId)

  // 双保险：归一后必须仍位于探查根目录内（相对前缀校验）。
  const relative = path.relative(baseDirectory, sessionDirectory)
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.length === 0
  ) {
    throw new SkillManagerError('INVALID_FILE_PATH', '探查产物路径不合法。')
  }

  try {
    await mkdir(sessionDirectory, { recursive: true })
  } catch (error) {
    throw new SkillManagerError(
      'SKILL_CORRUPTED',
      '创建探查产物目录失败。',
      error,
    )
  }

  return sessionDirectory
}

/**
 * 保存一张页面探查截图。
 *
 * @param options - Skill 根目录、会话 ID、截图文件名与 PNG 字节。
 * @returns 截图相对 `temp/` 的路径（POSIX 分隔符），形如
 *   `exploration/<sessionId>/<时间戳>-<序号>.png`。
 * @throws {SkillManagerError} 文件名非法、超出体积上限或写入失败时抛出。
 */
export async function writeExplorationScreenshot(options: {
  skillRoot: string
  sessionId: string
  fileName: string
  content: Uint8Array
}): Promise<string> {
  const fileName = assertSafeScreenshotFileName(options.fileName)

  if (options.content.byteLength > MAX_EXPLORATION_SCREENSHOT_BYTES) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      '截图超出单张体积上限，未保存。',
    )
  }

  const sessionDirectory = await resolveExplorationSessionDirectory(
    options.skillRoot,
    options.sessionId,
  )
  const absolutePath = path.join(sessionDirectory, fileName)

  try {
    await writeFile(absolutePath, options.content)
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '写入探查截图失败。', error)
  }

  // 返回值以 temp/ 为基准：与 temp-workspace 的「相对 temp/ 定位内容」口径一致，
  // 便于调用方在同一个临时工作区语义下理解路径。
  return path
    .join(EXPLORATION_DIRECTORY_NAME, options.sessionId, fileName)
    .split('\\')
    .join('/')
}

/**
 * 读取一张探查截图的字节内容（供文件服务路由使用）。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param sessionId - 生成会话 ID。
 * @param fileName - 截图文件名。
 * @returns 截图字节内容。
 * @throws {SkillManagerError} 路径非法或文件不存在时抛出。
 */
export async function readExplorationScreenshot(options: {
  skillRoot: string
  sessionId: string
  fileName: string
}): Promise<Uint8Array> {
  const safeSessionId = assertSafeSessionId(options.sessionId)
  const fileName = assertSafeScreenshotFileName(options.fileName)
  const baseDirectory = resolveExplorationBaseDirectory(options.skillRoot)
  const absolutePath = path.join(baseDirectory, safeSessionId, fileName)

  const relative = path.relative(baseDirectory, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillManagerError('INVALID_FILE_PATH', '探查产物路径不合法。')
  }

  try {
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) {
      throw new SkillManagerError('FILE_NOT_FOUND', '探查截图不存在。')
    }
  } catch (error) {
    if (error instanceof SkillManagerError) throw error
    throw new SkillManagerError('FILE_NOT_FOUND', '探查截图不存在。', error)
  }

  try {
    return await readFile(absolutePath)
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '读取探查截图失败。', error)
  }
}

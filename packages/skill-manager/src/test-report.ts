/**
 * 测试报告目录的写入与保障（v11，技术方案 §4 / PRD 第 7 章）。
 *
 * 单一职责：把「执行产物落盘到 Skill 目录」收敛在唯一的模块里——
 *   - `ensureTestReportDirectory`：J8 就绪校验（目录被同名文件占用 / 不可写时阻断）；
 *   - `writeTestReport`：报告 HTML 的原子落盘；
 *   - `writeTestReportSummary`：机器可读摘要的落盘（v17，历史与对比的数据基础）；
 *   - `writeTestReportAttachment`：失败截图等附件的落盘；
 *   - `listTestReportRuns`：历史报告运行目录枚举（V6 备用，v17 执行历史的主入口）；
 *   - `deleteTestReportRun`：单次报告目录的整目录删除（v17 清理提案的落点）。
 *
 * 写入边界（PRD P10）：本模块只允许写 `test_report/<runId>/` 下的内容，
 * 不触碰 Skill 目录内的任何其他文件。
 *
 * 摘要与报告**同生共死**（v17 R1）：同目录、同删除路径——`deleteTestReportRun`
 * 整目录删掉即一并清理，不需要额外的清理逻辑，也不会出现「报告已删、历史还在」
 * 的假数据。
 */

import {
  access,
  constants as fsConstants,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { IExecutionRunSummary } from '@charlie_deng/e2e-assistant-types'
import {
  TEST_REPORT_DIRECTORY_NAME,
  TEST_REPORT_REPORT_FILE_NAME,
  TEST_REPORT_RUN_DIR_PATTERN,
  TEST_REPORT_SUMMARY_FILE_NAME,
} from './constants'
import { isFileSystemPermissionError, SkillManagerError } from './errors'

/**
 * 确保 Skill 目录下存在可写的 `test_report` 目录（J8）。
 *
 * 目录不存在时创建；已存在且为目录时校验可写；
 * 被**同名文件**占用或目录不可写时抛出阻断错误。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 就绪的 `test_report` 目录绝对路径。
 * @throws SkillManagerError（FILE_PERMISSION_DENIED）当目录被同名文件占用、
 *         创建失败或目录不可写时抛出。
 */
export async function ensureTestReportDirectory (
  skillRoot: string,
): Promise<string> {
  const directory = path.join(skillRoot, TEST_REPORT_DIRECTORY_NAME)

  let statResult
  try {
    statResult = await lstat(directory)
  } catch (error) {
    if (isFileSystemMissingError(error)) {
      try {
        await mkdir(directory, { recursive: true })
        return directory
      } catch (mkdirError) {
        throw new SkillManagerError(
          'FILE_PERMISSION_DENIED',
          isFileSystemPermissionError(mkdirError)
            ? '没有写入权限，无法保存测试报告，请检查 Skill 目录权限。'
            : '创建测试报告目录失败。',
          mkdirError,
        )
      }
    }

    throw new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      'test_report 目录状态无法确认，无法保存测试报告。',
      error,
    )
  }

  // J8：test_report 已被同名文件（非目录）占用。
  if (!statResult.isDirectory()) {
    throw new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      'test_report 已被同名文件占用，无法保存测试报告，请删除或重命名该文件后重试。',
    )
  }

  try {
    await access(directory, fsConstants.W_OK)
  } catch (error) {
    throw new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      'test_report 目录没有写入权限，无法保存测试报告。',
      error,
    )
  }

  return directory
}

/**
 * 写入一次执行的测试报告 HTML（原子写：先落临时文件再重命名）。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳（yyyyMMdd-HHmmss）。
 * @param html - 报告 HTML 全文。
 * @returns 报告文件在 Skill 内的相对路径（`test_report/<runId>/report.html`）。
 * @throws SkillManagerError 当 runId 非法或写入失败时抛出。
 */
export async function writeTestReport (
  skillRoot: string,
  runId: string,
  html: string,
): Promise<string> {
  const runDirectory = await resolveRunDirectory(skillRoot, runId)
  const targetPath = path.join(runDirectory, TEST_REPORT_REPORT_FILE_NAME)

  try {
    // 原子写：同目录临时文件 + 重命名，避免读侧拿到半份 HTML。
    const tempPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    await writeFile(tempPath, html, 'utf8')
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SkillManagerError(
      isFileSystemPermissionError(error)
        ? 'FILE_PERMISSION_DENIED'
        : 'SKILL_CORRUPTED',
      '写入测试报告失败。',
      error,
    )
  }

  return path
    .join(TEST_REPORT_DIRECTORY_NAME, runId, TEST_REPORT_REPORT_FILE_NAME)
    .split('\\')
    .join('/')
}

/**
 * 写入一次执行的持久化摘要（v17，技术方案 §4.4）。
 *
 * 与报告 HTML 并列放在 `test_report/<runId>/summary.json`，供执行历史卡（Q7）、
 * 失败修复（G2a）与两次对比（Q9）取数。写入时机是**报告 HTML 写入成功之后**——
 * 摘要描述的是「这次执行产出了什么」，报告没写成功时没有可描述的对象。
 *
 * 复用同一套 runId 校验与原子写（临时文件 + 重命名），避免读侧拿到半份 JSON。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳（yyyyMMdd-HHmmss）。
 * @param summary - 摘要内容（调用方负责脱敏 `failures[].errorMessage`，§8）。
 * @returns 摘要文件在 Skill 内的相对路径（`test_report/<runId>/summary.json`）。
 * @throws SkillManagerError 当 runId 非法或写入失败时抛出。
 */
export async function writeTestReportSummary (
  skillRoot: string,
  runId: string,
  summary: IExecutionRunSummary,
): Promise<string> {
  const runDirectory = await resolveRunDirectory(skillRoot, runId)
  const targetPath = path.join(runDirectory, TEST_REPORT_SUMMARY_FILE_NAME)

  try {
    const tempPath = `${targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
    await writeFile(tempPath, JSON.stringify(summary, null, 2), 'utf8')
    await rename(tempPath, targetPath)
  } catch (error) {
    throw new SkillManagerError(
      isFileSystemPermissionError(error)
        ? 'FILE_PERMISSION_DENIED'
        : 'SKILL_CORRUPTED',
      '写入测试报告摘要失败。',
      error,
    )
  }

  return path
    .join(TEST_REPORT_DIRECTORY_NAME, runId, TEST_REPORT_SUMMARY_FILE_NAME)
    .split('\\')
    .join('/')
}

/**
 * 读取一次执行的持久化摘要（v17，技术方案 §4.4）。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳（yyyyMMdd-HHmmss）。
 * @returns 摘要；文件缺失、JSON 非法、schemaVersion 不符或结构不完整时返回
 *          undefined（调用方按「该次无摘要」处理，不解析 HTML 兜底）。
 * @throws 不抛出异常——历史卡的渲染不应被单份坏摘要打断。
 */
export async function readTestReportSummary (
  skillRoot: string,
  runId: string,
): Promise<IExecutionRunSummary | undefined> {
  // 先校验 runId 形态再拼路径：与写入侧同一道闸，避免读取越出报告目录。
  if (!TEST_REPORT_RUN_DIR_PATTERN.test(runId)) {
    return undefined
  }

  try {
    const raw = await readFile(
      path.join(
        skillRoot,
        TEST_REPORT_DIRECTORY_NAME,
        runId,
        TEST_REPORT_SUMMARY_FILE_NAME,
      ),
      'utf8',
    )
    return parseRunSummary(raw)
  } catch {
    // 文件不存在 / 无权限 / JSON 非法：一律按「该次不可用」归一。
    return undefined
  }
}

/**
 * 校验并窄化一份摘要 JSON。
 *
 * 结构校验而不是强制断言：摘要是**落盘数据**，可能被用户手工编辑过，
 * 也可能来自摘要写入失败但报告写入成功的中间态。历史卡宁可少一行，
 * 也不能因为一份坏文件抛错中断整张卡片。
 *
 * @param raw - 文件原文。
 * @returns 结构合法的摘要；任一必需字段不符时返回 undefined。
 * @throws 不抛出异常（JSON 解析失败时返回 undefined）。
 */
function parseRunSummary (raw: string): IExecutionRunSummary | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1) return undefined
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) {
    return undefined
  }
  if (typeof candidate.startedAt !== 'string') return undefined

  const stats = candidate.stats as Record<string, unknown> | undefined
  if (!stats || typeof stats !== 'object') return undefined
  const numericKeys = [
    'total',
    'passed',
    'failed',
    'timedOut',
    'interrupted',
    'skipped',
    'durationMs',
  ] as const
  for (const key of numericKeys) {
    if (typeof stats[key] !== 'number') return undefined
  }

  const outcome = candidate.outcome
  if (
    outcome !== 'passed' &&
    outcome !== 'failed' &&
    outcome !== 'interrupted'
  ) {
    return undefined
  }

  // 可选字段按「有则用、无则缺省」处理，不做强制——新增字段不应让旧摘要失效。
  return {
    schemaVersion: 1,
    skillId: typeof candidate.skillId === 'string' ? candidate.skillId : '',
    skillTitle:
      typeof candidate.skillTitle === 'string' ? candidate.skillTitle : '',
    runId: candidate.runId,
    startedAt: candidate.startedAt,
    baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : '',
    stats: {
      total: stats.total as number,
      passed: stats.passed as number,
      failed: stats.failed as number,
      timedOut: stats.timedOut as number,
      interrupted: stats.interrupted as number,
      skipped: stats.skipped as number,
      durationMs: stats.durationMs as number,
    },
    outcome,
    ...(Array.isArray(candidate.failures)
      ? { failures: candidate.failures as IExecutionRunSummary['failures'] }
      : {}),
    reportFile: candidate.reportFile === true,
  }
}

/**
 * 写入一次执行的附件文件（失败截图等，PRD AC-11）。
 *
 * 文件名由调用方提供（相对 `test_report/<runId>/`），仅允许单层安全文件名。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳。
 * @param fileName - 附件文件名（不含路径分隔符）。
 * @param content - 附件二进制内容。
 * @returns 附件在 Skill 内的相对路径。
 * @throws SkillManagerError 当文件名非法或写入失败时抛出。
 */
export async function writeTestReportAttachment (
  skillRoot: string,
  runId: string,
  fileName: string,
  content: Uint8Array,
): Promise<string> {
  // 附件名必须是纯文件名：拒绝路径分隔符与父目录引用（P10 写入边界）。
  if (
    !fileName ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('..') ||
    fileName !== fileName.trim()
  ) {
    throw new SkillManagerError(
      'INVALID_FILE_PATH',
      '测试报告附件文件名不合法。',
    )
  }

  const runDirectory = await resolveRunDirectory(skillRoot, runId)

  try {
    await writeFile(path.join(runDirectory, fileName), content)
  } catch (error) {
    throw new SkillManagerError(
      isFileSystemPermissionError(error)
        ? 'FILE_PERMISSION_DENIED'
        : 'SKILL_CORRUPTED',
      '写入测试报告附件失败。',
      error,
    )
  }

  return path
    .join(TEST_REPORT_DIRECTORY_NAME, runId, fileName)
    .split('\\')
    .join('/')
}

/**
 * 枚举 Skill 的全部报告运行目录（V6 备用；本期 web 主要走文件树）。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 按名称升序的 runId 列表（即时间先后）。
 * @throws 不抛出异常；目录不存在或不可读时返回空数组。
 */
export async function listTestReportRuns (skillRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(
      path.join(skillRoot, TEST_REPORT_DIRECTORY_NAME),
    )
    return entries
      .filter((entry) => TEST_REPORT_RUN_DIR_PATTERN.test(entry))
      .sort()
  } catch {
    return []
  }
}

/**
 * 删除一次执行的报告目录（`test_report/<runId>/` 整目录）。
 *
 * 写入边界（P10 同源约束）：只允许删除时间戳子目录，
 * 顶层 `test_report` 目录与其他 Skill 文件不受影响。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳（yyyyMMdd-HHmmss）。
 * @returns 删除完成后兑现。
 * @throws SkillManagerError 当 runId 非法（INVALID_REQUEST）
 *         或报告目录不存在（FILE_NOT_FOUND）时抛出。
 */
export async function deleteTestReportRun (
  skillRoot: string,
  runId: string,
): Promise<void> {
  if (!TEST_REPORT_RUN_DIR_PATTERN.test(runId)) {
    throw new SkillManagerError('INVALID_REQUEST', '运行时间戳格式不正确。')
  }

  const runDirectory = path.join(skillRoot, TEST_REPORT_DIRECTORY_NAME, runId)

  let statResult
  try {
    statResult = await lstat(runDirectory)
  } catch (error) {
    if (isFileSystemMissingError(error)) {
      throw new SkillManagerError(
        'FILE_NOT_FOUND',
        '测试报告不存在，可能已被删除。',
      )
    }
    throw new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      '测试报告目录状态无法确认，无法删除。',
      error,
    )
  }

  if (!statResult.isDirectory()) {
    throw new SkillManagerError(
      'FILE_NOT_FOUND',
      '测试报告不存在，可能已被删除。',
    )
  }

  try {
    await rm(runDirectory, { recursive: true, force: true })
  } catch (error) {
    throw new SkillManagerError(
      isFileSystemPermissionError(error)
        ? 'FILE_PERMISSION_DENIED'
        : 'SKILL_CORRUPTED',
      '删除测试报告失败。',
      error,
    )
  }
}

/**
 * 校验 runId 并确保 `test_report/<runId>/` 目录存在。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param runId - 运行时间戳。
 * @returns 运行目录绝对路径。
 * @throws SkillManagerError 当 runId 非法或目录创建失败时抛出。
 */
async function resolveRunDirectory (
  skillRoot: string,
  runId: string,
): Promise<string> {
  if (!TEST_REPORT_RUN_DIR_PATTERN.test(runId)) {
    throw new SkillManagerError('INVALID_REQUEST', '运行时间戳格式不正确。')
  }

  const reportDirectory = await ensureTestReportDirectory(skillRoot)
  const runDirectory = path.join(reportDirectory, runId)

  try {
    await mkdir(runDirectory, { recursive: true })
  } catch (error) {
    throw new SkillManagerError(
      'FILE_PERMISSION_DENIED',
      '创建测试报告运行目录失败。',
      error,
    )
  }

  return runDirectory
}

/** 判断错误是否为「路径不存在」类。 */
function isFileSystemMissingError (error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT'
}

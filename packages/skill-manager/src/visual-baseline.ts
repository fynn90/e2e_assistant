/**
 * 视觉基线产物（v12 引入，v14 换根到 userWorkSpace，技术方案 §4.7）：
 * DOM 截图的「新旧对比」基线图片。
 *
 * 为什么需要它：PRD 要求「将 DOM 截图保存到指定目录」「与指定目录中的图片做对比」，
 * 基线必须是**落在 Skill 目录内、可被用户查看与管理**的正式产物。
 *
 * v14 起的落盘根：`<skillRoot>/userWorkSpace/<分组>/`（B1：默认分组 `baselines`，
 * 即 `<skillRoot>/userWorkSpace/baselines/`）。历史 Skill 根目录下的 `baselines/`
 * 不迁移、不兼容读取（D3：产品未上线、纯开发阶段，无历史包袱）。
 *
 * 与既有两个图片目录的分工（三者同构，共用同一套白名单 + 路径校验约定）：
 *   - `test_report/`——执行期产物，一次运行一个时间戳目录，用户可见但不进导出包；
 *   - `temp/exploration/`——生成期产物，按会话组织，**随 temp/ 在任务终态整体删除**，
 *     因此对用户不可见、也无需任何清理策略；
 *   - `userWorkSpace/<分组>/`——**跨会话长期保留**的比对基准，用户会主动维护
 *     （增删候选），因此**不做数量淘汰**，也不按时间戳组织。
 *
 * 目录由**写入动作隐式创建**（`mkdir recursive`，与 exploration-artifact 同法）——
 * 用户无需手工建目录；但 v14 约束基准目录的**创建时机**（B5/B8/B9）：用户明确
 * 确认保存或捕获基准图后才允许创建，由 AskUserQuestion 流程与提示词共同保证。
 *
 * 安全边界（三者共用）：目录名与文件名都走白名单正则，再做归一化后的前缀校验，
 * 确保路径始终落在当前 Skill 的 userWorkSpace 内，杜绝目录穿越。
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeUserWorkspaceRelativePath } from '@fynn90-e2e_assistant/types'
import {
  MAX_VISUAL_BASELINE_BYTES,
  USER_WORKSPACE_DIRECTORY_NAME,
  VISUAL_BASELINE_DIRECTORY_NAME,
} from './constants'
import { SkillManagerError } from './errors'

/**
 * 基线分组目录名规则。
 *
 * 分组由用户在用例中指明（如 `preview`、`login`），可多层（`login/success`），
 * 因此这里对**每一段**做白名单校验，而不是整体匹配。
 */
const BASELINE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 基线文件名规则：必须以 .png 结尾（Playwright 视觉断言只支持 png / webp，本平台限定 png）。 */
const BASELINE_FILE_PATTERN = /^[A-Za-z0-9_-]{1,64}\.png$/

/**
 * 校验并归一化基线分组目录分段。
 *
 * @param segments - 分组目录分段（如 `['preview']` 或 `['login', 'success']`）。
 * @returns 校验通过的分段数组（去除空白项）。
 * @throws {SkillManagerError} 任一分段非法时抛出 INVALID_FILE_PATH。
 */
export function assertSafeBaselineSegments (
  segments: readonly string[],
): string[] {
  const normalized = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  for (const segment of normalized) {
    if (!BASELINE_SEGMENT_PATTERN.test(segment)) {
      throw new SkillManagerError(
        'INVALID_FILE_PATH',
        `基线目录名不合法：${segment}。只允许字母、数字、下划线与中划线。`,
      )
    }
  }

  return normalized
}

/**
 * 校验基线文件名。
 *
 * @param fileName - 待校验的文件名。
 * @returns 校验通过的文件名。
 * @throws {SkillManagerError} 格式非法时抛出 INVALID_FILE_PATH。
 */
export function assertSafeBaselineFileName (fileName: string): string {
  if (!BASELINE_FILE_PATTERN.test(fileName)) {
    throw new SkillManagerError(
      'INVALID_FILE_PATH',
      '基线文件名不合法，只允许字母、数字、下划线、中划线，且必须以 .png 结尾。',
    )
  }
  return fileName
}

/**
 * 校验并归一化用户给出的基准相对路径（v14 D2，B3/A16）。
 *
 * 归一化规则与全平台一致：**相对 userWorkSpace 解析 + 剥离一次前导
 * `userWorkSpace` 段**（`baselines/preview` 不剥离前导 `baselines/`）。
 * 输入可以只是目录（返回空文件名），也可以是含 `.png` 文件名的完整路径。
 *
 * @param input - 用户输入的基准路径（如 `preview`、`baselines/preview`、`userWorkSpace/preview/x.png`）。
 * @returns 归一化结果：目录分段（空数组表示默认根）与可选文件名。
 * @throws {SkillManagerError} 路径非法（越界/绝对路径/`..`/重复 userWorkSpace 段）
 *   或分段/文件名不满足白名单时抛出 INVALID_FILE_PATH。
 */
export function normalizeBaselineUserPath (input: string): {
  segments: string[]
  fileName?: string
} {
  const normalized = normalizeUserWorkspaceRelativePath(input)

  if (normalized === undefined) {
    throw new SkillManagerError(
      'INVALID_FILE_PATH',
      '基准路径不合法：只能使用 userWorkSpace 内的相对路径。',
    )
  }

  const segments = normalized.split('/')
  let fileName: string | undefined

  // 末段是 .png 文件名时拆出，其余段按目录白名单校验。
  if (BASELINE_FILE_PATTERN.test(segments[segments.length - 1])) {
    fileName = segments.pop()
  }

  return {
    segments: assertSafeBaselineSegments(segments),
    ...(fileName ? { fileName } : {}),
  }
}

/**
 * 解析基线分组目录的绝对路径，必要时创建。
 *
 * v14 起 `segments` 语义为 **userWorkSpace 内相对分段**（D2）：
 * `['baselines']` 表示默认基准目录 `<skillRoot>/userWorkSpace/baselines/`。
 * 先做分段白名单，再做归一化后的前缀校验，确保目录始终落在 userWorkSpace 内。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param segments - userWorkSpace 内的分组目录分段；空数组表示 userWorkSpace 根。
 * @returns 分组目录的绝对路径。
 * @throws {SkillManagerError} 分段非法或目录创建失败时抛出。
 */
export async function resolveUserWorkspaceArtifactDirectory (
  skillRoot: string,
  segments: readonly string[],
): Promise<string> {
  const safeSegments = assertSafeBaselineSegments(segments)
  const baseDirectory = path.join(skillRoot, USER_WORKSPACE_DIRECTORY_NAME)
  const targetDirectory = path.join(baseDirectory, ...safeSegments)

  // 双保险：归一后必须仍位于 userWorkSpace 内（相对前缀校验）。
  const relative = path.relative(baseDirectory, targetDirectory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillManagerError('INVALID_FILE_PATH', '基线产物路径不合法。')
  }

  try {
    await mkdir(targetDirectory, { recursive: true })
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '创建基线目录失败。', error)
  }

  return targetDirectory
}

/**
 * 保存一张视觉基线截图。
 *
 * @param options - Skill 根目录、分组分段、文件名与 PNG 字节。
 * @returns 基线在 Skill 内的相对路径（POSIX 分隔符，userWorkSpace/<segments>/<fileName>）。
 * @throws {SkillManagerError} 名称非法、超出体积上限或写入失败时抛出。
 */
export async function writeVisualBaseline (options: {
  skillRoot: string
  segments: readonly string[]
  fileName: string
  content: Uint8Array
}): Promise<string> {
  const fileName = assertSafeBaselineFileName(options.fileName)
  const segments = assertSafeBaselineSegments(options.segments)

  if (options.content.byteLength > MAX_VISUAL_BASELINE_BYTES) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      '基线截图超出单张体积上限，未保存。',
    )
  }

  const directory = await resolveUserWorkspaceArtifactDirectory(
    options.skillRoot,
    segments,
  )
  const absolutePath = path.join(directory, fileName)

  try {
    await writeFile(absolutePath, options.content)
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '写入基线截图失败。', error)
  }

  return path
    .join(USER_WORKSPACE_DIRECTORY_NAME, ...segments, fileName)
    .split('\\')
    .join('/')
}

/**
 * 读取一张视觉基线截图的字节内容（供文件服务路由使用）。
 *
 * @param options - Skill 根目录、分组分段与文件名。
 * @returns 基线字节内容。
 * @throws {SkillManagerError} 路径非法或文件不存在时抛出。
 */
export async function readVisualBaseline (options: {
  skillRoot: string
  segments: readonly string[]
  fileName: string
}): Promise<Uint8Array> {
  const segments = assertSafeBaselineSegments(options.segments)
  const fileName = assertSafeBaselineFileName(options.fileName)
  const baseDirectory = path.join(
    options.skillRoot,
    USER_WORKSPACE_DIRECTORY_NAME,
  )
  const absolutePath = path.join(baseDirectory, ...segments, fileName)

  const relative = path.relative(baseDirectory, absolutePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SkillManagerError('INVALID_FILE_PATH', '基线产物路径不合法。')
  }

  try {
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile()) {
      throw new SkillManagerError('FILE_NOT_FOUND', '基线截图不存在。')
    }
  } catch (error) {
    if (error instanceof SkillManagerError) throw error
    throw new SkillManagerError('FILE_NOT_FOUND', '基线截图不存在。', error)
  }

  try {
    return await readFile(absolutePath)
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '读取基线截图失败。', error)
  }
}

/**
 * 列出某个分组下的全部基线文件名（供 UI 与管理入口使用）。
 *
 * 单层读取、不递归：分组本身可以多层（由调用方逐层传入），避免一次扫描过大目录。
 * v14 后选项来源改为 Agent 分析给出（D7），本函数保留给文件树等其他调用方。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @param segments - userWorkSpace 内的分组目录分段。
 * @returns 按名称升序的 .png 文件名；目录不存在时返回空数组。
 * @throws {SkillManagerError} 分段非法时抛出；目录不可读时返回空数组。
 */
export async function listVisualBaselines (
  skillRoot: string,
  segments: readonly string[] = [],
): Promise<string[]> {
  const safeSegments = assertSafeBaselineSegments(segments)
  const directory = path.join(
    skillRoot,
    USER_WORKSPACE_DIRECTORY_NAME,
    ...safeSegments,
  )

  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.isFile() && BASELINE_FILE_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    // 目录不存在（尚未捕获过基线）或不可读：这不是错误，调用方按「无候选」处理。
    return []
  }
}

/**
 * 默认基准目录的 userWorkSpace 内分段（B1）。
 *
 * 供 AskUserQuestion 的目录问题候选（「使用默认目录 userWorkSpace/baselines」）
 * 与捕获工具的示例文案取值，避免多处分头拼写而漂移。
 */
export const DEFAULT_BASELINE_SEGMENTS: readonly string[] = [
  VISUAL_BASELINE_DIRECTORY_NAME,
]

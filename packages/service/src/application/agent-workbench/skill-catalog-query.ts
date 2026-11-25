/**
 * 工作台检索的补充能力（v17）：磁盘查询的共用原子。
 *
 * 为什么从 `skill-catalog.ts` 拆出来：那个模块是「检索服务的门面」（对外暴露
 * `ISkillCatalog` 接口，回答 Agent 的定位问题）；本模块是**实现细节的集合**
 * （读用例数据、算 env key 差集、读报告摘要、按条件筛行）——它们同时被
 * 「清单卡 / 详情卡 / 历史卡」与「筛选后的工具文本」消费，抽出来才能保证
 * 两处判定同源（技术方案 §6.1 反复强调的「同源」）。
 *
 * 三条容易踩的线（技术方案 §6.1 的易错点）：
 *   1. **两套 env key 集合不可混用**：`collectEnvReferences` 提的是**用例声明的
 *      引用**，J4 的 `checkEnvReferencesForExecution` 提的是**脚本实际引用的 key**。
 *      详情卡展示的是用例，故用前者；两者通常相同但不保证相同（用户可能手改了脚本）。
 *   2. **不解析 HTML 兜底**：报告 HTML 无机器可读结构，靠中文标签正则取数会随
 *      视觉改版静默失真（F4）。缺 `summary.json` 就按「该次无摘要」处理。
 *   3. **latestRun 只对筛选后的结果取**：先按产物完备性 / 关键词筛，再补执行信息，
 *      避免对整库逐条读盘（成本控制）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileE2ETestCaseRepository,
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  listTestReportRuns,
  readTestReportSummary,
  resolveSkill,
} from '@authine-e2e-agent/skill-manager'
import type { ISkillStorageOptions } from '@authine-e2e-agent/skill-manager'
import {
  collectEnvReferences,
  findMissingEnvReferences,
} from '@authine-e2e-agent/types'
import type {
  IE2ETestCase,
  IRunHistoryViewPayload,
  ISkillDetailViewPayload,
  IWorkbenchSkillRow,
  TSkillListStatusFilterLike,
} from './skill-catalog-types'

/** 清单行的一次性读盘结果（尚未补 latestRun）。 */
export interface ISkillRowBase {
  skillId: string
  title: string
  description: string
  hasSkillDocument: boolean
  hasPlaywrightScript: boolean
  baseUrl?: string
  tags?: string[]
}

/**
 * 读取一个用例的清单行基础字段（不含执行信息）。
 *
 * **调用方须传入已解析的 skillRoot 与已读到的用例数据**（而不是让本函数
 * 再各读一遍）：调用方为了关键词筛选本来就要读一次用例，脚本存在性又要
 * 解析一次目录——重复的磁盘往返会让清单卡在大工作区里明显变慢。
 *
 * @param skillRoot - 已解析的用例目录绝对路径。
 * @param skillId - 用例 ID。
 * @param title - 索引中的标题。
 * @param description - 索引中的描述。
 * @param testCase - 调用方已读到的用例数据（不可读时传 undefined）。
 * @returns 基础行；用例数据不可读时 tags/baseUrl 缺省（不阻断整行）。
 * @throws 不抛出异常。
 */
export async function readSkillRowBase(
  skillRoot: string,
  skillId: string,
  title: string,
  description: string,
  testCase: IE2ETestCase | undefined,
): Promise<ISkillRowBase> {
  const scriptExists = await hasScriptFile(skillRoot)

  const base: ISkillRowBase = {
    skillId,
    title,
    description,
    // 文档存在性由调用方传入（它读文档仓库时已拿到状态）。
    hasSkillDocument: false,
    hasPlaywrightScript: scriptExists,
  }

  if (testCase) {
    if (testCase.baseUrl) base.baseUrl = testCase.baseUrl
    if (testCase.tags.length > 0) base.tags = [...testCase.tags]
  }

  return base
}

/**
 * 判断已解析的用例目录下是否有 test.spec.ts。
 *
 * 直接读固定文件名而非查 manifest 元数据：文件存在才是「可执行」的判据，
 * 元数据只说明「曾经由平台生成过」（用户可能已手删文件）。
 *
 * @param skillRoot - 已解析的用例目录绝对路径。
 * @returns 文件存在返回 true；读取失败返回 false。
 * @throws 不抛出异常。
 */
export async function hasScriptFile(skillRoot: string): Promise<boolean> {
  try {
    await readFile(join(skillRoot, PLAYWRIGHT_SCRIPT_FILE_NAME))
    return true
  } catch {
    return false
  }
}

/**
 * 读取一个用例的最近一次带报告的执行（v17 Q7 的清单行数据源）。
 *
 * 只取**最新一个** runId 的摘要：清单卡每行只要一个「最近执行」，读全部是浪费。
 *
 * @param skillRoot - 已解析的用例目录绝对路径。
 * @returns 最近执行的摘要信息；无报告或无摘要时返回 undefined。
 * @throws 不抛出异常。
 */
export async function readLatestRun(
  skillRoot: string,
): Promise<IWorkbenchSkillRow['latestRun']> {
  const runs = await listTestReportRuns(skillRoot)
  if (runs.length === 0) return undefined

  const latestRunId = runs[runs.length - 1]
  if (!latestRunId) return undefined

  const summary = await readTestReportSummary(skillRoot, latestRunId)
  if (!summary) return undefined

  return {
    runId: summary.runId,
    at: runIdToIsoTime(summary.runId) ?? summary.startedAt,
    passed: summary.stats.passed,
    failed: summary.stats.failed + summary.stats.timedOut,
    interrupted: summary.stats.interrupted,
    skipped: summary.stats.skipped,
    durationMs: summary.stats.durationMs,
  }
}

/**
 * 读取一个用例的执行历史（v17 Q7）。
 *
 * @param skillRoot - 已解析的用例目录绝对路径。
 * @param limit - 返回的最近次数上限。
 * @returns 历史载荷；无报告时 `neverExecuted` 为 true。
 * @throws 不抛出异常。
 */
export async function readRunHistoryPayload(
  skillRoot: string,
  skillId: string,
  skillTitle: string,
  limit: number,
): Promise<IRunHistoryViewPayload> {
  const allRunIds = await listTestReportRuns(skillRoot)
  if (allRunIds.length === 0) {
    return {
      skillId,
      skillTitle,
      runs: [],
      truncatedAt: 0,
      neverExecuted: true,
    }
  }

  // 取末 N 个（名字升序 = 时间升序），再反转成「最近在前」。
  const recent = allRunIds
    .slice(Math.max(0, allRunIds.length - limit))
    .reverse()

  const runs: IRunHistoryViewPayload['runs'] = []
  for (const runId of recent) {
    const summary = await readTestReportSummary(skillRoot, runId)
    // 缺摘要的历史遗留（v17 之前生成的报告）：如实跳过，不解析 HTML 兜底。
    if (!summary) continue

    runs.push({
      runId: summary.runId,
      startedAt: summary.startedAt || (runIdToIsoTime(runId) ?? ''),
      passed: summary.stats.passed,
      failed: summary.stats.failed + summary.stats.timedOut,
      interrupted: summary.stats.interrupted,
      skipped: summary.stats.skipped,
      total: summary.stats.total,
      durationMs: summary.stats.durationMs,
      ...(summary.baseUrl ? { baseUrl: summary.baseUrl } : {}),
    })
  }

  return {
    skillId,
    skillTitle,
    runs,
    // truncatedAt 是**报告总数**（Q7：更早的报告未在卡内列出，如实说明）。
    truncatedAt: allRunIds.length,
    neverExecuted: runs.length === 0 && allRunIds.length === 0,
  }
}

/**
 * 读取用例详情载荷（v17 Q4）。
 *
 * env key 与缺失 key **都用用例侧判定**（`collectEnvReferences` /
 * `findMissingEnvReferences`）——与体检卡的 J4 判定不同源且可能不一致，
 * 两者都如实呈现（技术方案 §6.1 第 2/3 点）。
 *
 * @param skillRoot - 已解析的用例目录绝对路径。
 * @param skillId - 用例 ID。
 * @param testCase - 已读取的结构化用例。
 * @param envKeys - env.json 的 key 集合（缺失判定的对照面）。
 * @param hasSkillDocument - 是否已有 SKILL.md。
 * @param hasPlaywrightScript - 是否已有脚本。
 * @param documentContent - SKILL.md 正文（缺省表示未生成）。
 * @returns 详情载荷。
 * @throws 不抛出异常。
 */
export function buildSkillDetailPayload(input: {
  skillId: string
  testCase: IE2ETestCase
  envKeys: ReadonlySet<string>
  hasSkillDocument: boolean
  hasPlaywrightScript: boolean
  documentContent?: string
}): ISkillDetailViewPayload {
  const referencedKeys = collectEnvReferences(input.testCase)
  const missing = findMissingEnvReferences(input.testCase, input.envKeys)

  return {
    skillId: input.skillId,
    title: input.testCase.title,
    description: input.testCase.description,
    ...(input.testCase.baseUrl ? { baseUrl: input.testCase.baseUrl } : {}),
    ...(input.testCase.tags.length > 0
      ? { tags: [...input.testCase.tags] }
      : {}),
    preconditions: input.testCase.preconditions.map((item) => ({
      id: item.id,
      description: item.description,
    })),
    steps: input.testCase.steps.map((step) => ({
      id: step.id,
      order: step.order,
      description: step.description,
      action: step.action,
      expectedResult: step.expectedResult,
      enabled: step.enabled,
    })),
    hasSkillDocument: input.hasSkillDocument,
    hasPlaywrightScript: input.hasPlaywrightScript,
    envKeys: referencedKeys,
    missingEnvKeys: [...new Set(missing.map((finding) => finding.key))].sort(),
    ...(input.documentContent !== undefined
      ? { documentContent: input.documentContent }
      : {}),
  }
}

/**
 * 判断一个清单行是否命中筛选条件（v17 Q3）。
 *
 * 关键词匹配标题 / 描述 / 启用步骤的文本——与 `collectEnvReferences` 的扫描
 * 范围同源（「步骤内容」也是用例内容的一部分，PRD Q3 明确要求）。
 *
 * @param row - 含用例原文的行（未命中筛选时返回 false）。
 * @param filter - 关键词 / 标签筛选（状态筛选由调用方另行判定）。
 * @param testCase - 用例原文（关键词匹配用；不可读时为 undefined）。
 * @returns 命中时返回 true。
 * @throws 不抛出异常。
 */
export function matchesContentFilter(
  row: ISkillRowBase,
  filter: { keyword?: string; tag?: string },
  testCase: IE2ETestCase | undefined,
): boolean {
  if (filter.tag) {
    if (!row.tags?.includes(filter.tag)) return false
  }

  if (filter.keyword) {
    const keyword = filter.keyword.toLowerCase()
    const haystack = [
      row.title,
      row.description,
      ...(row.tags ?? []),
      ...(testCase
        ? testCase.steps.flatMap((step) => [step.description, step.action])
        : []),
    ]
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(keyword)) return false
  }

  return true
}

/**
 * 判断一个清单行是否命中状态筛选（v17 Q3）。
 *
 * 四个状态里前三个只看产物与执行信息（便宜），`last-failed` 需要 latestRun
 * ——调用方须保证此时 latestRun 已填好。
 *
 * @param row - 已补执行信息的清单行。
 * @param status - 状态筛选值。
 * @returns 命中时返回 true。
 * @throws 不抛出异常。
 */
export function matchesStatusFilter(
  row: IWorkbenchSkillRow,
  status: TSkillListStatusFilterLike,
): boolean {
  switch (status) {
    case 'missing-document':
      return !row.hasSkillDocument
    case 'missing-script':
      return !row.hasPlaywrightScript
    case 'never-executed':
      return row.latestRun === undefined
    case 'last-failed':
      return (row.latestRun?.failed ?? 0) > 0
  }
}

/**
 * 读取一个用例的结构化数据。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns 用例数据；不可读时返回 undefined。
 * @throws 不抛出异常。
 */
export async function readTestCaseData(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<IE2ETestCase | undefined> {
  try {
    const document = await new FileE2ETestCaseRepository(storage).findBySkillId(
      skillId,
    )
    return document.testCase
  } catch {
    return undefined
  }
}

/**
 * 把运行编号（yyyyMMdd-HHmmss）转成 ISO 时间。
 *
 * 为什么需要它：`summary.json` 里的 `startedAt` 是 ISO，但**更早的报告**（或无
 * 摘要而降级的场合）只能靠目录名推导。目录名是本地时间，转 ISO 后前端可直接
 * 本地化展示。
 *
 * @param runId - 运行编号。
 * @returns ISO 字符串；格式不符时返回 undefined。
 * @throws 不抛出异常。
 */
export function runIdToIsoTime(runId: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(runId)
  if (!match) return undefined

  const [, year, month, day, hour, minute, second] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

/**
 * 判断指定用例是否已有 test.spec.ts。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns 文件存在返回 true；读取失败返回 false。
 * @throws 不抛出异常。
 */
export async function hasPlaywrightScript(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<boolean> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    await readFile(join(resolved.skillRoot, PLAYWRIGHT_SCRIPT_FILE_NAME))
    return true
  } catch {
    return false
  }
}

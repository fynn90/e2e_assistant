/**
 * 工作台的 SKILL 检索能力（v16，PRD ID-3）。
 *
 * 单一职责：回答「工作区内有哪些 e2e 用例、每个用例的产物是否齐备」与
 * 「某个用例的 SKILL.md 是什么内容」——即 Agent 定位目标所需的全部信息。
 *
 * 为什么独立成模块而不是塞进工作台服务：检索是**只读的查询能力**，
 * 与执行/生成的**编排能力**没有共享状态；分开后前者可被独立测试，
 * 工作台服务也只依赖它的接口（单一职责 / 接口隔离）。
 *
 * 安全边界（PRD SEC-2）：目标只能是 9 位唯一 ID，经 skill-manager 的
 * `resolveSkill` 在工作区内解析为目录——不接受路径、目录名或标题。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  SKILL_ENV_FILE_NAME,
  listSkills,
  resolveSkill,
} from '@authine-e2e-agent/skill-manager'
import type { ISkillStorageOptions } from '@authine-e2e-agent/skill-manager'
import {
  parseEnvFileContent,
  type IAgentSkillCandidate,
} from '@authine-e2e-agent/types'
import type { TReadSkillDocumentHostResult } from '@authine-e2e-agent/agent'
import {
  buildSkillDetailPayload,
  hasPlaywrightScript,
  matchesContentFilter,
  matchesStatusFilter,
  readLatestRun,
  readRunHistoryPayload,
  readSkillRowBase,
  readTestCaseData,
} from './skill-catalog-query'
import type {
  IRunHistoryViewPayload,
  ISkillDetailViewPayload,
  IWorkbenchSkillRow,
  TSkillListStatusFilterLike,
} from './skill-catalog-types'

/** 历史卡默认返回的最近次数（Q7）。 */
export const RUN_HISTORY_DEFAULT_LIMIT = 10

/** 检索结果的缓存失效不做缓冲：每次调用都读盘（工作区规模有限，且要反映最新状态）。 */
export interface ISkillCatalog {
  /**
   * 列出工作区内全部 e2e 用例及其产物完备性。
   *
   * @param rootDir - 工作区根目录。
   * @returns 候选列表；索引中条目不合法时跳过该条（不让单个坏条目拖垮整个列表）。
   * @throws 不抛出异常——工作区不可读时返回空列表（Agent 会据此如实说明「未找到」）。
   */
  listCandidates(rootDir: string): Promise<IAgentSkillCandidate[]>

  /**
   * 读取指定用例的 SKILL.md 全文。
   *
   * @param rootDir - 工作区根目录。
   * @param skillId - 用例唯一 ID（9 位 [a-z0-9]）。
   * @returns 文档内容与脚本存在性；不存在/未生成/不可读时返回归一化失败原因。
   * @throws 不抛出异常——所有失败都归一为 `{ ok: false }` 结果，由工具转述给模型。
   */
  readSkillDocument(
    rootDir: string,
    skillId: string,
  ): Promise<TReadSkillDocumentHostResult>

  /**
   * 带筛选的用例盘点（v17 Q1/Q3）。
   *
   * 筛选在**服务端**做而不是交给模型：① 命中数量要准确（Q3 要求说明「筛出几个」）；
   * ② 工作区规模上限无保证，模型端过滤撑不住规模；③ 同一份判定要同时供卡片与
   * 工具文本使用，两处各算一次必然分叉。
   *
   * @param rootDir - 工作区根目录。
   * @param filter - 关键词 / 标签 / 状态筛选；三者可同时生效（取交集）。
   * @returns 命中行与总数（`total` 为筛选后的命中数）。
   * @throws 不抛出异常——工作区不可读时返回空结果。
   */
  listFiltered(
    rootDir: string,
    filter: {
      keyword?: string
      tag?: string
      status?: TSkillListStatusFilterLike
    },
  ): Promise<{ rows: IWorkbenchSkillRow[]; total: number }>

  /**
   * 读取用例详情（v17 Q4）：结构化用例 + env key 清单 + 产物完备性。
   *
   * @param rootDir - 工作区根目录。
   * @param skillId - 用例唯一 ID。
   * @returns 详情；目标不存在或数据不可读时返回归一化失败。
   * @throws 不抛出异常。
   */
  readTestCase(
    rootDir: string,
    skillId: string,
  ): Promise<
    | { ok: true; detail: ISkillDetailViewPayload }
    | { ok: false; kind: 'not-found' | 'unavailable'; message: string }
  >

  /**
   * 读取执行历史（v17 Q7）：以持久化报告为准，最近 N 次。
   *
   * @param rootDir - 工作区根目录。
   * @param skillId - 用例唯一 ID。
   * @param limit - 最近次数上限（缺省 10）。
   * @returns 历史；目标不存在时返回归一化失败。
   * @throws 不抛出异常。
   */
  readRunHistory(
    rootDir: string,
    skillId: string,
    limit?: number,
  ): Promise<
    | { ok: true; history: IRunHistoryViewPayload }
    | { ok: false; kind: 'not-found' | 'unavailable'; message: string }
  >
}

/**
 * 创建 SKILL 检索服务。
 *
 * @returns 检索服务实例。
 * @throws 不抛出异常。
 */
export function createSkillCatalog(): ISkillCatalog {
  return {
    async listCandidates(rootDir) {
      const storage: ISkillStorageOptions = { rootDir }

      let summaries
      try {
        summaries = await listSkills(storage)
      } catch {
        // 工作区索引不可读（目录被移动、权限不足）：按「没有用例」处理，
        // Agent 会如实说明未找到；抛错会让模型误以为是自己调用错了。
        return []
      }

      const candidates: IAgentSkillCandidate[] = []

      for (const summary of summaries) {
        try {
          const [documentState, scriptExists, baseUrl] = await Promise.all([
            new FileSkillDocumentRepository(storage).getState(
              summary.id,
              // 存在性判定不关心来源哈希是否与新用例一致，传空串即可。
              '',
            ),
            hasPlaywrightScript(storage, summary.id),
            readBaseUrl(storage, summary.id),
          ])

          candidates.push({
            id: summary.id,
            title: summary.title,
            description: summary.description,
            hasSkillDocument: documentState.exists,
            hasPlaywrightScript: scriptExists,
            ...(baseUrl ? { baseUrl } : {}),
          })
        } catch {
          // 单个用例解析失败（索引与目录不一致、manifest 损坏）：跳过该条，
          // 不影响其余候选的可用性——其余用例仍可被正常定位与执行。
        }
      }

      return candidates
    },

    async readSkillDocument(rootDir, skillId) {
      const storage: ISkillStorageOptions = { rootDir }

      try {
        await resolveSkill(storage, skillId)
      } catch {
        // resolveSkill 的校验覆盖 ID 格式、索引存在性与目录合法性，
        // 失败即「目标不存在或不可访问」，统一按 not-found 归一。
        return {
          ok: false,
          kind: 'not-found',
          message: `工作区内不存在 ID 为 ${skillId} 的用例。`,
        }
      }

      try {
        const document = await new FileSkillDocumentRepository(
          storage,
        ).findBySkillId(skillId)

        if (!document) {
          return {
            ok: false,
            kind: 'not-found',
            message: `用例 ${skillId} 还没有 SKILL.md（尚未生成）。`,
          }
        }

        return {
          ok: true,
          content: document.content,
          hasPlaywrightScript: await hasPlaywrightScript(storage, skillId),
        }
      } catch (error) {
        return {
          ok: false,
          kind: 'unavailable',
          message: `读取用例 ${skillId} 的 SKILL.md 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },

    async listFiltered(rootDir, filter) {
      const storage: ISkillStorageOptions = { rootDir }

      let summaries
      try {
        summaries = await listSkills(storage)
      } catch {
        return { rows: [], total: 0 }
      }

      // 两阶段筛选（成本控制，技术方案 §6.1 第 1 点）：
      //   ① 先按**不依赖执行信息**的条件筛（产物完备性 / 关键词 / 标签）；
      //   ② **只对筛后的结果**补 latestRun，再做依赖执行信息的状态判定。
      // 顺序反过来会对整库逐条读报告目录，工作区一大会拖垮清单卡。
      const status = filter.status
      const needsRunInfo =
        status === 'never-executed' || status === 'last-failed'

      const survivors: Array<{ row: IWorkbenchSkillRow; skillRoot: string }> =
        []

      for (const summary of summaries) {
        try {
          const resolved = await resolveSkill(storage, summary.id)
          const [documentState, testCase] = await Promise.all([
            new FileSkillDocumentRepository(storage).getState(summary.id, ''),
            readTestCaseData(storage, summary.id),
          ])

          const base = await readSkillRowBase(
            resolved.skillRoot,
            summary.id,
            summary.title,
            summary.description,
            testCase,
          )
          const row: IWorkbenchSkillRow = {
            ...base,
            hasSkillDocument: documentState.exists,
          }

          // ① 不依赖执行信息的条件在这里就判掉（含「缺文档 / 缺脚本」两个状态）。
          if (!matchesContentFilter(base, filter, testCase)) continue
          if (
            status !== undefined &&
            !needsRunInfo &&
            !matchesStatusFilter(row, status)
          ) {
            continue
          }

          survivors.push({ row, skillRoot: resolved.skillRoot })
        } catch {
          // 单条解析失败跳过（与 listCandidates 同一处置）。
        }
      }

      // ② 补最近执行，再做依赖执行信息的状态终判。
      const rows: IWorkbenchSkillRow[] = []
      for (const survivor of survivors) {
        const latestRun = await readLatestRun(survivor.skillRoot)
        if (latestRun) survivor.row.latestRun = latestRun

        if (status !== undefined && needsRunInfo) {
          if (!matchesStatusFilter(survivor.row, status)) continue
        }

        rows.push(survivor.row)
      }

      return { rows, total: rows.length }
    },

    async readTestCase(rootDir, skillId) {
      const storage: ISkillStorageOptions = { rootDir }

      let skillRoot: string
      try {
        const resolved = await resolveSkill(storage, skillId)
        skillRoot = resolved.skillRoot
      } catch {
        return {
          ok: false,
          kind: 'not-found',
          message: `工作区内不存在 ID 为 ${skillId} 的用例。`,
        }
      }

      try {
        const testCase = await readTestCaseData(storage, skillId)
        if (!testCase) {
          return {
            ok: false,
            kind: 'unavailable',
            message: `用例 ${skillId} 的结构化数据不可读（e2e_schema.json 缺失或损坏）。`,
          }
        }

        const [documentState, scriptExists, envKeys] = await Promise.all([
          new FileSkillDocumentRepository(storage).getState(skillId, ''),
          hasPlaywrightScript(storage, skillId),
          readEnvKeySet(storage, skillId),
        ])

        const document = documentState.exists
          ? await new FileSkillDocumentRepository(storage).findBySkillId(
              skillId,
            )
          : undefined

        return {
          ok: true,
          detail: buildSkillDetailPayload({
            skillId,
            testCase,
            envKeys,
            hasSkillDocument: documentState.exists,
            hasPlaywrightScript: scriptExists,
            ...(document ? { documentContent: document.content } : {}),
          }),
        }
      } catch (error) {
        return {
          ok: false,
          kind: 'unavailable',
          message: `读取用例 ${skillId} 失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },

    async readRunHistory(rootDir, skillId, limit) {
      const storage: ISkillStorageOptions = { rootDir }

      let resolved
      try {
        resolved = await resolveSkill(storage, skillId)
      } catch {
        return {
          ok: false,
          kind: 'not-found',
          message: `工作区内不存在 ID 为 ${skillId} 的用例。`,
        }
      }

      try {
        const history = await readRunHistoryPayload(
          resolved.skillRoot,
          skillId,
          resolved.detail.title,
          limit ?? RUN_HISTORY_DEFAULT_LIMIT,
        )
        return { ok: true, history }
      } catch (error) {
        return {
          ok: false,
          kind: 'unavailable',
          message: `读取用例 ${skillId} 的执行历史失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
  }
}

/**
 * 读取 env.json 的 key 集合（缺失判定的对照面）。
 *
 * 只取 key，不取 value——值在这一层就不进入内存（D7 的结构性保证）。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns key 集合；文件缺失或非法时返回空集（全部引用都会被判为缺失，
 *   这是保守方向：多提示一个缺失比漏提示一个更安全）。
 * @throws 不抛出异常。
 */
async function readEnvKeySet(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<ReadonlySet<string>> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    const content = await readFile(
      join(resolved.skillRoot, SKILL_ENV_FILE_NAME),
      'utf8',
    )
    const parsed = parseEnvFileContent(content)
    // 解析失败（data 为 null）时返回空集：全部引用都会被判为缺失。
    // 这是保守方向——多提示一个缺失比漏提示一个更安全。
    return new Set(parsed.data ? Object.keys(parsed.data) : [])
  } catch {
    return new Set()
  }
}

/**
 * 读取用例的 baseUrl（供 Agent 判断相关性）。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns baseUrl；用例数据缺失或未配置时返回 undefined。
 * @throws 不抛出异常。
 */
async function readBaseUrl(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<string | undefined> {
  try {
    const document = await new FileE2ETestCaseRepository(storage).findBySkillId(
      skillId,
    )
    return document.testCase.baseUrl || undefined
  } catch {
    return undefined
  }
}

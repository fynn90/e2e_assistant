/**
 * 提案服务（v17 §6.3）：四类「用户确认后才生效」的动作的**唯一状态机与唯一落点**。
 *
 * ## 为什么四类合成一个服务而不是各写一套
 *
 * 变更 / 补齐 / 清理 / 删除在用户视角是四件事，在实现上却是同一个形状——
 *「Agent 提议 → 落盘登记 → 用户在前端操作 → 平台应用 → 卡片定格」。
 * 状态迁移、冲突处理、服务重启后的恢复、终态物化这四段逻辑，各写一遍必然分叉；
 * 而它们又都涉及**写操作**，分叉的代价是安全边界不一致。
 *
 * 差异只集中在 `apply` 的一张表（见 `applyProposal` 的分派）：
 *
 *   | 提案 | apply 做什么 | 复用的既有能力 |
 *   | --- | --- | --- |
 *   | case-change | 提案时算好的目标内容 + 提案时读到的 expectedVersion → updateE2ETestCase | 乐观锁 |
 *   | env-fill | 读当前 env.json → 合并用户填的 key/values → writeSkillFile | env 专用校验闸门 |
 *   | report-cleanup | 先查任务注册表 → 逐个 deleteTestReportRun | runId 白名单 |
 *   | case-delete | 检查任务注册表 → deleteSkill + DB 级联 | 用例生命周期服务 |
 *
 * ## 持久化与恢复（与动作卡片的**故意不同**）
 *
 * 提案登记在内存，但卡片块物化落盘；服务重启后从已落盘块恢复登记，
 * **但恢复出的提案一律置 `expired`**。理由：提案持有的是「提议时刻的磁盘快照」，
 * 重启后该快照可能已失真；让用户重新发起比应用一份可能过期的变更安全。
 * 这与动作卡片可从历史恢复不同——动作卡片是「重新做一件事」，提案是
 * 「应用一份旧快照」。
 *
 * ## 值不经过 Agent（D7）
 *
 * env-fill 的 `envValues` 只走 `apply` 的参数、只进 `writeSkillFile`——
 * 不进事件、不进工作块、不进模型上下文。这是结构性的：提案块的结构里
 * 根本没有放值的字段。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  FileE2ETestCaseRepository,
  SKILL_ENV_FILE_NAME,
  deleteTestReportRun,
  listTestReportRuns,
  readFixedUtf8File,
  readTestReportSummary,
  resolveSkill,
  writeSkillFile,
} from '@authine-e2e-agent/skill-manager'
import type { ISkillStorageOptions } from '@authine-e2e-agent/skill-manager'
import {
  parseEnvFileContent,
  type ICaseChangeTargets,
  type IEnvKeyOperation,
  type IProposalChange,
  type TAgentWorkbenchProposalKind,
  type TAgentWorkbenchProposalState,
  type TCaseChangeOrigin,
  type IE2ETestCase,
} from '@authine-e2e-agent/types'
import type { IAgentWorkRuntime } from '../../agent-runtime/agent-work-runtime'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import { ApiError } from '../../shared/errors/api-error'
import {
  describeAssertionLayerRefusal,
  findAssertionLayerChanges,
} from './assertion-layer'
import {
  diffCaseChange,
  diffCaseDeletion,
  diffReportCleanup,
} from './proposal-changes'
import type { ISkillLifecycleService } from './skill-lifecycle-service'
import type { IUpdateE2ETestCase } from './proposal-types'

/** 提案登记（内存）的形态。 */
interface IProposalRecord {
  proposalId: string
  kind: TAgentWorkbenchProposalKind
  skillId: string
  skillTitle: string
  label: string
  description?: string
  state: TAgentWorkbenchProposalState
  sessionId: string
  /** case-change：提案时算好的目标用例与读到的版本（apply 的输入）。 */
  caseChange?: {
    target: IE2ETestCase
    expectedVersion: string
    origin: TCaseChangeOrigin
  }
  /** env-fill：待补齐的 key 与 key 级操作。 */
  envFill?: {
    envKeys: Array<{ key: string; usage: string }>
    envKeyOps: IEnvKeyOperation[]
  }
  /** report-cleanup：待删除的 runId 列表。 */
  runIds?: string[]
  changes?: IProposalChange[]
  requiresModalConfirm: boolean
  reportCount?: number
  releaseBytes?: number
  evidence?: { actual: string; expected: string; verifiedBy: string }
  resultMessage?: string
}

/**
 * 把登记记录适配成卡片发布入参。
 *
 * 为什么要一层适配而不是让记录直接实现入参接口：记录的字段是**业务形态**
 *（`caseChange` 持有完整的目标用例、`envFill` 持有 key 清单），而卡片入参是
 * **展示形态**（扁平、只带渲染需要的字段）。两者刻意不同——把完整目标用例
 * 塞进事件会让每个提案块都背负一整份用例数据（且可能含 testData 里的引用）。
 *
 * @param runtime - 承载该会话的运行时。
 * @param record - 提案记录。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function publishProposal(
  runtime: IAgentWorkRuntime,
  record: IProposalRecord,
): void {
  runtime.publishProposalCard({
    proposalId: record.proposalId,
    proposalKind: record.kind,
    sessionId: record.sessionId,
    skillId: record.skillId,
    skillTitle: record.skillTitle,
    label: record.label,
    ...(record.description ? { description: record.description } : {}),
    state: record.state,
    ...(record.changes ? { changes: record.changes } : {}),
    ...(record.envFill ? { envKeys: record.envFill.envKeys } : {}),
    ...(record.envFill && record.envFill.envKeyOps.length > 0
      ? { envKeyOps: record.envFill.envKeyOps }
      : {}),
    requiresModalConfirm: record.requiresModalConfirm,
    ...(record.reportCount !== undefined
      ? { reportCount: record.reportCount }
      : {}),
    ...(record.releaseBytes !== undefined
      ? { releaseBytes: record.releaseBytes }
      : {}),
    ...(record.evidence ? { evidence: record.evidence } : {}),
    ...(record.resultMessage ? { resultMessage: record.resultMessage } : {}),
  })
}

/** 提案服务的依赖。 */
export interface IProposalServiceDependencies {
  /** 任务注册表（L2c 删除检查 / L1b 清理检查的来源）。 */
  taskRegistry: IGenerationTaskRegistry
  /** 用例保存（E 组 apply 的落点，提供乐观锁）。 */
  updateTestCase: IUpdateE2ETestCase
  /** 用例生命周期（删除 apply 的落点）。 */
  skillLifecycle: ISkillLifecycleService
}

/** 创建提案（Agent 工具调用时）的输入。 */
export interface ICreateProposalInput {
  rootDir: string
  sessionId: string
  runtime: IAgentWorkRuntime
  kind: TAgentWorkbenchProposalKind
  skillId: string
  /** case-change：提案来源（**由工具的宿主在调用点置位**，模型无从传入）。 */
  origin?: TCaseChangeOrigin
  /** case-change：模型给出的目标值（不是 diff）。 */
  caseChange?: ICaseChangeTargets
  /** env-fill：缺失的 key（**只含 key**）。 */
  envKeys?: Array<{ key: string; usage: string }>
  /** env-fill：key 级维护（V6）。 */
  envKeyOps?: IEnvKeyOperation[]
  /** report-cleanup：待清理的 runId 列表。 */
  runIds?: string[]
}

/** 提案服务接口。 */
export interface IProposalService {
  /**
   * 创建一份提案。**不执行任何写操作**。
   *
   * @param input - 提案种类、目标与按种类区分的载荷。
   * @returns 提案 ID；被拒绝时 message 说明原因。
   * @throws 不抛出异常——失败以 ok:false 归一，由工具转述给模型。
   */
  create(
    input: ICreateProposalInput,
  ): Promise<{ ok: true; message: string } | { ok: false; message: string }>

  /**
   * 应用一份提案（前端确认后调用）。
   *
   * @param input - 目标会话、提案 ID 与可选 env 值。
   * @returns 应用结果；冲突 / 失败时带状态与原因。
   * @throws ApiError 提案不存在时抛出（404）。
   */
  apply(input: {
    rootDir: string
    sessionId: string
    proposalId: string
    /** env-fill：用户填写的值（**不落盘、不入块、不经模型**）。 */
    envValues?: Record<string, string>
  }): Promise<
    | { ok: true; message: string }
    | { ok: false; state: 'conflict' | 'failed'; message: string }
  >

  /**
   * 取消一份提案（前端）。
   *
   * @param input - 目标会话与提案 ID。
   * @returns 取消完成时兑现。
   * @throws ApiError 提案不存在时抛出（404）。
   */
  cancel(input: {
    runtime: IAgentWorkRuntime
    sessionId: string
    proposalId: string
  }): Promise<{ ok: true }>

  /**
   * 登记一个已落盘的提案块（服务重启后从历史恢复时调用）。
   *
   * 恢复出的提案一律置 `expired`——见文件头注释的理由。
   *
   * @param runtime - 承载该会话的运行时。
   * @param sessionId - 会话 ID。
   * @param proposalId - 提案 ID。
   * @returns 恢复出的记录；找不到时返回 undefined。
   * @throws 不抛出异常。
   */
  recover(
    runtime: IAgentWorkRuntime,
    sessionId: string,
    proposalId: string,
  ): IProposalRecord | undefined
}

/**
 * 创建提案服务。
 *
 * @param dependencies - 任务注册表、用例保存与生命周期服务。
 * @returns 提案服务实例。
 * @throws 不抛出异常。
 */
export function createProposalService(
  dependencies: IProposalServiceDependencies,
): IProposalService {
  /** 提案登记表（proposalId → 记录）。 */
  const proposals = new Map<string, IProposalRecord>()

  return {
    async create(input) {
      return createProposal(dependencies, proposals, input)
    },

    async apply(input) {
      return applyProposal(dependencies, proposals, input)
    },

    async cancel(input) {
      const record = requireProposal(
        proposals,
        input.sessionId,
        input.proposalId,
      )
      record.state = 'cancelled'
      publishProposal(input.runtime, record)
      // 用户可以再点「应用」——但状态已定格为 cancelled，取消是终态。
      return { ok: true }
    },

    recover(runtime, sessionId, proposalId) {
      return recoverProposal(runtime, proposals, sessionId, proposalId)
    },
  }
}

/**
 * 创建一份提案：按种类读盘算对照、登记并发布卡片。
 *
 * @param dependencies - 服务依赖。
 * @param proposals - 提案登记表。
 * @param input - 创建输入。
 * @returns 创建结果。
 * @throws 不抛出异常。
 */
async function createProposal(
  dependencies: IProposalServiceDependencies,
  proposals: Map<string, IProposalRecord>,
  input: ICreateProposalInput,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const storage: ISkillStorageOptions = { rootDir: input.rootDir }

  let skillRoot: string
  let skillTitle: string
  try {
    const resolved = await resolveSkill(storage, input.skillId)
    skillRoot = resolved.skillRoot
    skillTitle = resolved.detail.title
  } catch {
    return {
      ok: false,
      message: `工作区内不存在 ID 为 ${input.skillId} 的用例，无法生成提案。`,
    }
  }

  switch (input.kind) {
    case 'case-change':
      return createCaseChangeProposal(
        proposals,
        input,
        storage,
        skillRoot,
        skillTitle,
      )
    case 'env-fill':
      return createEnvFillProposal(proposals, input, storage, skillTitle)
    case 'report-cleanup':
      return createReportCleanupProposal(
        proposals,
        input,
        skillRoot,
        skillTitle,
      )
    case 'case-delete':
      return createCaseDeletionProposal(
        dependencies,
        proposals,
        input,
        skillRoot,
        skillTitle,
      )
  }
}

/** 创建用例变更提案（E 组 / G5 组共用通道，红线只对后者生效）。 */
async function createCaseChangeProposal(
  proposals: Map<string, IProposalRecord>,
  input: ICreateProposalInput,
  storage: ISkillStorageOptions,
  skillRoot: string,
  skillTitle: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const targets = input.caseChange
  if (!targets) {
    return { ok: false, message: '用例变更提案缺少目标内容。' }
  }

  const repository = new FileE2ETestCaseRepository(storage)
  let current: { testCase: IE2ETestCase; version: string }
  try {
    const document = await repository.findBySkillId(input.skillId)
    current = { testCase: document.testCase, version: document.version }
  } catch {
    return {
      ok: false,
      message: `用例 ${input.skillId} 的结构化数据不可读，无法生成变更提案。`,
    }
  }

  // 目标用例 = 现状 + 目标值（未给的字段沿用现状——卡片上因此只出现真正改动的项）。
  const target = mergeTargets(current.testCase, targets)

  // 断言层红线（G5c）：**只对 agent-analysis 生效**（用户有权改自己的用例）。
  const origin = input.origin ?? 'user'
  if (origin === 'agent-analysis') {
    const violations = findAssertionLayerChanges(current.testCase, target)
    if (violations.length > 0) {
      return { ok: false, message: describeAssertionLayerRefusal(violations) }
    }
  }

  const changes = diffCaseChange(current.testCase, targets)
  if (changes.length === 0) {
    return {
      ok: false,
      message:
        '目标值与当前内容完全一致，没有需要变更的项。请确认用户到底要改什么。',
    }
  }

  const record: IProposalRecord = {
    proposalId: randomUUID(),
    kind: 'case-change',
    skillId: input.skillId,
    skillTitle,
    label: origin === 'agent-analysis' ? '用例修复提案' : '用例变更提案',
    description:
      origin === 'agent-analysis'
        ? '这是基于页面核对结果提出的用例修改建议；确认后由平台写入。'
        : '确认后由平台校验并写入用例数据。',
    state: 'pending',
    sessionId: input.sessionId,
    caseChange: { target, expectedVersion: current.version, origin },
    changes,
    // 变更与 env 补齐是「用户明确表达意图后才生成」的，再弹一次是重复确认（D2）。
    requiresModalConfirm: false,
    ...(targets.evidence ? { evidence: targets.evidence } : {}),
  }
  proposals.set(record.proposalId, record)
  publishProposal(input.runtime, record)

  return {
    ok: true,
    message:
      '变更提案已在对话流中给出。请用文本说明**将要改什么**（不要复述卡片里的完整对照表），并等用户在卡片上确认；未确认前不会写入任何数据。',
  }
}

/** 创建环境变量补齐提案（V 组）。 */
async function createEnvFillProposal(
  proposals: Map<string, IProposalRecord>,
  input: ICreateProposalInput,
  storage: ISkillStorageOptions,
  skillTitle: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const envKeys = input.envKeys ?? []
  const envKeyOps = input.envKeyOps ?? []
  if (envKeys.length === 0 && envKeyOps.length === 0) {
    return { ok: false, message: '补齐提案缺少待处理的 key。' }
  }

  // 补齐的 key 必须是「确实缺失」的：若 env.json 里已经有了，说明用户已经补过
  // 或模型判断有误——给出一个无意义的输入框比不给更糟。
  if (envKeys.length > 0) {
    const existing = await readEnvKeySet(storage, input.skillId)
    const already = envKeys.filter((item) => existing.has(item.key))
    if (already.length > 0) {
      return {
        ok: false,
        message: `这些 key 在 env.json 中已经存在，无需补齐：${already
          .map((item) => item.key)
          .join('、')}。若用户是要改值，请引导他到环境变量编辑页。`,
      }
    }
  }

  const changes: IProposalChange[] = [
    ...envKeys.map((item) => ({
      target: `环境变量 ${item.key}`,
      op: 'add' as const,
      after: `由你在卡片中填写（用途：${item.usage}）`,
    })),
    ...envKeyOps.map((item) => ({
      target: `环境变量 ${item.key}`,
      op: item.op === 'add' ? ('add' as const) : ('remove' as const),
    })),
  ]

  const record: IProposalRecord = {
    proposalId: randomUUID(),
    kind: 'env-fill',
    skillId: input.skillId,
    skillTitle,
    label: '环境变量补齐',
    description:
      '这些值由你直接保存给平台，不会出现在对话与日志中，也不会进入模型的上下文。',
    state: 'pending',
    sessionId: input.sessionId,
    envFill: { envKeys, envKeyOps },
    changes,
    requiresModalConfirm: false,
  }
  proposals.set(record.proposalId, record)
  publishProposal(input.runtime, record)

  return {
    ok: true,
    message:
      '补齐卡已在对话流中给出。请告知用户「在卡片里直接填写并保存」，并说明值不会经过你；**不要接收、不要复述用户可能说出的值**。',
  }
}

/** 创建报告清理提案（L1）。 */
async function createReportCleanupProposal(
  proposals: Map<string, IProposalRecord>,
  input: ICreateProposalInput,
  skillRoot: string,
  skillTitle: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const requested = input.runIds ?? []
  if (requested.length === 0) {
    return { ok: false, message: '清理提案缺少要删除的报告。' }
  }

  // 只接受确实存在的报告目录（模型可能凭记忆给了编号）。
  const existing = new Set(await listTestReportRuns(skillRoot))
  const runIds = requested.filter((runId) => existing.has(runId))
  if (runIds.length === 0) {
    return {
      ok: false,
      message:
        '给出的运行编号在该用例的报告目录里都不存在。请先用 read_run_history 或历史卡确认实际有哪些报告。',
    }
  }

  const summaries = await Promise.all(
    runIds.map(async (runId) => {
      const summary = await readTestReportSummary(skillRoot, runId)
      return {
        runId,
        at: summary?.startedAt ?? '',
        passed: summary?.stats.passed ?? 0,
        failed: (summary?.stats.failed ?? 0) + (summary?.stats.timedOut ?? 0),
        bytes: 0,
      }
    }),
  )

  const record: IProposalRecord = {
    proposalId: randomUUID(),
    kind: 'report-cleanup',
    skillId: input.skillId,
    skillTitle,
    label: `删除 ${runIds.length} 份报告`,
    description: '删除后不可撤销。',
    state: 'pending',
    sessionId: input.sessionId,
    runIds,
    changes: diffReportCleanup(summaries),
    // L1a：报告清理恒需二次弹框（D2 的产品规则，由服务端判定，前端不自行推断）。
    requiresModalConfirm: true,
  }
  proposals.set(record.proposalId, record)
  publishProposal(input.runtime, record)

  return {
    ok: true,
    message: `清理提案已在对话流中给出（${runIds.length} 份报告）。请说明这是不可撤销的操作，用户在卡片上点按钮后还会再弹一次确认框。`,
  }
}

/** 创建用例删除提案（L2）。 */
async function createCaseDeletionProposal(
  dependencies: IProposalServiceDependencies,
  proposals: Map<string, IProposalRecord>,
  input: ICreateProposalInput,
  skillRoot: string,
  skillTitle: string,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  // L2c：有任务在跑时**提前告知**（apply 时还会再查一次——那是权威判定，
  // 这里是让用户在提案阶段就知道要先停任务）。
  const running = dependencies.taskRegistry.currentSessionId(input.skillId)
  if (running) {
    return {
      ok: false,
      message:
        '该用例正在执行或有生成任务在跑，现在不能删除。请先停止任务（执行卡片上的「停止执行」或生成卡片上的中止），再发起删除。',
    }
  }

  const runCount = (await listTestReportRuns(skillRoot)).length
  const documentState = await readDocumentAndScriptState(skillRoot)

  const record: IProposalRecord = {
    proposalId: randomUUID(),
    kind: 'case-delete',
    skillId: input.skillId,
    skillTitle,
    label: `删除用例「${skillTitle}」`,
    description:
      '将删除该用例的文档、脚本、全部报告与用户产物，不可撤销。删除只影响该用例自身的资产，不影响其他用例与会话记录。',
    state: 'pending',
    sessionId: input.sessionId,
    changes: diffCaseDeletion({
      skillTitle,
      hasSkillDocument: documentState.hasSkillDocument,
      hasPlaywrightScript: documentState.hasPlaywrightScript,
      reportCount: runCount,
    }),
    // L2a：用例删除恒需二次弹框。
    requiresModalConfirm: true,
    reportCount: runCount,
  }
  proposals.set(record.proposalId, record)
  publishProposal(input.runtime, record)

  return {
    ok: true,
    message: `用例删除卡已在对话流中给出。请说明将删除的内容与不可撤销，用户在卡片上点按钮后还会再弹一次确认框。`,
  }
}

/**
 * 应用一份提案（四类共用入口，差异集中在下方分派表）。
 *
 * @param dependencies - 服务依赖。
 * @param proposals - 提案登记表。
 * @param input - 应用输入。
 * @returns 应用结果。
 * @throws ApiError 提案不存在时抛出。
 */
async function applyProposal(
  dependencies: IProposalServiceDependencies,
  proposals: Map<string, IProposalRecord>,
  input: {
    rootDir: string
    sessionId: string
    proposalId: string
    envValues?: Record<string, string>
  },
): Promise<
  | { ok: true; message: string }
  | { ok: false; state: 'conflict' | 'failed'; message: string }
> {
  const record = requireProposal(proposals, input.sessionId, input.proposalId)

  if (record.state !== 'pending') {
    return {
      ok: false,
      state: 'failed',
      message: settledMessage(record.state),
    }
  }

  switch (record.kind) {
    case 'case-change':
      return applyCaseChange(dependencies, record, input)
    case 'env-fill':
      return applyEnvFill(record, input)
    case 'report-cleanup':
      return applyReportCleanup(dependencies, record, input.rootDir)
    case 'case-delete':
      return applyCaseDeletion(dependencies, record, input.rootDir)
  }
}

/** 应用用例变更（E4 冲突 → conflict；校验不过 → failed 并就地显示原因）。 */
async function applyCaseChange(
  dependencies: IProposalServiceDependencies,
  record: IProposalRecord,
  input: { rootDir: string; sessionId: string; proposalId: string },
): Promise<
  | { ok: true; message: string }
  | { ok: false; state: 'conflict' | 'failed'; message: string }
> {
  const caseChange = record.caseChange
  if (!caseChange) {
    return { ok: false, state: 'failed', message: '提案内容缺失。' }
  }

  try {
    await dependencies.updateTestCase({
      rootDir: input.rootDir,
      skillId: record.skillId,
      request: {
        testCase: caseChange.target,
        expectedVersion: caseChange.expectedVersion,
      },
    })
  } catch (error) {
    return classifyApplyError(error, '用例变更')
  }

  record.state = 'applied'
  record.resultMessage = '用例已更新，文档与脚本可能已过期。'
  return {
    ok: true,
    message:
      '用例已更新。请提示用户「文档与脚本可能已过期」，并按缺口给出更新动作卡片（E6）——不要让用户以为改了用例就万事大吉。',
  }
}

/** 应用环境变量补齐（值由用户填写，只在此处进入平台）。 */
async function applyEnvFill(
  record: IProposalRecord,
  input: {
    rootDir: string
    sessionId: string
    proposalId: string
    envValues?: Record<string, string>
  },
): Promise<
  | { ok: true; message: string }
  | { ok: false; state: 'conflict' | 'failed'; message: string }
> {
  const envFill = record.envFill
  if (!envFill) {
    return { ok: false, state: 'failed', message: '提案内容缺失。' }
  }

  const storage: ISkillStorageOptions = { rootDir: input.rootDir }
  const current = await readEnvFileRaw(storage, record.skillId)
  if (current === undefined) {
    return {
      ok: false,
      state: 'failed',
      message: 'env.json 不可读，无法保存。请先修复该文件。',
    }
  }

  // 合并：补齐的 key 取用户填的值；key 级操作按 add/remove 施加。
  // **值只在这一层出现**，不写入提案块、不返回给模型（D7）。
  const nextValues: Record<string, string> = { ...current }

  for (const item of envFill.envKeys) {
    const value = input.envValues?.[item.key]
    if (value === undefined) {
      return {
        ok: false,
        state: 'failed',
        message: `key「${item.key}」还没有填写值，无法保存。`,
      }
    }
    nextValues[item.key] = value
  }

  for (const item of envFill.envKeyOps) {
    if (item.op === 'add') {
      if (!(item.key in nextValues)) nextValues[item.key] = ''
    } else {
      delete nextValues[item.key]
    }
  }

  // 合并结果交回给 env 专用校验闸门（F10）：非法内容不落盘，
  // 磁盘保持上一份合法内容；失败时就地显示原因，已填内容不丢失（V4）。
  const nextContent = JSON.stringify(nextValues, null, 2)

  try {
    const resolved = await resolveSkill(storage, record.skillId)
    const snapshot = await readFixedUtf8File(
      resolved.skillRoot,
      SKILL_ENV_FILE_NAME,
    )
    if (!snapshot) {
      return {
        ok: false,
        state: 'failed',
        message: 'env.json 不存在或不可读，无法保存。请先修复该文件。',
      }
    }

    await writeSkillFile(storage, record.skillId, {
      relativePath: SKILL_ENV_FILE_NAME,
      content: nextContent,
      expectedVersion: snapshot.version,
    })
  } catch (error) {
    return classifyApplyError(error, '环境变量保存')
  }

  record.state = 'applied'
  record.resultMessage = '环境变量已补齐。'
  return {
    ok: true,
    message:
      '环境变量已补齐。请给出「执行」入口（V4 的闭环），并说明卡片上不会显示这些值。',
  }
}

/**
 * 应用报告清理（L1b：有任务则整次拒绝；L4：单个删不动时逐条列出）。
 *
 * 注意与 L4 的分工：L1b 的并发检查发生在**开始前**，是整次拒绝；
 * L4 的「逐条列出」只用于**删除过程中**的个别失败（权限、被占用）。
 * 两者不冲突。
 */
async function applyReportCleanup(
  dependencies: IProposalServiceDependencies,
  record: IProposalRecord,
  rootDir: string,
): Promise<
  | { ok: true; message: string }
  | { ok: false; state: 'conflict' | 'failed'; message: string }
> {
  const runIds = record.runIds
  if (!runIds || runIds.length === 0) {
    return { ok: false, state: 'failed', message: '提案内容缺失。' }
  }

  // L1b：报告是执行期才写入的产物，而报告链路不参与业务锁——清理与写入之间
  // 没有任何互斥。因此**必须先查任务注册表**：有任务就整次拒绝，
  // 不改成「跳过当前那次」（正在写入的 runId 尚未完成后端登记，平台无法
  // 可靠判断哪一份是安全的）。
  if (dependencies.taskRegistry.currentSessionId(record.skillId)) {
    return {
      ok: false,
      state: 'failed',
      message:
        '该用例正在执行，报告目录正在被写入。请等待本次执行结束或先停止它，再清理报告。',
    }
  }

  const storage: ISkillStorageOptions = { rootDir }
  let skillRoot: string
  try {
    skillRoot = (await resolveSkill(storage, record.skillId)).skillRoot
  } catch {
    // 目标已不存在：这不是「失败」而是「失效」——但状态的语义边界在
    // 提案服务的状态机上，这里按 failed 归一（卡片会显示原因）。
    return {
      ok: false,
      state: 'failed',
      message: '该用例已不存在，报告无法清理。',
    }
  }

  const removed: string[] = []
  const failed: Array<{ runId: string; reason: string }> = []

  // 逐个删除：单个失败继续其余（L4），最后如实汇总。
  for (const runId of runIds) {
    try {
      await deleteTestReportRun(skillRoot, runId)
      removed.push(runId)
    } catch (error) {
      failed.push({
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 全部失败 → failed（用户需要知道这次什么都没删掉）。
  if (removed.length === 0) {
    return {
      ok: false,
      state: 'failed',
      message: `报告清理失败，没有删除任何文件：\n${failed
        .map((item) => `- ${item.runId}：${item.reason}`)
        .join('\n')}`,
    }
  }

  record.state = 'applied'
  record.resultMessage = `已删除 ${removed.length} 份报告。`
  return {
    ok: true,
    message:
      failed.length > 0
        ? `已删除 ${removed.length} 份报告，${failed.length} 份删除失败：\n${failed
            .map((item) => `- ${item.runId}：${item.reason}`)
            .join(
              '\n',
            )}\n请把失败项与原因如实逐条告知用户，**不要笼统说「清理完成」**。`
        : `已删除 ${removed.length} 份报告。请如实报告删除数量。`,
  }
}

/** 应用用例删除（L2c：有任务则拒绝）。 */
async function applyCaseDeletion(
  dependencies: IProposalServiceDependencies,
  record: IProposalRecord,
  rootDir: string,
): Promise<
  | { ok: true; message: string }
  | { ok: false; state: 'conflict' | 'failed'; message: string }
> {
  try {
    await dependencies.skillLifecycle.deleteCase({
      rootDir,
      skillId: record.skillId,
      taskRegistry: dependencies.taskRegistry,
    })
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 'CHAT_CONCURRENCY_LIMITED'
    ) {
      return { ok: false, state: 'failed', message: error.message }
    }
    return classifyApplyError(error, '用例删除')
  }

  record.state = 'applied'
  record.resultMessage = '用例已删除。'
  return {
    ok: true,
    message:
      '用例已删除。请给出结束语；历史会话中引用该用例的卡片会自动标注「用例已删除」（L2d），报告入口不再可用。',
  }
}

/**
 * 把 apply 的异常归类为 conflict / failed 并给出可操作的原因。
 *
 * @param error - 抛出的异常。
 * @param action - 动作名（拼进文案）。
 * @returns 失败结果。
 * @throws 不抛出异常。
 */
function classifyApplyError(
  error: unknown,
  action: string,
): { ok: false; state: 'conflict' | 'failed'; message: string } {
  const code =
    error instanceof Error && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  const rawMessage = error instanceof Error ? error.message : String(error)

  // E4：版本冲突 → 提示重新生成提案，不得强制覆盖。
  if (code === 'FILE_VERSION_CONFLICT') {
    return {
      ok: false,
      state: 'conflict',
      message: `${action}失败：用例已被其他入口修改（版本冲突）。请重新生成提案，不要强制覆盖。`,
    }
  }

  return {
    ok: false,
    state: 'failed',
    message: `${action}失败：${rawMessage}`,
  }
}

/**
 * 从已物化的工作块恢复一份提案登记（服务重启后）。
 *
 * 恢复出的提案**一律置 `expired`**：它持有的是提议时刻的磁盘快照，
 * 重启后该快照可能已失真。让用户重新发起比应用一份可能过期的变更安全
 *（与动作卡片「可从历史恢复」的理由故意不同）。
 *
 * @param runtime - 承载该会话的运行时。
 * @param proposals - 提案登记表。
 * @param sessionId - 会话 ID。
 * @param proposalId - 提案 ID。
 * @returns 恢复出的记录；找不到时返回 undefined。
 * @throws 不抛出异常。
 */
function recoverProposal(
  runtime: IAgentWorkRuntime,
  proposals: Map<string, IProposalRecord>,
  sessionId: string,
  proposalId: string,
): IProposalRecord | undefined {
  try {
    const block = runtime
      .listBlocks(sessionId)
      .find(
        (item) =>
          item.kind === 'workbench_proposal' &&
          (item.payload as { proposalId?: unknown }).proposalId === proposalId,
      )
    if (!block) return undefined

    const payload = block.payload as {
      proposalKind?: TAgentWorkbenchProposalKind
      skillId?: string
      skillTitle?: string
      label?: string
      requiresModalConfirm?: boolean
    }
    if (!payload.proposalKind || typeof payload.label !== 'string') {
      return undefined
    }

    const recovered: IProposalRecord = {
      proposalId,
      kind: payload.proposalKind,
      skillId: payload.skillId ?? '',
      skillTitle: payload.skillTitle ?? '',
      label: payload.label,
      state: 'expired',
      sessionId,
      requiresModalConfirm: payload.requiresModalConfirm === true,
      resultMessage:
        '会话或服务重启后，先前生成的提案需重新发起（提案持有的是提议时刻的磁盘快照，可能已过期）。',
    }
    proposals.set(proposalId, recovered)
    return recovered
  } catch {
    return undefined
  }
}

/**
 * 取出一份属于该会话的提案（不存在或归属不符时抛 404）。
 *
 * @param proposals - 提案登记表。
 * @param sessionId - 会话 ID。
 * @param proposalId - 提案 ID。
 * @returns 提案记录。
 * @throws ApiError（INVALID_REQUEST / 404）提案不存在或归属不符。
 */
function requireProposal(
  proposals: Map<string, IProposalRecord>,
  sessionId: string,
  proposalId: string,
): IProposalRecord {
  const record = proposals.get(proposalId)
  if (!record || record.sessionId !== sessionId) {
    throw new ApiError({
      code: 'INVALID_REQUEST',
      status: 404,
      message: '该提案不存在或已失效，请重新发起。',
    })
  }
  return record
}

/** 已定格的提案的说明文案。 */
function settledMessage(state: TAgentWorkbenchProposalState): string {
  switch (state) {
    case 'applied':
      return '该提案已经应用过了。'
    case 'cancelled':
      return '该提案已被取消，如需继续请重新发起。'
    case 'expired':
      return '该提案已失效（会话或服务重启后需重新发起）。'
    case 'conflict':
      return '该提案存在冲突，请重新生成提案。'
    case 'failed':
      return '该提案上次应用失败，请重新发起。'
    case 'pending':
      return ''
  }
}

/**
 * 把目标值合并进当前用例（未给的字段沿用现状）。
 *
 * @param current - 磁盘上的当前用例。
 * @param targets - 模型给出的目标值。
 * @returns 合并后的目标用例。
 * @throws 不抛出异常。
 */
function mergeTargets(
  current: IE2ETestCase,
  targets: ICaseChangeTargets,
): IE2ETestCase {
  return {
    ...current,
    ...(targets.title !== undefined ? { title: targets.title } : {}),
    ...(targets.description !== undefined
      ? { description: targets.description }
      : {}),
    ...(targets.baseUrl !== undefined ? { baseUrl: targets.baseUrl } : {}),
    ...(targets.tags !== undefined ? { tags: targets.tags } : {}),
    ...(targets.preconditions !== undefined
      ? { preconditions: targets.preconditions }
      : {}),
    ...(targets.steps !== undefined
      ? {
          steps: targets.steps.map((step) => ({
            id: step.id,
            order: step.order,
            description: step.description,
            action: step.action,
            expectedResult: step.expectedResult,
            testData: step.testData ?? {},
            enabled: step.enabled,
          })),
        }
      : {}),
  }
}

/**
 * 读取 env.json 的 key 集合（缺失判定用，不取值）。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns key 集合；文件缺失或非法时为空集。
 * @throws 不抛出异常。
 */
async function readEnvKeySet(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<Set<string>> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    const snapshot = await readFixedUtf8File(
      resolved.skillRoot,
      SKILL_ENV_FILE_NAME,
    )
    if (!snapshot) return new Set()
    const parsed = parseEnvFileContent(snapshot.content)
    return new Set(parsed.data ? Object.keys(parsed.data) : [])
  } catch {
    return new Set()
  }
}

/**
 * 读取 env.json 的当前键值（写入前合并用）。
 *
 * **值只在这一层出现**：读取 → 合并 → 写入，全程不返回给调用方之外的任何地方。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns 当前键值；文件缺失时为空对象、不可读时 undefined。
 * @throws 不抛出异常。
 */
async function readEnvFileRaw(
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<Record<string, string> | undefined> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    const snapshot = await readFixedUtf8File(
      resolved.skillRoot,
      SKILL_ENV_FILE_NAME,
    )
    // 文件不存在时按空对象处理：补齐场景下「还没有 env.json」是合法的起点。
    if (!snapshot) return {}

    const parsed = parseEnvFileContent(snapshot.content)
    return parsed.data ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 读取用例的文档与脚本存在性（删除提案的对照用）。
 *
 * @param skillRoot - 已解析的用例目录。
 * @returns 文档与脚本是否存在。
 * @throws 不抛出异常。
 */
async function readDocumentAndScriptState(
  skillRoot: string,
): Promise<{ hasSkillDocument: boolean; hasPlaywrightScript: boolean }> {
  const [document, script] = await Promise.all([
    fileExists(join(skillRoot, 'SKILL.md')),
    fileExists(join(skillRoot, 'test.spec.ts')),
  ])
  return { hasSkillDocument: document, hasPlaywrightScript: script }
}

/**
 * 判断文件是否存在。
 *
 * @param path - 绝对路径。
 * @returns 存在且是文件时返回 true。
 * @throws 不抛出异常。
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises')
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

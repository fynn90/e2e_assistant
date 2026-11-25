/**
 * 编排 Playwright 脚本的完整生成流水线。
 *
 * 流水线（PRD 6.2 / v9 §8.2）：
 *   1. 版本与业务校验（用例、SKILL.md 结构与来源、已有脚本）
 *   2. 创建 temp/ 临时工作区（并清理上次遗留）
 *   3. 登记浏览器宿主 → Agent 页面核对并写入工作脚本
 *   4. 静态质量校验（对比前端「源」预期）
 *   5. 校验通过后经 SSE complete 回到前端，由前端触发写入正式文件
 *
 * `temp/` 是 **Agent 的工作区**——承载其在任务期间产生的全部中间内容（工作脚本、
 * 试运行与调试记录，以及页面探查截图 `temp/exploration/`），任务结束即整体清理，
 * 与正式产物之间**没有提升关系**（v9 §8.3）。正式 `test.spec.ts` 由前端的即时保存
 * 调用 `save-playwright-script` 写入；本服务自身不写正式文件。
 */

import {
  FileE2ETestCaseRepository,
  FilePlaywrightScriptRepository,
  FileSkillDocumentRepository,
  SkillManagerError,
  collectSkillDocumentDiagnostics,
  createTempWorkspace,
  ensureUserWorkSpace,
  resolveSkill,
  type ITempWorkspace,
} from '@charlie_deng/e2e-assistant-skill-manager'
import {
  PlaywrightScriptValidator,
  type IBrowserSessionFactory,
  type IPlaywrightValidationIssue,
} from '@charlie_deng/e2e-assistant-playwright-engine'
import {
  isBlockingDiagnostic,
  validateE2ETestCaseForGeneration,
  type IGeneratePlaywrightData,
  type IGeneratePlaywrightRequest,
} from '@charlie_deng/e2e-assistant-types'
import { ApiError } from '../../shared/errors/api-error'
import type { IAuthinePlatformConfig } from '../../config/config-store'
import {
  readEnvFileState,
  validateEnvReferencesForGeneration,
} from './env-readiness'
import { buildValidationFailureDigest } from './validation-error-digest'
import type {
  IPlaywrightScriptAgentGenerator,
  IRepairContext,
} from './playwright-script-generator'

/** 工作脚本在临时工作区中的固定文件名（Agent 需要一个真实可写路径才能产出内容）。 */
export const CANDIDATE_SCRIPT_FILE_NAME = 'candidate.spec.ts'

/**
 * 生成阶段进度：与页面状态对齐。
 *
 * 试运行与自动修复阶段在后续接入，届时在此枚举中追加。
 */
export type TPlaywrightGenerationStage =
  | 'preparing'
  | 'verifying-page'
  | 'generating-script'
  | 'validating-code'
  | 'completed'

/** 可替换的 Agent 生成器工厂，供应用层测试注入 fake 实现。 */
export type TPlaywrightGeneratorFactory = (
  config: IAuthinePlatformConfig,
) => IPlaywrightScriptAgentGenerator

/**
 * 生成 Playwright 脚本。
 *
 * @param input - 平台配置、Skill ID、版本条件、取消信号、进度回调与浏览器宿主登记钩子。
 * @param generatorFactory - 可替换的 Agent 生成器工厂。
 * @returns 已通过静态校验的脚本、警告、假设、环境变量与步骤覆盖。
 * @throws SkillManagerError 用例、SKILL.md 结构或来源、版本不满足条件时抛出。
 * @throws ApiError 脚本未通过静态校验或环境变量不一致时抛出。
 */
export async function generatePlaywrightScript (
  input: {
    config: IAuthinePlatformConfig
    skillId: string
    request: IGeneratePlaywrightRequest
    signal: AbortSignal
    /**
     * 修复上下文（v17 G2a）：提供时本次生成按「修复」语义执行
     *（prompt 会带上失败报告摘要与修复要求）。
     */
    repairContext?: IRepairContext
    onProgress?: (stage: TPlaywrightGenerationStage) => void
    /**
     * 在 Agent 开始工作前登记浏览器宿主：由基础设施层把已启动的浏览器会话
     * 与该生成会话关联，使 Agent 获得页面核对工具（依赖倒转，见 v7-technical-design 3）。
     */
    registerBrowserHost?: (context: {
      sessionId: string
      headed: boolean
      baseUrl: string
      signal: AbortSignal
      /**
       * 当前 Skill 目录与 ID（v12-pre）。
       *
       * 提供时 Agent 的页面截图会归档到该目录并可在界面展示；
       * 由本函数解析 Skill 后传入，避免基础设施层重复解析。
       */
      skillRoot?: string
      skillId?: string
    }) => Promise<void>
    /** 本次生成的 Agent 会话 ID：由路由生成并已在 SSE start 事件下发给前端。 */
    sessionId: string
  },
  generatorFactory: TPlaywrightGeneratorFactory,
): Promise<IGeneratePlaywrightData> {
  const rootDir = input.config.projectDirectory
  const testCaseRepository = new FileE2ETestCaseRepository({ rootDir })
  const scriptRepository = new FilePlaywrightScriptRepository({ rootDir })
  const skillDocumentRepository = new FileSkillDocumentRepository({ rootDir })

  input.onProgress?.('preparing')

  // 1. 用例版本与生成条件校验：任何失败都不得开始页面访问（PRD 8.3）。
  const document = await testCaseRepository.findBySkillId(input.skillId)

  if (document.version !== input.request.expectedTestCaseFileVersion) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      'E2E 用例已修改，请刷新后重新生成。',
    )
  }

  const generationIssues = validateE2ETestCaseForGeneration(document.testCase)

  if (generationIssues.length > 0) {
    throw new SkillManagerError(
      'E2E_SCHEMA_INVALID',
      generationIssues[0]?.message ?? 'E2E 用例尚未满足生成条件。',
      generationIssues,
    )
  }

  // v10：env 引用就绪校验（J1–J3）——用例引用的 env key 必须能被 env.json 承载，
  // 否则生成出的脚本在执行时将取不到值。校验失败不启动 Agent（PRD 6.3）。
  const envFileState = await readEnvFileState({ rootDir }, input.skillId)
  const envIssues = validateEnvReferencesForGeneration(
    document.testCase,
    envFileState,
  )

  if (envIssues.length > 0) {
    throw new ApiError({
      code: envIssues[0]?.code ?? 'ENV_REFERENCE_MISSING',
      status: 422,
      message: envIssues[0]?.message ?? '用例引用的 env key 未就绪。',
      cause: envIssues,
    })
  }

  // SKILL.md 必须已生成且基于当前用例：它是脚本生成的权威文本输入（PRD 8.1 / 8.3）。
  // 先看状态（含来源哈希），再读正文；未确认的文档不会带有 generatedSkill 元数据。
  const skillDocumentState = await skillDocumentRepository.getState(
    input.skillId,
    document.sourceHash,
  )

  if (!skillDocumentState.exists) {
    throw new SkillManagerError(
      'SKILL_DOCUMENT_INVALID',
      '当前 Skill 尚未生成 SKILL.md，请先完成 SKILL.md 生成。',
    )
  }

  if (skillDocumentState.sourceHash !== document.sourceHash) {
    throw new SkillManagerError(
      'SOURCE_HASH_CONFLICT',
      'SKILL.md 未基于当前用例，请重新生成 SKILL.md 后再生成脚本。',
    )
  }

  const skillDocument = await skillDocumentRepository.findBySkillId(
    input.skillId,
  )

  if (!skillDocument) {
    throw new SkillManagerError(
      'SKILL_DOCUMENT_INVALID',
      '当前 Skill 尚未生成 SKILL.md，请先完成 SKILL.md 生成。',
    )
  }

  // SKILL.md 是脚本生成的权威文本输入。v9 的 edit 模式允许用户保存结构不完整的
  // 中间态，因此必须在生成入口重新把关，避免把不完整文档喂给 Agent（PRD 8.1）。
  // 这是放开用户编辑的必要安全网。
  //
  // v15：这一处**保留阻断，且判据与写入门禁相反**——不是「只有安全族才拦」，
  // 而是「只要文档有缺陷就拦」。原因是两条链路的关注点不同：
  //   - 写入门禁关心的是「落盘会不会造成不可回收的损害」→ 只有安全族拦；
  //   - 就绪门槛关心的是「下游拿到的输入是否完整」→ 任何缺陷都让脚本 Agent 偏题。
  // SKILL.md 的每一条检查（frontmatter / 章节 / 目标地址 / 步骤覆盖 / 明文凭据）
  // 都意味着这份文档缺失了脚本生成所需的业务信息，故此处不区分族别。
  const skillDocumentValidation = collectSkillDocumentDiagnostics(
    skillDocument.content,
    document.testCase,
  )
  const documentIssue = skillDocumentValidation.diagnostics[0]

  if (documentIssue) {
    throw new SkillManagerError('SKILL_DOCUMENT_INVALID', documentIssue.message)
  }

  // 已有正式脚本只作为重新生成的参考，生成阶段绝不覆盖（PRD 4.1）。
  const existingScript = await scriptRepository.findBySkillId(input.skillId)
  assertExpectedScriptVersion(
    existingScript?.version ?? null,
    input.request.expectedScriptVersion,
  )

  // Skill 目录由 Skill Manager 统一解析，应用层不自行拼接路径（PRD 4.4 写入边界）。
  const resolvedSkill = await resolveSkill({ rootDir }, input.skillId)

  // v14（W11）：生成链路前置 precheck——userWorkSpace 被占用或创建失败时生成任务
  // 直接失败并携带明确错误码，不进入页面访问。
  // v15：仅「不可用」致命；目录存在但不可写（ready-degraded）不再拦下生成——
  // 生成本身不写 userWorkSpace，不可写要到执行期才成为问题（见 isFatalForMode）。
  await ensureUserWorkSpace({ rootDir }, input.skillId, 'generation')

  const tempWorkspace = await createTempWorkspace({
    skillRoot: resolvedSkill.skillRoot,
  })

  try {
    // 提问能力（ask_user_question）由 agent-work 运行时在会话创建时统一登记，
    // 应用层不再参与：任何跑在工作运行时上的会话都自动获得该工具。

    // 2. 页面核对前置：登记浏览器宿主，让 Agent 获得 browser_* 工具（PRD 9.2）。
    input.onProgress?.('verifying-page')
    await input.registerBrowserHost?.({
      sessionId: input.sessionId,
      // browserVisualization 决定有头 / 无头（PRD 8.2）；缺失按 false 处理。
      headed: document.testCase.browserVisualization === true,
      baseUrl: document.testCase.baseUrl,
      signal: input.signal,
      // Skill 目录已在上方解析：直接复用，让截图归档落在当前 Skill 的探查目录下。
      skillRoot: resolvedSkill.skillRoot,
      skillId: input.skillId,
    })

    // 3. Agent 核对页面并写入临时候选脚本。
    input.onProgress?.('generating-script')
    const generator = generatorFactory(input.config)
    const candidateFile = `${tempWorkspace.directory}/${CANDIDATE_SCRIPT_FILE_NAME}`
    const candidate = await generator.generate(
      {
        testCase: document.testCase,
        skillDocumentContent: skillDocument.content,
        targetFile: candidateFile,
        sessionId: input.sessionId,
        // v11 A1：守卫范围收紧为当前 Skill 目录（此前为整个平台工作区）。
        workspaceRoot: resolvedSkill.skillRoot,
        ...(existingScript ? { previousCode: existingScript.content } : {}),
        // v17 G2：修复上下文直通生成器（prompt 会带上失败摘要与修复要求）。
        ...(input.repairContext ? { repairContext: input.repairContext } : {}),
      },
      {
        signal: input.signal,
        onProgress: (stage) =>
          input.onProgress?.(
            stage === 'writing-script' ? 'generating-script' : 'preparing',
          ),
      },
    )

    // 4. 静态校验：v15 起内容质量问题不再终止生成，转为警告随结果下发；
    // 只有安全族问题（禁止 API / 越界写盘 / 语法不可解析等）仍拦下本次生成。
    input.onProgress?.('validating-code')
    const validation = new PlaywrightScriptValidator().validate(
      candidate.code,
      {
        testCase: document.testCase,
      },
    )

    if (validation.errors.some(isBlockingDiagnostic)) {
      // 只透传 errors[0].message 会让用户看到一句无位置、无类别的校验器原文，
      // 无从判断该改哪里；这里组织成带位置与类别的摘要（校验判定本身不变）。
      const digest = buildValidationFailureDigest(validation.errors)
      throw new ApiError({
        code: 'PLAYWRIGHT_SCRIPT_INVALID',
        status: 400,
        message: digest.message,
        cause: validation.errors,
      })
    }

    input.onProgress?.('completed')
    return {
      code: validation.code,
      warnings: [
        ...candidate.warnings,
        // 质量族问题与生成期警告合并下发：两者对用户的含义相同（需要留意但
        // 不阻断），分开呈现只会让卡片多出一块语义重复的区域。
        ...validation.errors.map(toGenerationWarning),
        ...validation.warnings.map(toGenerationWarning),
      ],
      assumptions: candidate.assumptions,
      environmentVariables: validation.environmentVariables,
      stepCoverage: validation.stepCoverage,
      sourceHash: document.sourceHash,
      testCaseVersion: document.version,
      scriptVersion: existingScript?.version ?? null,
    }
  } finally {
    // 5. 无论成功、失败或取消，任务结束都要清理 temp/（PRD 4.4 / AC-05）。
    // 其中包含页面探查截图（temp/exploration/）——任务结束后截图即失效，
    // 这是既定行为：截图的价值在生成过程中判断 Agent 核对质量，不在生成之后。
    // 清理失败必须向上抛出，不得伪报任务成功。
    await cleanupTempWorkspaceSafely(tempWorkspace)
  }
}

/**
 * 把一条校验问题转为下发给前端的生成警告。
 *
 * @param issue - 校验器产出的问题（error 或 warning 级）。
 * @returns 生成警告形状；`stepId` 仅在存在时携带。
 */
function toGenerationWarning (issue: IPlaywrightValidationIssue): {
  code: string
  message: string
  severity: 'warning'
  stepId?: string
} {
  return {
    code: issue.code,
    message: issue.message,
    severity: 'warning',
    ...(issue.stepId ? { stepId: issue.stepId } : {}),
  }
}

/**
 * 清理临时工作区，并在清理失败时保留原始错误语义。
 *
 * @param tempWorkspace - 已创建的临时工作区。
 * @returns 清理完成。
 * @throws SkillManagerError 清理失败时抛出（PRD 4.4：清理失败不得伪报成功）。
 */
async function cleanupTempWorkspaceSafely (
  tempWorkspace: ITempWorkspace,
): Promise<void> {
  await tempWorkspace.cleanup()
}

/** 校验磁盘中的正式脚本版本仍与前端预览时一致，避免覆盖外部修改。 */
function assertExpectedScriptVersion (
  currentVersion: string | null,
  expectedVersion: string | null,
): void {
  if (currentVersion !== expectedVersion) {
    throw new SkillManagerError(
      'FILE_VERSION_CONFLICT',
      'Playwright 脚本已在外部修改，请刷新后重试。',
    )
  }
}

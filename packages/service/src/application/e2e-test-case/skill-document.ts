/**
 * 编排 Agent 写入 SKILL.md、产物校验与生成结果返回。
 *
 * 保存（落盘与元数据提交）已拆分到 `save-skill-document.ts`：
 * 生成入口只负责让 Agent 产出文档并校验，写入由保存服务按 mode 统一处理。
 */
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
  SkillManagerError,
  acquireSkillLock,
  readFixedUtf8File,
  resolveSkill,
  restoreFixedUtf8File,
  collectSkillDocumentDiagnostics,
} from '@fynn90-e2e_assistant/skill-manager'
import type {
  IGenerateSkillDocumentRequest,
  ISkillDocumentGenerationResult,
} from '@fynn90-e2e_assistant/types'
import {
  isBlockingDiagnostic,
  validateE2ETestCaseForGeneration,
} from '@fynn90-e2e_assistant/types'
import { ApiError } from '../../shared/errors/api-error'
import type { IAuthinePlatformConfig } from '../../config/config-store'
import {
  readEnvFileState,
  validateEnvReferencesForGeneration,
} from './env-readiness'
import type { ISkillMarkdownGenerator } from './skill-markdown-generator'

/** 可替换的 Agent 生成器工厂，供应用层测试注入 fake 实现。 */
export type TSkillMarkdownGeneratorFactory = (
  config: IAuthinePlatformConfig,
) => ISkillMarkdownGenerator

/**
 * 根据当前结构化用例调用 Agent 生成并写入 SKILL.md，再返回已校验结果。
 *
 * @param input - 平台配置、Skill ID、会话 ID、版本条件、取消信号和进度回调。
 * @param generatorFactory - 可替换的 Agent 生成器工厂。
 * @returns 读取自 Agent 目标文件且通过正文校验的 SKILL.md 结果。
 * @throws SkillManagerError 当用例、版本、目标文件或产物不满足条件时抛出。
 */
export async function generateSkillDocument (
  input: {
    config: IAuthinePlatformConfig
    skillId: string
    /** 本次生成对应的 Agent 会话 ID：由路由生成并已在 SSE start 事件下发给前端。 */
    sessionId: string
    request: IGenerateSkillDocumentRequest
    signal: AbortSignal
    onProgress?: (
      stage:
        | 'requesting-model'
        | 'writing-skill'
        | 'repairing-output'
        | 'validating-output'
        | 'completed',
    ) => void
  },
  generatorFactory: TSkillMarkdownGeneratorFactory,
): Promise<ISkillDocumentGenerationResult> {
  const rootDir = input.config.projectDirectory
  const testCaseRepository = new FileE2ETestCaseRepository({ rootDir })
  const skillDocumentRepository = new FileSkillDocumentRepository({ rootDir })
  const releaseSkillLock = await acquireSkillLock({ rootDir }, input.skillId)

  try {
    const resolvedSkill = await resolveSkill({ rootDir }, input.skillId)
    const document = await testCaseRepository.findBySkillId(input.skillId)

    if (document.version !== input.request.expectedTestCaseFileVersion) {
      throw new SkillManagerError(
        'FILE_VERSION_CONFLICT',
        'E2E 用例已修改，请刷新后重新生成 SKILL.md。',
      )
    }

    const generationIssues = validateE2ETestCaseForGeneration(document.testCase)
    if (generationIssues.length > 0) {
      throw new SkillManagerError(
        'E2E_SCHEMA_INVALID',
        generationIssues[0]?.message ?? 'E2E 用例尚未满足 SKILL.md 生成条件。',
        generationIssues,
      )
    }

    // v10：env 引用就绪校验（J1–J3）——用例引用的 env key 必须能被 env.json 承载，
    // SKILL.md 中的引用才与脚本生成链路一致。校验失败不启动 Agent（PRD 6.3）。
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

    const currentSkillDocument = await skillDocumentRepository.findBySkillId(
      input.skillId,
    )

    // 版本守卫只在**文件存在**时生效（v13）。
    //
    // 它存在的意义是乐观并发：防止本次生成覆盖掉「别处对现有 SKILL.md 的修改」。
    // 文件不存在时没有任何东西会被覆盖，用户的意图就是**新建**——此时把
    // 「前端期望版本(旧版本号) ≠ 磁盘实际(不存在)」判成「已在外部修改」是错误归因，
    // 会让「删除后重新生成」永远失败。文件缺失的语义是新建，不是冲突。
    if (currentSkillDocument) {
      if (
        currentSkillDocument.version !==
        input.request.expectedSkillDocumentVersion
      ) {
        throw new SkillManagerError(
          'FILE_VERSION_CONFLICT',
          'SKILL.md 已在外部修改，请刷新后重新生成。',
        )
      }
    }

    const generator = generatorFactory(input.config)
    const previousSnapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      'SKILL.md',
    )
    let generatedVersion: string | undefined
    try {
      const candidate = await generator.generate(
        {
          testCase: document.testCase,
          targetDirectory: resolvedSkill.skillRoot,
          sessionId: input.sessionId,
          ...(currentSkillDocument
            ? { previousContent: currentSkillDocument.content }
            : {}),
        },
        {
          signal: input.signal,
          onProgress: (stage) => input.onProgress?.(stage),
        },
      )

      // 生产生成器必须声明 Agent 已写文件；生成结果以磁盘固定文件为准。
      const generatedDocument = await skillDocumentRepository.findBySkillId(
        input.skillId,
      )
      generatedVersion = generatedDocument?.version
      if (!generatedDocument) {
        throw new SkillManagerError(
          'SKILL_DOCUMENT_INVALID',
          'Agent 未将 SKILL.md 写入指定 Skill 目录。',
        )
      }
      if (
        normalizeForComparison(generatedDocument.content) !==
        normalizeForComparison(candidate.content)
      ) {
        throw new SkillManagerError(
          'SKILL_DOCUMENT_INVALID',
          'Agent 返回的 SKILL.md 与目标文件内容不一致。',
        )
      }

      input.onProgress?.('validating-output')
      const validation = collectSkillDocumentDiagnostics(
        generatedDocument.content,
        document.testCase,
      )

      // v15：内容质量问题不再阻断生成，转为警告随结果下发，由界面提醒用户；
      // 只有安全族诊断（明文凭据）仍拦下本次生成。
      const blocking = validation.diagnostics.filter(isBlockingDiagnostic)

      if (blocking.length > 0) {
        throw new SkillManagerError(
          'SKILL_DOCUMENT_INVALID',
          blocking[0]?.message ?? 'SKILL.md 未通过校验。',
        )
      }

      input.onProgress?.('completed')
      return {
        content: validation.content,
        warnings: [
          ...candidate.warnings,
          ...validation.diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: 'warning' as const,
          })),
        ],
        assumptions: candidate.assumptions,
        environmentVariables: validation.environmentVariables,
        sourceHash: document.sourceHash,
        testCaseVersion: document.version,
        // Agent 已写入的版本是确认保存时的乐观并发版本。
        skillDocumentVersion: generatedDocument.version,
      }
    } catch (error) {
      await restoreGeneratedDocument(
        resolvedSkill.skillRoot,
        previousSnapshot,
        generatedVersion,
      )
      throw error
    }
  } finally {
    await releaseSkillLock()
  }
}

/**
 * 仅恢复本次 Agent 已实际变更的文档，避免错误分支覆盖外部修改。
 *
 * @param skillRoot - 已由 Skill Manager 解析的 Skill 目录。
 * @param previousSnapshot - Agent 运行前的文件快照；null 表示原文件不存在。
 * @param generatedVersion - 本次 Agent 写入后的文件版本。
 * @returns 恢复完成后兑现的 Promise。
 * @throws 当读取或恢复文件失败时抛出，但调用方应优先保留原始生成错误。
 */
async function restoreGeneratedDocument (
  skillRoot: string,
  previousSnapshot: Awaited<ReturnType<typeof readFixedUtf8File>>,
  generatedVersion: string | undefined,
): Promise<void> {
  const currentSnapshot = await readFixedUtf8File(skillRoot, 'SKILL.md')
  if (!currentSnapshot) return
  if (generatedVersion && currentSnapshot.version !== generatedVersion) return
  if (
    !previousSnapshot ||
    currentSnapshot.version !== previousSnapshot.version
  ) {
    await restoreFixedUtf8File(
      skillRoot,
      'SKILL.md',
      previousSnapshot,
      currentSnapshot.version,
    )
  }
}

/** 将换行归一化，便于校验 Agent 写入内容与返回内容的一致性。 */
function normalizeForComparison (content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
}

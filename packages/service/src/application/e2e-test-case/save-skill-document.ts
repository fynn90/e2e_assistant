/**
 * 保存 SKILL.md：校验后统一走仓储的 `save()` 语义写入正文与元数据。
 *
 * v9 起不再有「候选 / 确认」两态——生成完成即落盘，用户编辑实时落盘，
 * 两者走**同一条写入路径**。v15 起两者的**校验语义也完全一致**：
 *
 *   - 内容质量问题（章节缺失、frontmatter 不一致、步骤未覆盖）**不再阻断写入**，
 *     只作为诊断随响应回传，由界面提醒用户；
 *   - 只有安全族诊断（明文凭据）仍阻断——真实凭据一旦落盘无法回收；
 *   - 来源哈希在两种模式下都必须校验：SKILL.md 是脚本生成的权威文本输入，
 *     若它不是当前用例的派生物，脚本生成阶段会以陈旧文档为依据。
 */
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
  SkillManagerError,
  collectSkillDocumentDiagnostics,
} from '@charlie_deng/e2e-assistant-skill-manager'
import { isBlockingDiagnostic } from '@charlie_deng/e2e-assistant-types'
import type {
  ISaveSkillDocumentData,
  ISaveSkillDocumentRequest,
} from '@charlie_deng/e2e-assistant-types'

/**
 * 保存 SKILL.md 正文并提交 manifest.generatedSkill 元数据。
 *
 * @param input - Skill 根目录、Skill ID 与保存请求（含 mode）。
 * @returns 写入后的文件版本、元数据与校验诊断。
 * @throws SkillManagerError 当来源哈希不一致、generation 模式校验失败或写入冲突时抛出。
 */
export async function saveSkillDocument (input: {
  rootDir: string
  skillId: string
  request: ISaveSkillDocumentRequest
}): Promise<ISaveSkillDocumentData> {
  const testCaseRepository = new FileE2ETestCaseRepository({
    rootDir: input.rootDir,
  })
  const document = await testCaseRepository.findBySkillId(input.skillId)

  // 来源校验（两种模式都必需）：非当前用例派生的文档不得写入元数据。
  if (document.sourceHash !== input.request.sourceHash) {
    throw new SkillManagerError(
      'SOURCE_HASH_CONFLICT',
      'E2E 用例已发生变化，请重新生成 SKILL.md。',
    )
  }

  const validation = collectSkillDocumentDiagnostics(
    input.request.content,
    document.testCase,
  )
  const blocking = validation.diagnostics.filter(isBlockingDiagnostic)

  if (blocking.length > 0) {
    throw new SkillManagerError(
      'SKILL_DOCUMENT_INVALID',
      blocking[0]?.message ?? 'SKILL.md 未通过校验。',
    )
  }

  return new FileSkillDocumentRepository({ rootDir: input.rootDir }).save(
    input.skillId,
    validation.content,
    input.request.sourceHash,
    input.request.expectedSkillDocumentVersion,
    validation.diagnostics,
  )
}

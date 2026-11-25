/**
 * 读取 E2E 用例、文件版本、sourceHash、脚本状态和 SKILL.md 状态。
 */
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
} from '@charlie_deng/e2e-assistant-skill-manager'
import type { IE2ETestCaseDocumentData } from '@charlie_deng/e2e-assistant-types'

/**
 * 读取前端结构化编辑器需要的完整文档状态。
 *
 * @param input - Skill 根目录和 ID。
 * @returns 结构化用例、来源版本以及脚本和 SKILL.md 状态。
 * @throws SkillManagerError 当 Skill 或固定业务文件损坏时抛出。
 */
export async function getE2ETestCase (input: {
  rootDir: string
  skillId: string
}): Promise<IE2ETestCaseDocumentData> {
  const document = await new FileE2ETestCaseRepository({
    rootDir: input.rootDir,
  }).findBySkillId(input.skillId)
  const skillDocument = await new FileSkillDocumentRepository({
    rootDir: input.rootDir,
  }).getState(input.skillId, document.sourceHash)
  return {
    testCase: document.testCase,
    version: document.version,
    sourceHash: document.sourceHash,
    updatedAt: document.updatedAt,
    script: document.script,
    skillDocument,
  }
}

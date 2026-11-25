/**
 * 保存结构化 E2E 用例并返回新的投影、脚本状态和 SKILL.md 状态。
 */
import {
  FileE2ETestCaseRepository,
  FileSkillDocumentRepository,
} from '@fynn90-e2e_assistant/skill-manager'
import type {
  IUpdateE2ETestCaseData,
  IUpdateE2ETestCaseRequest,
} from '@fynn90-e2e_assistant/types'

/**
 * 保存结构化 E2E 用例。
 *
 * @param input - Skill 根目录、ID、用例草稿和期望文件版本。
 * @returns 服务端标准化后的用例、新版本、manifest 投影更新时间和文档状态。
 * @throws SkillManagerError 当校验失败或文件发生冲突时抛出。
 */
export async function updateE2ETestCase (input: {
  rootDir: string
  skillId: string
  request: IUpdateE2ETestCaseRequest
}): Promise<IUpdateE2ETestCaseData> {
  const result = await new FileE2ETestCaseRepository({
    rootDir: input.rootDir,
  }).save(input.skillId, input.request.testCase, input.request.expectedVersion)
  const skillDocument = await new FileSkillDocumentRepository({
    rootDir: input.rootDir,
  }).getState(input.skillId, result.sourceHash)
  return {
    testCase: result.testCase,
    version: result.version,
    sourceHash: result.sourceHash,
    script: result.script,
    skillDocument,
    title: result.title,
    description: result.description,
    updatedAt: result.updatedAt,
  }
}

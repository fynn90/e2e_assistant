/**
 * 定义 E2E 测试用例文件仓储接口和文档结果。
 */
import type { IE2ETestCase } from '@fynn90-e2e_assistant/types'
import type { IPlaywrightScriptState } from '@fynn90-e2e_assistant/types'

export interface IE2ETestCaseDocument {
  testCase: IE2ETestCase
  version: string
  sourceHash: string
  updatedAt: string
  script: IPlaywrightScriptState
}

export interface ISaveE2ETestCaseResult extends IE2ETestCaseDocument {
  title: string
  description: string
}

export interface IE2ETestCaseRepository {
  findBySkillId (skillId: string): Promise<IE2ETestCaseDocument>
  save (
    skillId: string,
    testCase: IE2ETestCase,
    expectedVersion: string,
  ): Promise<ISaveE2ETestCaseResult>
}

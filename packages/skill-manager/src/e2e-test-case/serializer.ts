/**
 * 提供 E2E 测试用例的确定性序列化和 canonical 对象生成。
 */
import { parseE2ETestCase, type IE2ETestCase } from '@charlie_deng/e2e-assistant-types'

/**
 * 按领域字段顺序标准化 E2E 用例，避免对象插入顺序影响 sourceHash。
 *
 * @param testCase - 已通过结构校验的 E2E 用例。
 * @returns 字段顺序稳定且字符串完成首尾空白标准化的领域对象。
 */
export function canonicalizeE2ETestCase (testCase: IE2ETestCase): IE2ETestCase {
  return parseE2ETestCase({
    ...(testCase.$schema ? { $schema: testCase.$schema } : {}),
    schemaVersion: testCase.schemaVersion,
    id: testCase.id,
    title: testCase.title.trim(),
    description: testCase.description.trim(),
    baseUrl: testCase.baseUrl.trim(),
    tags: testCase.tags.map((tag) => tag.trim()),
    preconditions: testCase.preconditions.map((precondition) => ({
      id: precondition.id,
      description: precondition.description.trim(),
    })),
    steps: testCase.steps.map((step, index) => ({
      id: step.id,
      order: index + 1,
      description: step.description.trim(),
      action: step.action.trim(),
      expectedResult: step.expectedResult.trim(),
      testData: Object.fromEntries(
        Object.entries(step.testData)
          .sort(([leftKey], [rightKey]) =>
            leftKey.trim().localeCompare(rightKey.trim()),
          )
          .map(([key, value]) => [key.trim(), value]),
      ),
      enabled: step.enabled,
    })),
    browserVisualization: testCase.browserVisualization,
  })
}

/**
 * 生成 sourceHash 专用的 canonical 对象：在通用 canonical 基础上剔除 browserVisualization。
 *
 * browserVisualization 是「运行 / 观察方式」提示而非业务语义（技术方案 5.1.1），
 * 切换它不应让已保存的 test.spec.ts 被判定为 stale。因此 sourceHash 只覆盖业务字段，
 * 需要完整内容（含该字段）时仍使用 canonicalizeE2ETestCase。
 *
 * @param testCase - 已通过结构校验的 E2E 测试用例。
 * @returns 不含 browserVisualization 的稳定领域对象，用于计算来源哈希。
 * @throws ZodError 当数据结构或 schemaVersion 不合法时抛出。
 */
export function canonicalizeE2ETestCaseForHash (
  testCase: IE2ETestCase,
): IE2ETestCase {
  const { browserVisualization: _browserVisualization, ...rest } =
    canonicalizeE2ETestCase(testCase)
  return rest as IE2ETestCase
}

/**
 * 将 E2E 测试用例序列化为统一的 UTF-8 JSON 文件内容。
 *
 * @param testCase - 待保存的 E2E 测试用例。
 * @returns 2 空格缩进并带尾换行的确定性 JSON 文本。
 */
export function serializeE2ETestCase (testCase: IE2ETestCase): string {
  return `${JSON.stringify(canonicalizeE2ETestCase(testCase), null, 2)}\n`
}

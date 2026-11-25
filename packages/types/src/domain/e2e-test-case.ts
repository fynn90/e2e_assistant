/**
 * 定义 E2E 测试用例的共享领域 Schema、推导类型和业务校验规则。
 * 结构 Schema 允许保存未完成草稿；生成就绪校验在调用模型前执行更严格的约束。
 */
import { z } from 'zod'
import { SENSITIVE_ROW_UNSELECTED_VALUE } from './env-reference'

export const E2E_SCHEMA_VERSION = '1.0' as const
export const E2E_SCHEMA_FILE_NAME = 'e2e_schema.json' as const
export const PLAYWRIGHT_SCRIPT_FILE_NAME = 'test.spec.ts' as const

const stableIdSchema = z
  .string()
  .trim()
  .min(1, 'ID 不能为空。')
  .max(128, 'ID 不能超过 128 个字符。')
  .regex(/^[a-zA-Z0-9_-]+$/, 'ID 只能包含字母、数字、下划线和中划线。')

export const e2ePreconditionSchema = z
  .object({
    id: stableIdSchema,
    description: z.string().max(500, '前置条件不能超过 500 个字符。'),
  })
  .strict()

export const e2eTestStepSchema = z
  .object({
    id: stableIdSchema,
    order: z.number().int().positive('步骤顺序必须是正整数。'),
    description: z.string().max(500, '步骤描述不能超过 500 个字符。'),
    action: z.string().max(2000, '操作动作不能超过 2000 个字符。'),
    expectedResult: z.string().max(2000, '预期结果不能超过 2000 个字符。'),
    testData: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict()

export const e2eTestCaseSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(E2E_SCHEMA_VERSION),
    id: stableIdSchema,
    title: z.string().max(100, '用例标题不能超过 100 个字符。'),
    description: z.string().max(1000, '用例描述不能超过 1000 个字符。'),
    baseUrl: z.string().max(2048, '目标 URL 不能超过 2048 个字符。'),
    tags: z
      .array(z.string().max(50, '单个标签不能超过 50 个字符。'))
      .max(20)
      .default([]),
    preconditions: z.array(e2ePreconditionSchema).max(50).default([]),
    steps: z.array(e2eTestStepSchema).max(200).default([]),
    /**
     * 浏览器运行模式开关（v7，PRD 8.2）。
     *
     * 只决定生成期页面核对是否打开用户可见的 Playwright 浏览器调试页面，
     * 不改变用例业务语义；历史用例缺少该字段时按 false（无头）处理。
     * 该字段不参与 sourceHash，切换它不应让已有脚本被判定为过期。
     *
     * 声明为 optional 而非 default：解析历史用例时不会强制调用方提供该字段，
     * 读取侧统一用 `=== true` 判定有头模式，因此 undefined 等价于 false。
     */
    browserVisualization: z.boolean().optional(),
  })
  .strict()

export type IE2EPrecondition = z.infer<typeof e2ePreconditionSchema>
export type IE2ETestStep = z.infer<typeof e2eTestStepSchema>
export type IE2ETestCase = z.infer<typeof e2eTestCaseSchema>

export interface IE2EValidationIssue {
  path: Array<string | number>
  message: string
}

/**
 * 解析并标准化未知的 E2E 用例数据。
 *
 * @param input - 从磁盘、API 或模型边界获得的未知数据。
 * @returns 经过结构 Schema 校验的 E2E 用例。
 * @throws ZodError 当数据结构或 schemaVersion 不合法时抛出。
 */
export function parseE2ETestCase(input: unknown): IE2ETestCase {
  return e2eTestCaseSchema.parse(input)
}

/**
 * 校验 E2E 草稿是否允许保存到磁盘。
 *
 * 保存阶段要求标题、描述和 Base URL 完整，允许 steps 暂时为空；已有前置条件与步骤必须完整，
 * 且所有稳定 ID、标签和步骤顺序都必须保持唯一与连续。
 * 敏感数据的引导不在此处：明文测试数据允许保存（PRD v10 6.1.2 W4 的非阻断软提醒
 * 由编辑器呈现，env key 引用的存在性由生成前就绪校验检查，保存不阻断）。
 *
 * @param testCase - 已通过结构 Schema 的 E2E 测试用例。
 * @returns 所有业务校验问题；空数组表示允许保存。
 */
export function validateE2ETestCaseForSave(
  testCase: IE2ETestCase,
): IE2EValidationIssue[] {
  const issues: IE2EValidationIssue[] = []

  if (!testCase.title.trim()) {
    issues.push({ path: ['title'], message: '用例标题不能为空。' })
  }

  if (!testCase.description.trim()) {
    issues.push({ path: ['description'], message: '用例描述不能为空。' })
  }

  if (!testCase.baseUrl.trim()) {
    issues.push({ path: ['baseUrl'], message: '目标 URL 不能为空。' })
  } else {
    validateBaseUrl(testCase.baseUrl, issues)
  }

  validateUniqueStrings(
    testCase.tags.map((tag: string) => tag.trim()),
    ['tags'],
    '标签不能为空。',
    '标签不能重复。',
    issues,
  )
  validateStableCollection<IE2EPrecondition>(
    testCase.preconditions,
    ['preconditions'],
    issues,
    (precondition, index) => {
      if (!precondition.description.trim()) {
        issues.push({
          path: ['preconditions', index, 'description'],
          message: '前置条件描述不能为空。',
        })
      }
    },
  )
  validateStableCollection<IE2ETestStep>(
    testCase.steps,
    ['steps'],
    issues,
    (step, index) => {
      if (!step.description.trim()) {
        issues.push({
          path: ['steps', index, 'description'],
          message: '步骤描述不能为空。',
        })
      }

      if (!step.action.trim()) {
        issues.push({
          path: ['steps', index, 'action'],
          message: '操作动作不能为空。',
        })
      }

      if (!step.expectedResult.trim()) {
        issues.push({
          path: ['steps', index, 'expectedResult'],
          message: '预期结果不能为空。',
        })
      }

      const testDataKeys = new Set<string>()

      for (const key of Object.keys(step.testData)) {
        const normalizedKey = key.trim()

        if (step.testData[key] === SENSITIVE_ROW_UNSELECTED_VALUE) {
          // v10 C5：行类型为「敏感数据」但尚未选择 key（值为暂存占位符，键名不限）时
          // 给出专用文案；该形态只在编辑中的草稿里存在，保存被阻断后不会落盘。
          issues.push({
            path: ['steps', index, 'testData', key],
            message: '敏感数据未选择 env.json 中的 key。',
          })
        } else if (!normalizedKey) {
          issues.push({
            path: ['steps', index, 'testData', key],
            message: '测试数据键不能为空。',
          })
        } else if (testDataKeys.has(normalizedKey)) {
          issues.push({
            path: ['steps', index, 'testData', key],
            message: '测试数据键不能重复。',
          })
        } else {
          testDataKeys.add(normalizedKey)
        }
      }
    },
  )
  validateContinuousStepOrder(testCase.steps, issues)

  return issues
}

/**
 * 校验 E2E 用例是否已经具备生成 Playwright 脚本的条件。
 *
 * 在保存校验的基础上要求至少有一个启用步骤。env key 引用的存在性
 * （PRD v10 7.3 J1–J3）需要读取 env.json，由生成入口的应用层校验负责，
 * 不在此纯函数内判定。
 *
 * @param testCase - 已通过结构 Schema 的 E2E 测试用例。
 * @returns 所有生成前业务校验问题；空数组表示可以调用模型。
 */
export function validateE2ETestCaseForGeneration(
  testCase: IE2ETestCase,
): IE2EValidationIssue[] {
  const issues = validateE2ETestCaseForSave(testCase)

  if (!testCase.steps.some((step: IE2ETestStep) => step.enabled)) {
    issues.push({
      path: ['steps'],
      message: '生成脚本前至少需要一个启用步骤。',
    })
  }

  return issues
}

/**
 * 创建新 Skill 对应的默认 E2E 草稿。
 *
 * @param input - Skill 身份、标题和描述。
 * @returns 可以立即持久化并由结构化编辑器加载的默认草稿。
 */
export function createDefaultE2ETestCase(input: {
  skillId: string
  title: string
  description: string
}): IE2ETestCase {
  return e2eTestCaseSchema.parse({
    $schema: './e2e_schema.schema.json',
    schemaVersion: E2E_SCHEMA_VERSION,
    id: `tc_${input.skillId}`,
    title: input.title,
    description: input.description,
    baseUrl: '',
    tags: [],
    preconditions: [],
    steps: [],
    // 新建用例默认使用无头模式，避免生成期弹出浏览器窗口（PRD 7.4）。
    browserVisualization: false,
  })
}

function validateBaseUrl(value: string, issues: IE2EValidationIssue[]): void {
  try {
    const url = new URL(value)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({
        path: ['baseUrl'],
        message: '目标 URL 只允许 HTTP 或 HTTPS。',
      })
    }

    if (url.username || url.password) {
      issues.push({
        path: ['baseUrl'],
        message: '目标 URL 不能包含用户名或密码。',
      })
    }
  } catch {
    issues.push({ path: ['baseUrl'], message: '目标 URL 格式不正确。' })
  }
}

function validateUniqueStrings(
  values: string[],
  path: Array<string | number>,
  emptyMessage: string,
  duplicateMessage: string,
  issues: IE2EValidationIssue[],
): void {
  const seen = new Set<string>()

  values.forEach((value, index) => {
    if (!value) {
      issues.push({ path: [...path, index], message: emptyMessage })
      return
    }

    if (seen.has(value)) {
      issues.push({ path: [...path, index], message: duplicateMessage })
      return
    }

    seen.add(value)
  })
}

function validateStableCollection<TItem extends { id: string }>(
  items: TItem[],
  path: Array<string | number>,
  issues: IE2EValidationIssue[],
  validateItem: (item: TItem, index: number) => void,
): void {
  const ids = new Set<string>()

  items.forEach((item, index) => {
    if (ids.has(item.id)) {
      issues.push({ path: [...path, index, 'id'], message: 'ID 不能重复。' })
    } else {
      ids.add(item.id)
    }

    validateItem(item, index)
  })
}

function validateContinuousStepOrder(
  steps: IE2ETestStep[],
  issues: IE2EValidationIssue[],
): void {
  const orderCounts = new Map<number, number>()

  for (const step of steps) {
    orderCounts.set(step.order, (orderCounts.get(step.order) ?? 0) + 1)
  }

  steps.forEach((step, index) => {
    const expectedOrder = index + 1

    if ((orderCounts.get(step.order) ?? 0) > 1) {
      issues.push({
        path: ['steps', index, 'order'],
        message: '步骤顺序不能重复。',
      })
    } else if (step.order !== expectedOrder) {
      issues.push({
        path: ['steps', index, 'order'],
        message: `步骤顺序必须连续，当前位置应为 ${expectedOrder}。`,
      })
    }
  })
}

function deduplicateIssues(
  issues: IE2EValidationIssue[],
): IE2EValidationIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.path.join('.')}:${issue.message}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

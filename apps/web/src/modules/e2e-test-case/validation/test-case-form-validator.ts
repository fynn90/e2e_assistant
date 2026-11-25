/**
 * 将共享 E2E 领域校验结果适配为字段错误、就绪摘要和可聚焦控件目标。
 */
import {
  SKILL_ENV_FILE_NAME,
  validateE2ETestCaseForGeneration,
  validateE2ETestCaseForSave,
  type IE2ETestCase,
  type IE2EValidationIssue,
} from '@authine-e2e-agent/types'

export type TFieldErrorMap = Record<string, string>

export interface IE2EValidationSummary {
  key: string
  path: string
  message: string
  label: string
  targetId: string
}

/**
 * 获取允许保存草稿前必须解决的有序领域问题。
 * @param testCase 待校验的结构化 E2E 用例。
 * @returns 保留领域校验顺序和重复字段问题的数组。
 * @throws 不抛出异常。
 */
export function getDraftSaveIssues(
  testCase: IE2ETestCase,
): IE2EValidationIssue[] {
  return validateE2ETestCaseForSave(testCase)
}

/**
 * 获取生成 Playwright 脚本前必须解决的有序领域问题。
 * @param testCase 待校验的结构化 E2E 用例。
 * @returns 包含保存约束和至少一个启用步骤约束的问题数组。
 * @throws 不抛出异常。
 */
export function getDraftGenerationIssues(
  testCase: IE2ETestCase,
): IE2EValidationIssue[] {
  return validateE2ETestCaseForGeneration(testCase)
}

/**
 * 将保存阶段领域问题转换为字段路径映射。
 * @param testCase 待校验的结构化 E2E 用例。
 * @returns 每个字段路径对应的首个可见错误。
 * @throws 不抛出异常。
 */
export function validateDraftForSave(testCase: IE2ETestCase): TFieldErrorMap {
  return issuesToFieldErrors(getDraftSaveIssues(testCase))
}

/**
 * 将生成阶段领域问题转换为字段路径映射。
 * @param testCase 待校验的结构化 E2E 用例。
 * @returns 每个字段路径对应的首个可见错误。
 * @throws 不抛出异常。
 */
export function validateDraftForGeneration(
  testCase: IE2ETestCase,
): TFieldErrorMap {
  return issuesToFieldErrors(getDraftGenerationIssues(testCase))
}

/**
 * 获取字段自身或其第一个后代字段的错误。
 * @param errors 字段路径到错误文案的映射。
 * @param path 目标字段路径。
 * @returns 找到的错误文案；不存在时返回 undefined。
 * @throws 不抛出异常。
 */
export function fieldErrorFor(
  errors: TFieldErrorMap,
  path: string,
): string | undefined {
  return (
    errors[path] ??
    Object.entries(errors).find(([key]) => key.startsWith(`${path}.`))?.[1]
  )
}

/**
 * 获取指定字段路径下去重后的所有错误文案。
 * @param errors 字段路径到错误文案的映射。
 * @param prefix 目标字段路径前缀。
 * @returns 保持字段映射顺序的错误文案数组。
 * @throws 不抛出异常。
 */
export function fieldErrorsForPrefix(
  errors: TFieldErrorMap,
  prefix: string,
): string[] {
  return [
    ...new Set(
      Object.entries(errors)
        .filter(([key]) => key === prefix || key.startsWith(`${prefix}.`))
        .map(([, message]) => message),
    ),
  ]
}

/**
 * 将领域问题转换为供行内表单使用的字段错误映射。
 * @param issues 有序领域校验问题。
 * @returns 每个字段路径对应的首个错误文案。
 * @throws 不抛出异常。
 */
export function issuesToFieldErrors(
  issues: IE2EValidationIssue[],
): TFieldErrorMap {
  const errors: TFieldErrorMap = {}

  for (const issue of issues) {
    const path = issue.path.join('.')
    errors[path] ??= issue.message
  }

  return errors
}

/**
 * 将领域问题转换为用户可理解且可跳转的摘要项。
 * @param issues 有序领域校验问题。
 * @returns 包含字段名称和稳定 DOM 目标的摘要数组。
 * @throws 不抛出异常。
 */
export function issuesToValidationSummaries(
  issues: IE2EValidationIssue[],
): IE2EValidationSummary[] {
  return issues.map((issue, index) => {
    const path = issue.path.join('.')
    const presentation = validationPathPresentation(issue.path)

    return {
      key: `${path}:${issue.message}:${index}`,
      path,
      message: issue.message,
      label: presentation.label,
      targetId: presentation.targetId,
    }
  })
}

/**
 * 将字段路径映射为界面字段名称和稳定控件 ID。
 * @param path 领域校验问题路径。
 * @returns 可供摘要展示和聚焦的字段信息。
 * @throws 不抛出异常。
 */
function validationPathPresentation(path: Array<string | number>): {
  label: string
  targetId: string
} {
  const [section, itemIndex, field] = path

  // v10：env.json 就绪问题（J2）——摘要呈现为可点击链接，
  // 点击由编辑器的导航处理器路由到 code 面板的 env.json。
  if (section === SKILL_ENV_FILE_NAME) {
    return { label: 'env.json', targetId: `${SKILL_ENV_FILE_NAME}-issue` }
  }

  if (section === 'title') return { label: '用例标题', targetId: 'e2e-title' }
  if (section === 'description')
    return { label: '用例描述', targetId: 'e2e-description' }
  if (section === 'baseUrl')
    return { label: '目标 URL', targetId: 'e2e-base-url' }
  if (section === 'tags') return { label: '标签', targetId: 'e2e-tags-trigger' }

  if (section === 'preconditions' && typeof itemIndex === 'number') {
    return {
      label: `前置条件 ${itemIndex + 1}`,
      targetId: `e2e-precondition-${itemIndex}-description`,
    }
  }

  if (section === 'steps' && typeof itemIndex === 'number') {
    const fieldLabels: Record<string, string> = {
      description: '步骤描述',
      action: '操作动作',
      expectedResult: '预期结果',
      testData: '测试数据',
      enabled: '启用状态',
      order: '步骤顺序',
      id: '步骤标识',
    }
    const fieldName = typeof field === 'string' ? field : ''
    const targetField = ['description', 'action', 'expectedResult'].includes(
      fieldName,
    )
      ? fieldName
      : fieldName === 'testData'
        ? 'test-data'
        : 'header'

    return {
      label: `步骤 ${itemIndex + 1} · ${fieldLabels[fieldName] ?? '步骤内容'}`,
      targetId: `e2e-step-${itemIndex}-${targetField}`,
    }
  }

  return { label: '测试步骤', targetId: 'e2e-steps-section' }
}

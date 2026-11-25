/**
 * 把静态校验的错误清单组织成**可定位**的失败提示。
 *
 * 背景：生成失败时此前只把 `errors[0].message` 透传给前端，用户看到的是一句
 * 校验器原文（如 `Parameter 'message' implicitly has an 'any' type.`）——
 * 不知道是**哪一行**、属于**哪一类**问题、也看不到**还有没有别的问题**。
 * 而校验器其实已经给出了行号、列号与步骤 id，只是没被用上。
 *
 * 本模块只做**组织与呈现**，不改变任何校验判定：判断哪些问题算 error 仍是校验器的职责。
 */
import type { IPlaywrightValidationIssue } from '@fynn90-e2e_assistant/playwright-engine'

/** 单条错误的呈现上限：超出后只给数量，避免提示卡片被刷屏。 */
const MAX_LISTED_ERRORS = 3

/**
 * 错误码 → 可读的问题类别与修复方向。
 *
 * 键是校验器产出的稳定错误码；值为类别名与「该怎么修」的一句提示。
 * 未登记的码走兜底分支，只展示原文——**不猜测**未知错误码的含义。
 */
const ERROR_GUIDANCE: Record<string, { label: string; hint: string }> = {
  TYPESCRIPT_SEMANTIC_ERROR: {
    label: '类型检查未通过',
    hint: '按提示补全类型标注（自行声明的函数与回调参数需写 `: any`）。',
  },
  TYPESCRIPT_SYNTAX_ERROR: {
    label: '语法错误',
    hint: '检查括号、引号与模板字符串是否闭合。',
  },
  STEP_NOT_COVERED: {
    label: '步骤未覆盖',
    hint: "每个启用步骤都要有且只有一个 `test.step('<步骤 id>')`。",
  },
  STEP_DUPLICATED: { label: '步骤重复', hint: '同一步骤 id 只能出现一次。' },
  UNKNOWN_STEP_ID: {
    label: '步骤 id 不存在',
    hint: '`test.step()` 的第一个参数必须是用例中的步骤 id，不是描述文字。',
  },
  STEP_ID_LITERAL_REQUIRED: {
    label: '步骤 id 必须是字面量',
    hint: '步骤 id 不能拼接或存在变量里，需直接写字面量。',
  },
  STEP_OPERATION_REQUIRED: {
    label: '步骤缺少操作',
    hint: '步骤内至少要有一个 Playwright 操作，且必须直接写在 `test.step` 体内。',
  },
  STEP_ASSERTION_REQUIRED: {
    label: '步骤缺少断言',
    hint: '步骤内至少要有一次 `expect(...)`，且不能封装进外部函数。',
  },
  DISABLED_STEP_INCLUDED: {
    label: '包含了已禁用的步骤',
    hint: '只生成用例中 `enabled` 为 true 的步骤。',
  },
  PAGE_GOTO_REQUIRED: {
    label: '缺少页面跳转',
    hint: '脚本需要调用 `page.goto(...)`。',
  },
  PAGE_GOTO_TARGET_MISMATCH: {
    label: '跳转地址不在同源范围',
    hint: '`page.goto()` 必须是用例 Base URL 或其同源相对路径，且需为字符串字面量。',
  },
  PAGE_FIXTURE_REQUIRED: {
    label: '缺少 page fixture',
    hint: '`test(...)` 的回调参数需包含 `{ page }`。',
  },
  TEST_REQUIRED: { label: '缺少测试定义', hint: '脚本中需要有 `test(...)`。' },
  TEST_TITLE_MISMATCH: {
    label: '测试标题与用例不一致',
    hint: '`test(...)` 的标题必须与用例标题一致。',
  },
  EXPECT_REQUIRED: {
    label: '缺少断言',
    hint: '脚本中需要至少一次 `expect(...)`。',
  },
  ENVIRONMENT_VARIABLE_MISSING: {
    label: '环境变量引用缺失',
    hint: '用例以 `${ENV:KEY}` 声明的变量，脚本中必须写成 `process.env.KEY`。',
  },
  ENVIRONMENT_VARIABLE_UNDECLARED: {
    label: '引用了未声明的环境变量',
    hint: '只能引用用例里声明过的环境变量，不要自行发明变量名。',
  },
  IMPORT_NOT_ALLOWED: {
    label: '导入了不允许的模块',
    hint: '脚本只能导入 `@playwright/test`。',
  },
  PLAYWRIGHT_IMPORT_NOT_ALLOWED: {
    label: '导入了不允许的模块',
    hint: '脚本只能导入 `@playwright/test`。',
  },
  PLAYWRIGHT_TEST_IMPORT_REQUIRED: {
    label: '缺少 test 导入',
    hint: '需要从 `@playwright/test` 导入 `test`。',
  },
  PLAYWRIGHT_EXPECT_IMPORT_REQUIRED: {
    label: '缺少 expect 导入',
    hint: '需要从 `@playwright/test` 导入 `expect`。',
  },
  PLAYWRIGHT_IMPORT_FORM_INVALID: {
    label: '导入写法不合法',
    hint: "使用具名导入：`import { test, expect } from '@playwright/test'`。",
  },
  FORBIDDEN_API: {
    label: '使用了被禁止的能力',
    hint: '禁止 `eval`、`new Function`、`child_process`、文件读写等调用。',
  },
  DYNAMIC_IMPORT_NOT_ALLOWED: {
    label: '不允许动态导入',
    hint: '不要使用 `import(...)`。',
  },
  REQUIRE_NOT_ALLOWED: {
    label: '不允许 require',
    hint: '不要使用 `require(...)`。',
  },
}

/** 组织后的失败提示。 */
export interface IValidationFailureDigest {
  /** 直接展示给用户的摘要文本（多行）。 */
  message: string
  /** 错误总条数。 */
  errorCount: number
}

/**
 * 把校验错误清单组织为面向用户的失败摘要。
 *
 * 输出形如：
 * ```
 * 脚本未通过静态校验（共 2 项）：
 * 1. 第 55 行第 23 列｜类型检查未通过：Parameter 'message' implicitly has an 'any' type.
 *    → 按提示补全类型标注（自行声明的函数与回调参数需写 `: any`）。
 * 2. ...
 * 另有 1 项问题未列出。
 * ```
 *
 * @param errors - 校验器产出的 error 级问题清单，需非空。
 * @returns 摘要文本与错误总数。
 * @throws 不抛出异常；空数组时返回兜底文案。
 */
export function buildValidationFailureDigest (
  errors: readonly IPlaywrightValidationIssue[],
): IValidationFailureDigest {
  if (errors.length === 0) {
    return {
      message: '生成的 Playwright 脚本未通过静态校验。',
      errorCount: 0,
    }
  }

  const listed = errors.slice(0, MAX_LISTED_ERRORS).map(formatIssue)
  const lines = [`脚本未通过静态校验（共 ${errors.length} 项）：`, ...listed]

  // 超出上限时明确说明还有多少条，避免用户误以为问题只有列出的这些。
  if (errors.length > MAX_LISTED_ERRORS) {
    lines.push(`另有 ${errors.length - MAX_LISTED_ERRORS} 项问题未列出。`)
  }

  return { message: lines.join('\n'), errorCount: errors.length }
}

/**
 * 格式化单条错误为「位置｜类别：原文」并附修复方向。
 *
 * @param issue - 单条校验问题。
 * @param index - 在清单中的序号（从 0 开始），用于编号展示。
 * @returns 单行标题 + 可选修复提示行的文本。
 * @throws 不抛出异常。
 */
function formatIssue (issue: IPlaywrightValidationIssue, index: number): string {
  const location = formatLocation(issue)
  const guidance = ERROR_GUIDANCE[issue.code]
  const label = guidance?.label ?? '校验未通过'

  const head = `${index + 1}. ${location}${label}：${issue.message}`
  return guidance ? `${head}\n   → ${guidance.hint}` : head
}

/**
 * 生成位置前缀，尽量指向可操作的位置。
 *
 * 优先给出步骤（用户按用例概念定位最直观），其次给行号，两处都没有时说明位置未知。
 *
 * @param issue - 单条校验问题。
 * @returns 形如 `第 3 步（step_xxx）第 55 行` 的前缀，末尾带分隔符 `｜`。
 * @throws 不抛出异常。
 */
function formatLocation (issue: IPlaywrightValidationIssue): string {
  const parts: string[] = []
  if (issue.stepId) {
    parts.push(`步骤 ${issue.stepId}`)
  }
  if (issue.line !== undefined) {
    parts.push(
      issue.column !== undefined
        ? `第 ${issue.line} 行第 ${issue.column} 列`
        : `第 ${issue.line} 行`,
    )
  }
  return parts.length > 0 ? `${parts.join(' ')}｜` : ''
}

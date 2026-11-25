/**
 * 在保存边界重新校验 sourceHash 与 Playwright 代码，并按 mode 决定写入形态。
 *
 * 生成完成首次落盘与用户实时编辑走**同一条写入路径**（PRD 8.2）。v15 起两者的
 * **校验语义一致**：内容质量问题不再阻断，转为诊断由界面提醒；只有安全族问题
 * （见 `isBlockingDiagnostic`）仍拦下保存。区别只剩写入形态：
 *
 *   - `generation`：零诊断时写入**格式化后**的代码；有任何诊断则写入原文。
 *   - `edit`：一律写入**用户原文**。格式化会重排正在编辑的代码、移动光标，
 *     每次防抖保存都用格式化结果覆盖输入，表现为「打着字光标乱跳、缩进被反复纠正」。
 */
import {
  FileE2ETestCaseRepository,
  FilePlaywrightScriptRepository,
  SkillManagerError,
} from '@charlie_deng/e2e-assistant-skill-manager'
import {
  PlaywrightScriptValidator,
  type IPlaywrightValidationIssue,
  type IPlaywrightValidationResult,
} from '@charlie_deng/e2e-assistant-playwright-engine'
import { isBlockingDiagnostic } from '@charlie_deng/e2e-assistant-types'
import type {
  IFileSaveDiagnostic,
  ISavePlaywrightScriptData,
  ISavePlaywrightScriptRequest,
} from '@charlie_deng/e2e-assistant-types'
import { ApiError } from '../../shared/errors/api-error'
import { buildValidationFailureDigest } from './validation-error-digest'

/**
 * 保存 Playwright 脚本到正式 `test.spec.ts`。
 *
 * @param input - Skill 根目录、ID 与保存请求（含 mode）。
 * @returns 已保存脚本的版本、生成元数据与校验诊断。
 * @throws SkillManagerError 当来源哈希不一致或文件版本冲突时抛出。
 * @throws ApiError 当 generation 模式校验未通过时抛出。
 */
export async function savePlaywrightScript (input: {
  rootDir: string
  skillId: string
  request: ISavePlaywrightScriptRequest
}): Promise<ISavePlaywrightScriptData> {
  const testCaseRepository = new FileE2ETestCaseRepository({
    rootDir: input.rootDir,
  })
  const document = await testCaseRepository.findBySkillId(input.skillId)

  if (document.sourceHash !== input.request.sourceHash) {
    throw new SkillManagerError(
      'SOURCE_HASH_CONFLICT',
      'E2E 用例已发生变化，请重新生成 Playwright 脚本。',
    )
  }

  const validation = new PlaywrightScriptValidator().validate(
    input.request.code,
    {
      testCase: document.testCase,
    },
  )

  // v15：内容质量问题不再阻断写入，只作为诊断随响应回传由界面提醒用户；
  // 只有安全族诊断（禁止 API / 越界写盘 / 语法不可解析等）仍拦下本次保存。
  // 判据不在这里手写：`SECURITY_BLOCKING_CODES` 是唯一权威定义。
  if (validation.errors.some(isBlockingDiagnostic)) {
    const digest = buildValidationFailureDigest(validation.errors)
    throw new ApiError({
      code: 'PLAYWRIGHT_SCRIPT_INVALID',
      status: 400,
      message: digest.message,
      cause: validation.errors,
    })
  }

  // 写入内容的选择：**零诊断时写格式化结果，只要有任何诊断一律写 Agent 原文**。
  // 格式化会按 AST 重排代码，带问题时重排会让诊断里的行号与落盘内容错位、
  // 也让「界面显示的内容」与「磁盘内容」出现无人预期的差异。
  const hasAnyIssue = validation.errors.length + validation.warnings.length > 0
  const contentToWrite =
    input.request.mode === 'generation' && !hasAnyIssue
      ? validation.code
      : input.request.code

  return new FilePlaywrightScriptRepository({ rootDir: input.rootDir }).save(
    input.skillId,
    contentToWrite,
    input.request.sourceHash,
    input.request.expectedScriptVersion,
    toDiagnostics(validation),
  )
}

/**
 * 把 Playwright 校验结果归一化为统一诊断。
 *
 * 归一化在适配器层完成，`useAutoSave` 与错误条组件因此无需区分产物类型（单一职责）。
 *
 * v15 起质量类问题不再阻断，诊断可能一次出现多条（例如整个步骤覆盖都缺失时
 * 会逐步骤报出）。这里按诊断码去重并截断：列表只用于提醒，同码重复对用户
 * 没有额外信息，反而会把卡片撑长、淹没真正的重点。
 *
 * @param validation - 静态校验结果。
 * @returns 合并 error / warning 并按码去重、截断后的诊断列表。
 */
function toDiagnostics (
  validation: IPlaywrightValidationResult,
): IFileSaveDiagnostic[] {
  const merged = [
    ...validation.errors.map(toDiagnostic),
    ...validation.warnings.map(toDiagnostic),
  ]

  const seen = new Set<string>()
  const deduplicated: IFileSaveDiagnostic[] = []

  for (const diagnostic of merged) {
    if (seen.has(diagnostic.code)) continue
    seen.add(diagnostic.code)
    deduplicated.push(diagnostic)
  }

  if (deduplicated.length <= MAX_LISTED_DIAGNOSTICS) {
    return deduplicated
  }

  // 截断时补一条说明，避免用户误以为问题只有列出的这些（与错误摘要同一取向）。
  return [
    ...deduplicated.slice(0, MAX_LISTED_DIAGNOSTICS),
    {
      code: 'PLAYWRIGHT_SCRIPT_INVALID',
      message: `另有 ${deduplicated.length - MAX_LISTED_DIAGNOSTICS} 类问题未列出。`,
      severity: 'warning',
    },
  ]
}

/** 诊断列表的展示上限：超出后只给数量，避免卡片被刷屏。 */
const MAX_LISTED_DIAGNOSTICS = 3

/** 把单条校验问题转换为统一诊断形状。 */
function toDiagnostic (issue: IPlaywrightValidationIssue): IFileSaveDiagnostic {
  return {
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }
}

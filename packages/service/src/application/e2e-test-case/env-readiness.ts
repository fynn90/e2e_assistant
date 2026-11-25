/**
 * 生成前的 env 引用就绪校验（v10，PRD 7.3 J1–J3）。
 *
 * 单一职责：判定「用例引用的 env key 是否都能被 env.json 承载」，
 * 供 SKILL.md 生成与 Playwright 脚本生成两条入口共用。本模块保持纯函数可测——
 * env.json 的读取由调用方完成（`readEnvFileState`），判定本身不接触文件系统。
 */

import {
  collectEnvReferences,
  extractEnvFileKeys,
  findMissingEnvReferences,
  parseEnvFileContent,
  type IE2EValidationIssue,
} from '@charlie_deng/e2e-assistant-types'
import {
  readSkillFile,
  SKILL_ENV_FILE_NAME,
  type ISkillStorageOptions,
} from '@charlie_deng/e2e-assistant-skill-manager'

/** env.json 的读取状态：合法（含 key 集合）、缺失或格式非法。 */
export type TEnvFileState =
  | { status: 'ok'; keys: Set<string> }
  | { status: 'missing' }
  | { status: 'invalid' }

/** 生成前 env 引用校验问题：在领域问题之上携带稳定错误码，供 HTTP 层抛出。 */
export interface IEnvReadinessIssue extends IE2EValidationIssue {
  code: 'ENV_REFERENCE_MISSING' | 'ENV_FILE_UNAVAILABLE'
}

/**
 * 读取 Skill 的 env.json 并解析为就绪校验可用的状态。
 *
 * 读取失败（缺失、权限等）一律降级为 `missing` 参与判定，
 * 与「env.json 被外部删除」的场景语义一致。
 *
 * @param options - Skill 存储根目录配置。
 * @param skillId - 九位 Skill ID。
 * @returns env.json 的解析状态。
 * @throws 不抛出异常——读取失败等价于「缺失」场景。
 */
export async function readEnvFileState (
  options: ISkillStorageOptions,
  skillId: string,
): Promise<TEnvFileState> {
  try {
    const file = await readSkillFile(options, skillId, SKILL_ENV_FILE_NAME)
    const parsed = parseEnvFileContent(file.content)

    if (parsed.issues.length > 0 || parsed.data === null) {
      return { status: 'invalid' }
    }

    return { status: 'ok', keys: new Set(extractEnvFileKeys(parsed.data)) }
  } catch {
    // 缺失、权限不足等读取失败：按缺失处理（J2/J3 语义）。
    return { status: 'missing' }
  }
}

/**
 * 生成前的 env 引用就绪校验（J1–J3，PRD 7.3）。
 *
 * 判定表：
 *   - envFile=ok 且引用全部存在 → 通过（空数组）；
 *   - envFile=ok 且存在失效引用（J1）→ 每个失效位置一条 ENV_REFERENCE_MISSING；
 *   - envFile=missing/invalid 且用例存在引用（J2）→ 一条 ENV_FILE_UNAVAILABLE；
 *   - envFile=missing/invalid 且用例无引用（J3）→ 通过。
 *
 * 引用集合与脚本生成的 `process.env` 提取同源（`collectEnvReferences`，
 * 仅启用步骤），保证「就绪校验放行 ⟺ 脚本可正确取值」。
 *
 * @param testCase - 已通过生成前结构校验的 E2E 用例。
 * @param envFile - 调用方读取的 env.json 状态。
 * @returns 阻断问题列表；空数组表示允许生成。
 * @throws 不抛出异常。
 */
export function validateEnvReferencesForGeneration (
  testCase: Parameters<typeof collectEnvReferences>[0],
  envFile: TEnvFileState,
): IEnvReadinessIssue[] {
  const references = collectEnvReferences(testCase)

  // J3：用例没有引用任何 env key 时，env.json 的任何状态都不阻断生成。
  if (references.length === 0) {
    return []
  }

  // J2：env.json 缺失或存在格式错误，且用例存在引用 → 阻断并引导修复。
  if (envFile.status !== 'ok') {
    return [
      {
        code: 'ENV_FILE_UNAVAILABLE',
        path: ['env.json'],
        message:
          envFile.status === 'invalid'
            ? 'env.json 存在格式错误，请先修复后再生成。'
            : 'env.json 缺失，无法承载用例引用的敏感数据，请先创建或恢复该文件。',
      },
    ]
  }

  // J1：逐个失效引用产出带定位的问题，供就绪摘要展示与跳转。
  return findMissingEnvReferences(testCase, envFile.keys).map((finding) => ({
    code: 'ENV_REFERENCE_MISSING' as const,
    path: finding.path,
    message: `引用的 key "${finding.key}" 在 env.json 中不存在（${describeEnvReferencePath(finding.path)}），请在 env.json 中补充该 key 或移除此引用。`,
  }))
}

/**
 * 把失效引用的用例内路径转换为用户可读的位置描述。
 *
 * @param path - 失效引用在用例中的位置路径（与 IE2EValidationIssue.path 同构）。
 * @returns 形如「步骤 2 的测试数据」「前置条件 1」的位置描述。
 * @throws 不抛出异常。
 */
function describeEnvReferencePath (path: Array<string | number>): string {
  const [section, itemIndex, field] = path

  if (section === 'preconditions' && typeof itemIndex === 'number') {
    return `前置条件 ${itemIndex + 1}`
  }

  if (section === 'steps' && typeof itemIndex === 'number') {
    const fieldLabels: Record<string, string> = {
      description: '步骤描述',
      action: '操作动作',
      expectedResult: '预期结果',
      testData: '测试数据',
    }
    const label = typeof field === 'string' ? fieldLabels[field] : undefined
    return label ? `步骤 ${itemIndex + 1} 的${label}` : `步骤 ${itemIndex + 1}`
  }

  if (
    section === 'title' ||
    section === 'description' ||
    section === 'baseUrl'
  ) {
    return section === 'baseUrl'
      ? '目标 URL'
      : section === 'title'
        ? '用例标题'
        : '用例描述'
  }

  if (section === 'tags') {
    return '标签'
  }

  return '用例内容'
}

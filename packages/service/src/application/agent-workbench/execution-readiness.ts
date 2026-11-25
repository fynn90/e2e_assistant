/**
 * 执行前体检（v17 R3）：复用就绪校验的**只读判定**，不启动运行。
 *
 * ## 与执行链路的区别只有一条：不产生副作用
 *
 * 体检**不启动浏览器、不产生执行记录、不占用执行通道**（PRD R3 明确要求）。
 * 这带来两处必须的拆分（技术方案 F9 / R6）：
 *   - `checkTestReportDirectoryWritable` **会创建**报告目录，体检与批次预判
 *     不得调用它——改用只读的 {@link describeReportDirectoryReadiness}
 *    （目录存在且可写 → 通过；不存在 → 视为可建，不创建任何东西）。
 *   - Chromium 检测（J7）也不在体检里跑：它可能触发安装，属执行前动作。
 *
 * ## 判定同源
 *
 * 除上述副作用差异外，逐项判定都调用**与执行链路同一个函数**
 *（`checkScriptHasTests` / `checkEnvReferencesForExecution` /
 * `checkBaseUrlConfigured` / `checkExecutionMutex`）——体检说能跑、执行却报错，
 * 才是最难排查的缺陷。
 *
 * ## 不读 env 的值
 *
 * 体检只需要 key 集合；值只在执行时必须注入。不取值让「值不进内存」这条线
 * 更干净（D7 的延伸）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileE2ETestCaseRepository,
  SKILL_ENV_FILE_NAME,
  readSkillFile,
  resolveSkill,
} from '@fynn90-e2e_assistant/skill-manager'
import type { ISkillStorageOptions } from '@fynn90-e2e_assistant/skill-manager'
import {
  parseEnvFileContent,
  type IExecutionPrecheckIssue,
  type IReadinessViewPayload,
  type TAgentWorkbenchAction,
} from '@fynn90-e2e_assistant/types'
import type { IGenerationTaskRegistry } from '../../generation-runtime/generation-task-registry'
import {
  checkBaseUrlConfigured,
  checkEnvReferencesForExecution,
  checkExecutionMutex,
  checkScriptHasTests,
  describeReportDirectoryReadiness,
  type TExecutionEnvFileState,
} from '../test-execution/execution-precheck'

/**
 * 体检项的展示标签（问题码 → 人话名）。
 *
 * 为什么以「问题列表」反推而不是逐项都跑一遍：执行链路的判定函数是**只产问题**的
 *（通过时不产出任何东西），体检卡要展示「哪些通过了」就必须有一份固定清单——
 * 两者结合：固定清单里被问题命中的标 ✗，其余标 ✓。
 */
const CHECK_LABELS: Record<string, string> = {
  EXECUTION_SPEC_MISSING: '脚本存在',
  EXECUTION_NO_TESTS: '脚本包含测试',
  ENV_FILE_UNAVAILABLE: '环境变量文件可读',
  ENV_REFERENCE_MISSING: '环境变量齐备',
  EXECUTION_BASE_URL_MISSING: '目标地址已配置',
  EXECUTION_MUTEX_CONFLICT: '没有冲突中的任务在跑',
  EXECUTION_REPORT_DIR_BLOCKED: '报告目录可写',
}

/** 体检的固定检查项清单（顺序即卡片展示顺序）。 */
const CHECKLIST_CODES = [
  'EXECUTION_SPEC_MISSING',
  'EXECUTION_NO_TESTS',
  'ENV_FILE_UNAVAILABLE',
  'ENV_REFERENCE_MISSING',
  'EXECUTION_BASE_URL_MISSING',
  'EXECUTION_MUTEX_CONFLICT',
  'EXECUTION_REPORT_DIR_BLOCKED',
] as const

/**
 * 由问题码推导修复入口（能就地修的给动作卡片，不能的由 Agent 走提案）。
 *
 * 环境变量缺失**不在此列**：补齐是 `propose_env_fill` 的职责，动作枚举里
 * 没有它——这里返回 undefined，由 Agent 依体检结果自行发起补齐提案。
 *
 * @param code - 问题码。
 * @returns 修复动作；无对应动作时返回 undefined。
 * @throws 不抛出异常。
 */
function fixActionOf (code: string): TAgentWorkbenchAction | undefined {
  switch (code) {
    case 'EXECUTION_SPEC_MISSING':
      return 'generate-playwright-script'
    case 'EXECUTION_BASE_URL_MISSING':
      // 地址错/缺：重生成脚本不会改地址，但它是「在开发页打开用例」之外
      // 唯一可用的动作；真正修复需走变更提案（E 组 / V7），由 Agent 发起。
      return undefined
    default:
      return undefined
  }
}

/** 体检服务接口（注入给 `check_readiness` 工具与视图宿主）。 */
export interface IReadinessService {
  /**
   * 对指定用例做执行前体检。
   *
   * @param rootDir - 工作区根目录。
   * @param skillId - 用例唯一 ID。
   * @returns 体检载荷；目标不存在或不可读时返回归一化失败。
   * @throws 不抛出异常——所有失败都归一为 `{ ok: false }`。
   */
  check (
    rootDir: string,
    skillId: string,
  ): Promise<
    | { ok: true; readiness: IReadinessViewPayload }
    | { ok: false; message: string }
  >
}

/**
 * 创建体检服务。
 *
 * @param dependencies - 任务注册表（J6 互斥判定的来源，与执行链路同一实例）。
 * @returns 体检服务实例。
 * @throws 不抛出异常。
 */
export function createReadinessService (dependencies: {
  taskRegistry: IGenerationTaskRegistry
}): IReadinessService {
  return {
    async check (rootDir, skillId) {
      const storage: ISkillStorageOptions = { rootDir }

      let skillRoot: string
      let skillTitle: string
      try {
        const resolved = await resolveSkill(storage, skillId)
        skillRoot = resolved.skillRoot
        skillTitle = resolved.detail.title
      } catch {
        return {
          ok: false,
          message: `工作区内不存在 ID 为 ${skillId} 的用例。`,
        }
      }

      const issues: IExecutionPrecheckIssue[] = []

      // J6：互斥（只查、不 acquire——体检不占用执行通道）。
      issues.push(
        ...checkExecutionMutex(
          dependencies.taskRegistry.currentSessionId(skillId),
        ),
      )

      // J1 + J2 + J4：脚本存在性、脚本含测试、env 引用校验。
      let specContent: string | undefined
      try {
        const specFile = await readSkillFile(storage, skillId, 'test.spec.ts')
        specContent = specFile.content
      } catch {
        issues.push({
          code: 'EXECUTION_SPEC_MISSING',
          message: 'test.spec.ts 不存在，无法执行。',
        })
      }

      if (specContent !== undefined) {
        issues.push(...checkScriptHasTests(specContent))
        const envFile = await readEnvState(storage, skillId)
        issues.push(...checkEnvReferencesForExecution(specContent, envFile))
      }

      // J5：目标地址。
      try {
        const document = await new FileE2ETestCaseRepository(
          storage,
        ).findBySkillId(skillId)
        issues.push(...checkBaseUrlConfigured(document.testCase.baseUrl))
      } catch {
        issues.push({
          code: 'EXECUTION_BASE_URL_MISSING',
          message: '用例结构化数据不可读，无法确认目标地址。',
        })
      }

      // J8：报告目录可写（**只读判定**，不创建目录——见文件头注释）。
      issues.push(...describeReportDirectoryReadiness(skillRoot))

      return {
        ok: true,
        readiness: buildReadinessPayload(skillId, skillTitle, issues),
      }
    },
  }
}

/**
 * 把逐项问题整理为体检载荷。
 *
 * `ENV_REFERENCE_MISSING` 可能一次产出多条（一个 key 一条），合并为一项并在
 * message 里逐条列出——卡片上是一行「环境变量齐备 ✗」，展开能看到缺哪些。
 *
 * @param skillId - 用例 ID。
 * @param skillTitle - 用例标题。
 * @param issues - 执行链路判定出的全部问题。
 * @returns 体检载荷。
 * @throws 不抛出异常。
 */
function buildReadinessPayload (
  skillId: string,
  skillTitle: string,
  issues: ReadonlyArray<IExecutionPrecheckIssue>,
): IReadinessViewPayload {
  const grouped = new Map<string, string[]>()
  for (const issue of issues) {
    const messages = grouped.get(issue.code) ?? []
    messages.push(issue.message)
    grouped.set(issue.code, messages)
  }

  const checks = CHECKLIST_CODES.map((code) => {
    const messages = grouped.get(code)
    const ok = !messages || messages.length === 0
    const fixAction = ok ? undefined : fixActionOf(code)
    return {
      code,
      label: CHECK_LABELS[code] ?? code,
      ok,
      ...(ok ? {} : { message: messages.join('\n') }),
      ...(fixAction ? { fixAction } : {}),
    }
  })

  return {
    skillId,
    skillTitle,
    ok: checks.every((check) => check.ok),
    checks,
  }
}

/**
 * 读取 env.json 的状态（与执行链路的读取同构，但**不取值**）。
 *
 * @param storage - 存储根目录。
 * @param skillId - 用例 ID。
 * @returns env 文件状态与 key 集合（values 恒为空对象，值的路径不在这里）。
 * @throws 不抛出异常。
 */
async function readEnvState (
  storage: ISkillStorageOptions,
  skillId: string,
): Promise<TExecutionEnvFileState> {
  try {
    const resolved = await resolveSkill(storage, skillId)
    const content = await readFile(
      join(resolved.skillRoot, SKILL_ENV_FILE_NAME),
      'utf8',
    )
    const parsed = parseEnvFileContent(content)
    if (!parsed.data) return { status: 'invalid' }

    return {
      status: 'ok',
      keys: new Set(Object.keys(parsed.data)),
      // 体检不需要值——给空对象满足联合类型。
      values: {},
    }
  } catch {
    return { status: 'missing' }
  }
}

/**
 * 执行前就绪校验（v11，技术方案 §5.1 / PRD 第 5 章 J1–J8）。
 *
 * 单一职责：集中维护全部就绪校验项的**判定与文案**，供执行编排服务
 * 与 Chat 的 execute_test 宿主适配器共用，保证按钮发起与 Chat 发起
 * 走同一条校验链路（PRD 4.2 C2）。
 *
 * 判定尽量纯函数化：文件与环境状态的读取由调用方完成，
 * 本模块只回答「通过与否 + 问题列表」，便于逐项单测。
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import path from 'node:path'
import { analyzeTestScript } from '@authine-e2e-agent/playwright-engine'
import {
  TEST_REPORT_DIRECTORY_NAME,
  ensureTestReportDirectory,
} from '@authine-e2e-agent/skill-manager'
import type { IExecutionPrecheckIssue } from '@authine-e2e-agent/types'

/** env.json 在执行链路中的状态（与生成链路 env-readiness 同构，额外携带值备注入）。 */
export type TExecutionEnvFileState =
  | { status: 'ok'; keys: Set<string>; values: Record<string, string> }
  | { status: 'missing' }
  | { status: 'invalid' }

/**
 * J2：脚本必须包含至少一条测试定义。
 *
 * 空文件、只有注释或辅助函数、无任何 test(...) 调用均视为不通过。
 *
 * @param specContent - test.spec.ts 的磁盘内容。
 * @returns 问题列表；空数组表示通过。
 * @throws 不抛出异常。
 */
export function checkScriptHasTests(
  specContent: string,
): IExecutionPrecheckIssue[] {
  if (analyzeTestScript(specContent).hasTests) {
    return []
  }

  return [
    {
      code: 'EXECUTION_NO_TESTS',
      message:
        '脚本中未找到任何测试用例，请先完成脚本生成或编辑 test.spec.ts。',
    },
  ]
}

/**
 * J4：脚本引用的每个环境变量 key 必须存在于 env.json 最新合法内容中。
 *
 * 判定表（对齐 v10 J3 精神）：
 *   - 脚本没有任何 process.env 引用 → env.json 处于任何状态都不阻断；
 *   - env.json 缺失/非法 且脚本存在引用 → 阻断并引导修复；
 *   - 存在缺失 key → 全部列出（不是只报第一条）。
 *
 * @param specContent - test.spec.ts 的磁盘内容（从中静态提取 process.env 引用）。
 * @param envFile - 调用方读取的 env.json 状态。
 * @returns 问题列表；空数组表示通过。
 * @throws 不抛出异常。
 */
export function checkEnvReferencesForExecution(
  specContent: string,
  envFile: TExecutionEnvFileState,
): IExecutionPrecheckIssue[] {
  const referencedKeys = analyzeTestScript(specContent).environmentVariables

  // 脚本不引用任何环境变量：env.json 缺失/非法/为空都不阻断。
  if (referencedKeys.length === 0) {
    return []
  }

  if (envFile.status !== 'ok') {
    return [
      {
        code: 'ENV_FILE_UNAVAILABLE',
        message:
          envFile.status === 'invalid'
            ? '执行失败：env.json 无法读取，请先修复后再执行。'
            : '执行失败：env.json 无法读取（文件缺失），请先修复后再执行。',
        target: 'env-file',
      },
    ]
  }

  const missingKeys = referencedKeys.filter((key) => !envFile.keys.has(key))

  if (missingKeys.length === 0) {
    return []
  }

  // 全部缺失 key 一次性列出（PRD J4）。
  return missingKeys.map((key) => ({
    code: 'ENV_REFERENCE_MISSING',
    message: `执行失败：脚本引用的 key "${key}" 在 env.json 中不存在，请在 env.json 中补充该 key 或移除脚本引用。`,
    target: 'env-file' as const,
  }))
}

/**
 * J5：目标 URL（e2e_schema.json 的 baseUrl）必须已配置。
 *
 * 生成规则允许脚本使用相对路径跳转，相对路径依赖 baseURL 注入（PRD X4）。
 *
 * @param baseUrl - 用例中的 baseUrl；缺失按空处理。
 * @returns 问题列表；空数组表示通过。
 * @throws 不抛出异常。
 */
export function checkBaseUrlConfigured(
  baseUrl: string | undefined | null,
): IExecutionPrecheckIssue[] {
  if (typeof baseUrl === 'string' && baseUrl.trim().length > 0) {
    return []
  }

  return [
    {
      code: 'EXECUTION_BASE_URL_MISSING',
      message: '目标 URL 未配置，请先在用例编辑页填写目标 URL。',
      target: 'test-case',
    },
  ]
}

/**
 * J6：互斥检查——同一 Skill 已有生成/执行任务运行时阻断。
 *
 * @param runningSessionId - 注册表中该 Skill 当前的任务会话 ID；空闲为 undefined。
 * @returns 问题列表；空数组表示通过。
 * @throws 不抛出异常。
 */
export function checkExecutionMutex(
  runningSessionId: string | undefined,
): IExecutionPrecheckIssue[] {
  if (!runningSessionId) {
    return []
  }

  return [
    {
      code: 'EXECUTION_MUTEX_CONFLICT',
      message: '当前 Skill 已有生成/执行任务正在运行，请等待其结束。',
    },
  ]
}

/**
 * J8：报告目录可建——`test_report` 被同名文件占用或不可写时阻断。
 *
 * **有副作用**：目录不存在时会创建它（`ensureTestReportDirectory`）。
 * 因此只允许**真正要执行**的链路调用；体检与批次预判必须改用
 * {@link describeReportDirectoryReadiness}（技术方案 F9 / R6 的强制拆分）。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 问题列表；空数组表示通过。
 * @throws 不抛出异常——skill-manager 的阻断错误转换为一条例子。
 */
export async function checkTestReportDirectoryWritable(
  skillRoot: string,
): Promise<IExecutionPrecheckIssue[]> {
  try {
    await ensureTestReportDirectory(skillRoot)
    return []
  } catch (error) {
    return [
      {
        code: 'EXECUTION_REPORT_DIR_BLOCKED',
        message:
          error instanceof Error
            ? error.message
            : 'test_report 目录不可写，无法保存测试报告。',
      },
    ]
  }
}

/**
 * J8 的**只读**版本（v17）：判定报告目录是否可写，但**不创建任何目录**。
 *
 * 体检（R3）与批次预判（R4a）不得为「可能根本不执行」的用例创建目录——
 * 那是可观测的副作用（用户会看到一堆空目录）。因此把「只读判定」与
 * 「创建并确认」拆开：
 *   - 目录不存在 → 视为**可建**（留到真正执行时再创建）；
 *   - 目录存在且是目录 → 校验可写（`access(W_OK)`）；
 *   - 被同名文件占用 / 不可写 → 与执行链路同一问题码与文案。
 *
 * 判定语义与 {@link checkTestReportDirectoryWritable} 保持同源：两者对
 * 「已存在的目录」给出一致结论，差异只在「不存在时不做任何事」。
 *
 * @param skillRoot - 已解析的 Skill 目录绝对路径。
 * @returns 问题列表；空数组表示可写（或可建）。
 * @throws 不抛出异常。
 */
export function describeReportDirectoryReadiness(
  skillRoot: string,
): IExecutionPrecheckIssue[] {
  const directory = path.join(skillRoot, TEST_REPORT_DIRECTORY_NAME)

  let statResult
  try {
    statResult = statSync(directory)
  } catch (error) {
    // ENOENT：目录还不存在——真正执行时会创建，此刻不判定为问题（也不创建）。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    return [
      {
        code: 'EXECUTION_REPORT_DIR_BLOCKED',
        message: 'test_report 目录状态无法确认，无法保存测试报告。',
      },
    ]
  }

  if (!statResult.isDirectory()) {
    return [
      {
        code: 'EXECUTION_REPORT_DIR_BLOCKED',
        message:
          'test_report 已被同名文件占用，无法保存测试报告，请删除或重命名该文件后重试。',
      },
    ]
  }

  try {
    accessSync(directory, fsConstants.W_OK)
    return []
  } catch {
    return [
      {
        code: 'EXECUTION_REPORT_DIR_BLOCKED',
        message: 'test_report 目录没有写入权限，无法保存测试报告。',
      },
    ]
  }
}

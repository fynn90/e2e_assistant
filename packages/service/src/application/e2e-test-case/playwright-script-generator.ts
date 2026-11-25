/**
 * 通过生成 Agent 产出 Playwright 候选脚本，并从临时工作区读回产物。
 *
 * 与 SKILL.md 生成器的结构对齐（复用同一套会话运行器与工具守卫模式）：
 *   - 应用层只构造 prompt、声明守卫、读取 Agent 产物；
 *   - 会话承载（AgentService 与运行时装配）由 ISkillGenerationSessionRunner 端口负责；
 *   - 本模块绝不写正式脚本，也绝不写 Skill 目录外的文件。
 *
 * 分层职责（v7 起）：应用层只表达业务意图并传递必要参数，**不点名任何 Agent 工具**
 * （如加载 Skill、浏览器核对），这些生成规则全部由 `playwright_script_generation`
 * Skill 承载。工具守卫也只声明"允许做什么"，不向模型暴露工具清单。
 *
 * v7 与 v6 的差异：本生成器在会话前由编排层登记浏览器宿主，
 * 使 Agent 获得页面核对工具，从而在生成前核对目标页面真实元素（PRD 9.2），
 * 而不是仅凭文本推断选择器。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import type { IToolGuard } from '@charlie_deng/e2e-assistant-agent'
import { createGenerationWriteGuard } from './generation-tool-guards'
import { SkillDocumentAgentError } from '../../shared/errors/skill-document-errors'
import type { ISkillGenerationSessionRunner } from '../../shared/ports/skill-generation-session'

/**
 * 修复上下文（v17 G2a）：输入是失败报告 + 当前脚本 + 用例数据。
 *
 * 报告与脚本都在平台侧由调用方读出；本结构只承载**已脱敏的摘要**——
 * `errorMessage` 经既有脱敏器处理（与日志同一条链路，§8 的净化要求），
 * 且**不含任何 env 值**（与 v11 P11 同源约束）。
 */
export interface IRepairContext {
  /** 失败所在的历史运行（报告入口，供生成子会话按需核对细节）。 */
  reportRunId: string
  /** 失败摘要（来自 `summary.json` 的 failures，**不含 env 值**）。 */
  failures: Array<{
    title: string
    stepId?: string
    errorMessage?: string
  }>
  /** 用例在本次修复对应的版本（用于生成后的落盘校验）。 */
  testCaseVersion: string
}

/**
 * CLI 层可替换的 Playwright 候选脚本生成器契约。
 *
 * 默认实现会通过 Agent 的 write 工具把候选脚本写入临时工作区；
 * 测试替身可以直接返回候选内容，以便在不连接真实模型的情况下验证编排与校验链路。
 */
export interface IPlaywrightScriptAgentGenerator {
  /**
   * 生成候选脚本并读取 Agent 写入的临时文件内容。
   *
   * @param input - 已校验的结构化用例、SKILL.md 正文、目标临时文件与会话 ID。
   * @param options - 取消信号和阶段进度回调。
   * @returns Agent 生成的候选脚本内容与说明信息。
   * @throws SkillDocumentAgentError 当 Agent 取消、失败或未生成目标文件时抛出。
   */
  generate (
    input: {
      testCase: IE2ETestCase
      /** 当前有效 SKILL.md 正文；为空表示 Agent 尚未生成该文档。 */
      skillDocumentContent: string
      /** 候选脚本的固定写入目标（位于当前 Skill 的 temp/ 内）。 */
      targetFile: string
      /** 本次生成对应的 Agent 会话 ID：由调用方生成并先行下发给前端订阅。 */
      sessionId: string
      /** 已有正式脚本内容，重新生成时作为业务意图参考。 */
      previousCode?: string
      /**
       * 修复上下文（v17 G2a）：失败报告 + 当前脚本 + 用例数据。
       *
       * 三者都已在平台侧（报告在 `test_report/`、脚本在 Skill 根、用例在
       * `e2e_schema.json`），由服务端读出摘要后作为 prompt 的一部分交给生成
       * 子会话——Agent 不需要、也不允许碰它们（G2a 的输入约束）。
       *
       * 缺省时为普通生成 / 更新；提供时语义变为「修复」，prompt 会明确
       * 要求针对性修复（而不是整份重写，尽管实现上是整份产出）。
       */
      repairContext?: IRepairContext
      /** 守卫范围根目录（v11 A1：当前 Skill 目录绝对路径；缺省回退工厂的 workspace）。 */
      workspaceRoot?: string
    },
    options: {
      signal: AbortSignal
      onProgress?: (stage: 'requesting-model' | 'writing-script') => void
    },
  ): Promise<IPlaywrightScriptCandidate>
}

/**
 * 生成器返回的候选脚本。
 *
 * warnings / assumptions 由 Agent 在最终文本中按约定小标题给出；
 * 客户端解析失败时降级为空数组，不阻断生成主流程。
 */
export interface IPlaywrightScriptCandidate {
  /** 候选脚本内容（读自 Agent 写入的临时文件）。 */
  code: string
  /** Agent 披露的断点、警告与假设。 */
  warnings: Array<{
    code: string
    message: string
    severity: 'info' | 'warning'
    stepId?: string
  }>
  assumptions: string[]
}

/**
 * 创建 CLI 使用的 Playwright 候选脚本 Agent 生成器。
 *
 * @param options - 工作区与会话运行器（承载 Agent 会话并发布工作事件）。
 * @returns 通过会话运行器执行、由 Agent 写入临时文件并由本模块读回校验的生成器。
 * @throws 不在创建阶段抛出模型错误；运行时错误由 generate 转换为稳定错误码。
 */
export function createPlaywrightScriptGenerator (options: {
  workspace: string
  sessionRunner: ISkillGenerationSessionRunner
}): IPlaywrightScriptAgentGenerator {
  return {
    async generate (
      input,
      generationOptions,
    ): Promise<IPlaywrightScriptCandidate> {
      const targetFile = resolve(input.targetFile)
      generationOptions.onProgress?.('requesting-model')

      try {
        generationOptions.onProgress?.('writing-script')
        const result = await options.sessionRunner.run(
          {
            sessionId: input.sessionId,
            prompt: buildPlaywrightScriptPrompt(input, targetFile),
            title: '生成 Playwright 脚本',
            // 守卫只允许写入本次候选脚本目标；浏览器工具不写文件，因此不影响页面核对。
            // v11 A1：守卫范围 = 当前 Skill 目录（调用方传入 resolveSkill 的 skillRoot）。
            toolGuard: createScriptWriteOnlyToolGuard(
              input.workspaceRoot ?? options.workspace,
              targetFile,
            ),
          },
          { signal: generationOptions.signal },
        )

        if (generationOptions.signal.aborted) {
          throw new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'Playwright 脚本生成已取消。',
          )
        }
        if (result.errorMessage) {
          throw new SkillDocumentAgentError(
            'LLM_INVALID_RESPONSE',
            result.errorMessage,
          )
        }

        let code: string
        try {
          code = await readFile(targetFile, 'utf8')
        } catch (error) {
          throw new SkillDocumentAgentError(
            'LLM_INVALID_RESPONSE',
            'Agent 未将候选脚本写入临时工作区。',
            error,
          )
        }

        const notes = parseAgentNotes(result.finalText ?? '')
        return {
          code,
          warnings: notes.warnings,
          assumptions: notes.assumptions,
        }
      } catch (error) {
        if (generationOptions.signal.aborted) {
          throw new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'Playwright 脚本生成已取消。',
            error,
          )
        }
        if (error instanceof SkillDocumentAgentError) throw error
        throw new SkillDocumentAgentError(
          classifyAgentError(error),
          'Agent 生成 Playwright 脚本失败。',
          error,
        )
      }
    },
  }
}

/**
 * 构造 Playwright 脚本生成的用户提示词。
 *
 * 本函数的职责边界：**只表达业务意图并传递必要参数**。
 * 具体的生成规则（加载哪个 Skill、如何核对页面、脚本结构、定位器优先级、
 * 环境变量写法、产物落盘位置、如何披露断点与假设）全部由 Agent 侧的
 * `playwright_script_generation` Skill 承载——应用层不承载 agent 的工具知识，
 * 也不点名任何工具（依赖倒转原则）。
 *
 * 提示词的措辞约束：动词宾语唯一是「Playwright 脚本」，`SKILL.md` 与
 * `e2e_schema.json` 只作为输入参考出现。这样既能表达清楚任务，
 * 又不会与「根据用例生成文档」的 SKILL.md 生成任务产生句式同构而误触发。
 *
 * @param input - 当前用例、SKILL.md 正文与可选的上一版正式脚本。
 * @param targetFile - 后端解析出的候选脚本目标文件绝对路径。
 * @returns 面向 Agent 的用户提示词：业务意图 + 目标文件 + 三项输入数据。
 * @throws 不抛出异常。
 */
function buildPlaywrightScriptPrompt (
  input: {
    testCase: IE2ETestCase
    skillDocumentContent: string
    previousCode?: string
    repairContext?: IRepairContext
  },
  targetFile: string,
): string {
  // 三种语义按优先级判定：修复 > 更新 > 创建。
  // 修复优先于更新：带着失败上下文的「更新」在语义上就是修复，分开判会让
  // prompt 同时出现两套意图描述（模型无所适从）。
  const intent = input.repairContext
    ? '用户希望**修复**这个 Skill 的 Playwright 脚本：它上一次执行失败了，请基于下方给出的失败信息定位问题并修正脚本。'
    : input.previousCode
      ? '用户希望根据当前的 SKILL.md 与 e2e_schema.json 用例数据，更新这个 Skill 的 Playwright 脚本。'
      : '用户希望根据当前的 SKILL.md 与 e2e_schema.json 用例数据，为这个 Skill 创建 Playwright 脚本。'

  return [
    intent,
    // 明确区分"正式产物"与"本次写入目标"：正式脚本由用户在审阅后保存，
    // Agent 只写候选文件。若不加区分，Agent 可能自行推导出正式脚本路径去写。
    '本次只需要产出候选脚本，用户审阅确认后才会保存为正式的 test.spec.ts；你不要写入 test.spec.ts。',
    `请把候选脚本写入以下目标文件（这是本次唯一的写入目标）：${targetFile}`,
    // v14（PRD 5.1 / W6）：客户端 prompt 必须告知 userWorkSpace 的存在、用途与写入边界。
    buildUserWorkspaceContextBlock(),
    input.skillDocumentContent
      ? '作为参考，当前 Skill 的 SKILL.md 正文如下：\n\n' +
      input.skillDocumentContent
      : '当前 Skill 尚未生成 SKILL.md，请只依据用例数据生成，并在说明中提示该情况。',
    '作为参考，e2e_schema.json 中的用例数据如下：',
    JSON.stringify(input.testCase, null, 2),
    input.repairContext ? buildRepairContextBlock(input.repairContext) : '',
    input.previousCode
      ? `作为参考，已有正式脚本如下（仅参考其业务意图与可复用信息，不要盲目复制）：\n${input.previousCode.slice(0, 40_000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 构造修复上下文块（v17 G2）。
 *
 * 两条约束写进 prompt 的**动机**：
 *   1. 只修与失败相关的部分——不顺手改其它逻辑（G5h 的同源要求：
 *      改动越多，用户越难判断这次修改是否合理）；
 *   2. **不得为了让测试通过而修改预期结果**——若核对页面后发现页面元素与
 *      用例描述不一致，那属于用例侧的问题，应由 Agent 发起用例修复提案
 *      （G2f / G5），而不是把断言改软。
 *
 * @param context - 修复上下文（失败摘要，已脱敏、不含 env 值）。
 * @returns 注入到生成 prompt 的修复说明块。
 * @throws 不抛出异常。
 */
function buildRepairContextBlock (context: IRepairContext): string {
  const failures = context.failures
    .map((failure) => {
      const parts = [`- 「${failure.title}」`]
      if (failure.stepId) parts.push(`失败步骤：${failure.stepId}`)
      if (failure.errorMessage) parts.push(`错误摘要：${failure.errorMessage}`)
      return parts.join('　')
    })
    .join('\n')

  return [
    '## 本次是修复（上一次执行失败）',
    '',
    `失败所在的运行：${context.reportRunId}`,
    failures
      ? `失败条目：\n${failures}`
      : '（该次没有可用的失败明细，请结合脚本自行判断。）',
    '',
    '修复要求：',
    '1. **只修与失败相关的最小范围**，不要顺手优化其它步骤或改写无关逻辑；',
    '2. 保留与失败无关的内容（用例意图、已有的稳定性处理）；',
    '3. **不得为了让测试通过而放松断言**：若你核对页面后发现是**用例描述的操作方式与页面不符**（如按钮名不同），不要自行改写用例语义，按既有约定在说明中披露；',
    '4. 若失败原因是用例描述的操作方式确实有误，请在说明中明确指出「建议修改用例」，由平台走用例修复提案流程。',
  ].join('\n')
}

/**
 * 构造 userWorkSpace 上下文块（v14，PRD 5.1 推荐文案 + 执行期注入说明）。
 *
 * 文案前四段逐字采用 PRD 5.1；最后追加执行期注入说明，让 Agent 知道脚本中
 * 的产物路径必须由 SKILL_USER_WORKSPACE 派生、不得使用绝对路径（W38/A16）。
 *
 * @returns 注入到生成 prompt 的 userWorkSpace 说明块。
 * @throws 不抛出异常。
 */
function buildUserWorkspaceContextBlock (): string {
  return [
    '当前 Skill 根目录下存在固定目录 userWorkSpace。该目录用于存放测试流程执行过程中产生的目录和文件，例如截图、基准图片、差异图、导出文件和其他测试资源。',
    '用户可以在 userWorkSpace 内新建子目录或文件，也可以删除其中的子目录或文件。生成的 Playwright 脚本可以包含文件和目录操作，也可以引用 Node 原生文件和目录 API（例如 `node:fs`、`node:fs/promises`、`node:path`）。这些操作必须全部限定在当前 Skill 的 userWorkSpace 内，不能超过该目录。',
    'userWorkSpace 根目录本身不可删除、不可重命名。脚本不得写入 Skill 根目录或其他受保护文件。',
    '视觉基准默认目录是 `userWorkSpace/baselines`。如果用户在测试步骤中指定了基准目录，必须解析为 `userWorkSpace` 内的相对目录。如果用户既未指定基准目录也未指定基准图片，你不能私自创建基准目录或捕获基准图片，必须先通过 AskUserQuestion 向用户提问（提问卡片不提供跳过入口，用户必须给出回答）；万一没拿到可用回答，保留断点。',
    '执行测试时平台会向脚本注入环境变量 SKILL_USER_WORKSPACE（当前 Skill 的 userWorkSpace 绝对路径）；脚本中的产物路径必须由该变量派生，不得使用绝对路径。',
  ].join('\n\n')
}

/**
 * 创建 Playwright 脚本生成的工具守卫。
 *
 * 在公共守卫规则之外，本路径额外放行 `browser_*` 页面核对工具：
 * 它们只读取页面、不写文件，是生成前核对目标页面真实元素的必要能力。
 *
 * @param workspace - 守卫范围根目录（v11 A1：当前 Skill 目录绝对路径）。
 * @param targetFile - 已解析的候选脚本目标文件。
 * @returns 工具调用前守卫。
 * @throws 不抛出异常；不符合白名单的调用返回阻断结果。
 */
export function createScriptWriteOnlyToolGuard (
  workspace: string,
  targetFile: string,
): IToolGuard {
  return createGenerationWriteGuard({
    id: 'playwright-script-write-only-tool-guard',
    workspace,
    targetFile,
    extraAllowedPrefixes: ['browser_'],
    // 文案不点名任何工具：工具名属于 agent 侧知识，不应经应用层泄露给模型。
    blockedToolReason:
      '本次生成只允许读取工作区文件、核对目标页面以及写入指定的候选脚本文件。',
  })
}

/**
 * 解析 Agent 最终文本中的断点、假设与警告说明。
 *
 * 采用宽容解析：Agent 未按约定输出时返回空集合，不因为说明缺失而判定生成失败。
 *
 * @param finalText - Agent 最终回复文本。
 * @returns 归一化后的警告与假设列表。
 * @throws 不抛出异常。
 */
export function parseAgentNotes (finalText: string): {
  warnings: Array<{
    code: string
    message: string
    severity: 'info' | 'warning'
  }>
  assumptions: string[]
} {
  const warnings: Array<{
    code: string
    message: string
    severity: 'info' | 'warning'
  }> = []
  const assumptions: string[] = []
  const sections = splitByHeadings(finalText)

  for (const [heading, content] of sections) {
    const items = extractListItems(content)
    if (items.length === 0) continue

    if (heading.includes('断点')) {
      // 断点是与页面不一致的确定性结论，按 warning 级别展示以引起用户注意。
      for (const item of items) {
        warnings.push({
          code: 'PAGE_MISMATCH',
          message: item,
          severity: 'warning',
        })
      }
    } else if (heading.includes('警告')) {
      for (const item of items) {
        warnings.push({
          code: 'GENERATION_WARNING',
          message: item,
          severity: 'warning',
        })
      }
    } else if (heading.includes('假设')) {
      assumptions.push(...items)
    }
  }

  return { warnings, assumptions }
}

/**
 * 按 Markdown 小标题切分文本，保留标题与所属正文的对应关系。
 *
 * @param text - Agent 最终回复文本。
 * @returns 标题到正文的映射；无标题时返回空数组。
 * @throws 不抛出异常。
 */
function splitByHeadings (text: string): Array<[string, string]> {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const sections: Array<[string, string]> = []
  let currentHeading: string | null = null
  let buffer: string[] = []

  for (const line of lines) {
    const headingMatch = /^#{1,6}\s*(.+?)\s*$/.exec(line)

    if (headingMatch) {
      if (currentHeading !== null) {
        sections.push([currentHeading, buffer.join('\n')])
      }
      currentHeading = headingMatch[1] ?? ''
      buffer = []
      continue
    }

    buffer.push(line)
  }

  if (currentHeading !== null) {
    sections.push([currentHeading, buffer.join('\n')])
  }

  return sections
}

/**
 * 从正文中提取列表项文本。
 *
 * 支持 `-`、`*`、`+` 和 `1.` 形式的列表；同时接受整段非列表文本作为单条说明。
 *
 * @param content - 小节正文。
 * @returns 去重后的说明条目；内容为"无"时返回空数组。
 * @throws 不抛出异常。
 */
function extractListItems (content: string): string[] {
  const items = content
    .split('\n')
    .map((line) => line.trim())
    .map((line) => /^(?:[-*+]|\d+\.)\s+(.*)$/.exec(line)?.[1]?.trim() ?? '')
    .filter(Boolean)
    // "无" / "无。" 等占位表示该小节没有内容，不应作为说明展示。
    .filter((item) => !/^无[。.]?$/.test(item))

  return [...new Set(items)]
}

/**
 * 将 Agent 错误归一为 HTTP 层可识别的错误码。
 *
 * @param error - Agent 或模型抛出的未知异常。
 * @returns 稳定的 Agent 错误码。
 * @throws 不抛出异常。
 */
function classifyAgentError (
  error: unknown,
): Extract<
  import('@charlie_deng/e2e-assistant-types').TApiErrorCode,
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_INVALID_RESPONSE'
> {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase()
  if (
    message.includes('401') ||
    message.includes('unauthorized') ||
    message.includes('authentication')
  )
    return 'LLM_AUTH_FAILED'
  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  )
    return 'LLM_RATE_LIMITED'
  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('超时')
  )
    return 'LLM_TIMEOUT'
  if (
    message.includes('econn') ||
    message.includes('unavailable') ||
    message.includes('network')
  )
    return 'LLM_UNAVAILABLE'
  return 'LLM_INVALID_RESPONSE'
}

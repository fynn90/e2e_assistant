/**
 * 通过通用 Agent chat 调用测试用例 Skill，并让 Agent 将 SKILL.md 写入固定目录。
 *
 * CLI 只负责解析后端已验证的目标目录、构造受限的 Chat 任务和读取 Agent 产物；
 * 文档格式规则来自 test_case_Skill_document，应用层不直接写入 SKILL.md。
 *
 * 会话承载（AgentService 与运行时装配）由 ISkillGenerationSessionRunner 端口负责，
 * 使本模块不依赖具体的 Agent 实现，便于测试替换与运行时隔离。
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import type { IToolGuard } from '@charlie_deng/e2e-assistant-agent'
import type { TApiErrorCode } from '@charlie_deng/e2e-assistant-types'
import { createGenerationWriteGuard } from './generation-tool-guards'
import { SkillDocumentAgentError } from '../../shared/errors/skill-document-errors'
import type { ISkillGenerationSessionRunner } from '../../shared/ports/skill-generation-session'

/**
 * CLI 层可替换的 SKILL.md 生成器契约。
 *
 * 默认实现会通过 Agent 的 write 工具落盘；测试替身可以使用 fake runtime，
 * 以便验证应用层版本和校验流程而不连接真实模型。
 */
export interface ISkillMarkdownGenerator {
  /**
   * 生成并（默认实现中）写入 SKILL.md。
   *
   * @param input - 已校验的结构化用例、目标 Skill 目录和可选上一版文档。
   * @param options - 取消信号和阶段进度回调。
   * @returns Agent 生成的候选内容、警告和假设。
   * @throws SkillDocumentAgentError 当 Agent 取消、失败或未生成目标文件时抛出。
   */
  generate (
    input: {
      testCase: IE2ETestCase
      targetDirectory: string
      /** 本次生成对应的 Agent 会话 ID：由调用方生成并先行下发给前端订阅。 */
      sessionId: string
      previousContent?: string
    },
    options: {
      signal: AbortSignal
      onProgress?: (
        stage: 'requesting-model' | 'writing-skill' | 'repairing-output',
      ) => void
    },
  ): Promise<ISkillMarkdownCandidate>
}

/** Agent 生成器返回的文档候选。 */
export interface ISkillMarkdownCandidate {
  content: string
  warnings: Array<{
    code: string
    message: string
    severity: 'info' | 'warning'
    stepId?: string
  }>
  assumptions: string[]
}

/**
 * 创建 CLI 使用的 SKILL.md Agent 生成器。
 *
 * @param options - 工作区与会话运行器（承载 Agent 会话并发布工作事件）。
 * @returns 通过会话运行器执行、由 Agent 写入文件并由本模块读回校验的生成器。
 * @throws 不在创建阶段抛出模型错误；运行时错误由 generate 转换为稳定错误码。
 */
export function createSkillMarkdownGenerator (options: {
  workspace: string
  sessionRunner: ISkillGenerationSessionRunner
}): ISkillMarkdownGenerator {
  return {
    async generate (input, generationOptions): Promise<ISkillMarkdownCandidate> {
      const targetFile = resolve(input.targetDirectory, 'SKILL.md')
      generationOptions.onProgress?.('requesting-model')

      try {
        // 会话运行器负责取消传播与任务释放；本模块只关心 prompt、守卫与产物读取。
        // v11 A1：守卫范围 = 当前 Skill 目录（targetDirectory 即 Skill 目录），
        // Agent 只能读取当前 Skill 及其子目录内的文件。
        generationOptions.onProgress?.('writing-skill')
        const result = await options.sessionRunner.run(
          {
            sessionId: input.sessionId,
            prompt: buildSkillMarkdownPrompt(input, targetFile),
            title: '生成 SKILL.md',
            toolGuard: createSkillDocumentToolGuard(
              input.targetDirectory,
              targetFile,
            ),
          },
          { signal: generationOptions.signal },
        )
        if (generationOptions.signal.aborted) {
          throw new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'SKILL.md 生成已取消。',
          )
        }
        if (result.errorMessage) {
          throw new SkillDocumentAgentError(
            'LLM_INVALID_RESPONSE',
            result.errorMessage,
          )
        }

        let content: string
        try {
          content = await readFile(targetFile, 'utf8')
        } catch (error) {
          throw new SkillDocumentAgentError(
            'LLM_INVALID_RESPONSE',
            'Agent 未将 SKILL.md 写入指定 Skill 目录。',
            error,
          )
        }
        return { content, warnings: [], assumptions: [] }
      } catch (error) {
        if (generationOptions.signal.aborted) {
          throw new SkillDocumentAgentError(
            'GENERATION_CANCELLED',
            'SKILL.md 生成已取消。',
            error,
          )
        }
        if (error instanceof SkillDocumentAgentError) throw error
        throw new SkillDocumentAgentError(
          classifyAgentError(error),
          'Agent 生成 SKILL.md 失败。',
          error,
        )
      }
    },
  }
}

/**
 * 构造触发测试用例文档 Skill 的用户提示词。
 *
 * @param input - 当前用例和可选的上一版文档。
 * @param targetFile - 后端解析出的固定目标文件绝对路径。
 * @returns 包含 Skill 调用要求、目标文件和 test_case 数据的用户提示词。
 * @throws 不抛出异常。
 */
function buildSkillMarkdownPrompt (
  input: { testCase: IE2ETestCase; previousContent?: string },
  targetFile: string,
): string {
  return [
    `请根据以下 test_case 数据生成 SKILL.md 文档，并写入指定的文件：${targetFile}`,
    'test_case 数据：',
    JSON.stringify(input.testCase, null, 2),
    input.previousContent
      ? `上一版 SKILL.md（仅用于保持稳定，不要盲目复制）：\n${input.previousContent.slice(0, 40_000)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 创建 SKILL.md 生成的工具守卫。
 *
 * 复用生成任务的公共守卫规则，且**不额外放行任何工具前缀**：
 * SKILL.md 生成不需要访问目标页面，因此该路径不应拿到浏览器能力（PRD 4.2 授权边界）。
 *
 * @param workspace - 守卫范围根目录（v11 A1：当前 Skill 目录绝对路径）。
 * @param targetFile - 已由 Skill Manager 解析的固定目标文件。
 * @returns 工具调用前守卫。
 * @throws 不抛出异常；不符合白名单的调用返回阻断结果。
 */
function createSkillDocumentToolGuard (
  workspace: string,
  targetFile: string,
): IToolGuard {
  return createGenerationWriteGuard({
    id: 'skill-document-write-only-tool-guard',
    workspace,
    targetFile,
    // 文案不点名任何工具：工具名属于 agent 侧知识，不应经应用层泄露给模型。
    blockedToolReason:
      '本次生成只允许读取工作区文件与写入指定的 SKILL.md 文件。',
  })
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
  TApiErrorCode,
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

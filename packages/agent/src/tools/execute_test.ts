/**
 * execute_test 工具（v11 引入，v16 放开 skillId）：让 Agent 发起一次测试执行。
 *
 * 与浏览器工具同构的宿主模式：本包只定义 ITestRunnerHost 端口并消费其返回值，
 * 执行的就绪校验（J1–J8）与 env 值拼装由 CLI 组合根注入的适配器完成，
 * 执行终点是 Playwright engine 的 testRunner——agent 包对 engine 只依赖类型契约，
 * 不建立包依赖。
 *
 * 非阻塞返回（D9）：发起成功即返回「已开始执行」，执行过程由对话流的执行卡片
 * 实时呈现（v11 为侧边栏执行区块），Chat 轮次不等待数分钟执行。
 *
 * v16 变化：`skillId` 由「预留且被拒绝」转为**必填**——/agent 工作台没有
 * 「当前打开的 Skill」可绑定，目标必须由 Agent 经检索工具定位后显式传入。
 *
 * 安全边界（A3）：就绪失败的问题列表与成功消息中只有 key 名/文案，没有 env 值。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'

/** SKILL 唯一 ID 的形状：9 位 [a-z0-9]（与 skill-manager / 检索工具一致）。 */
const SKILL_ID_PATTERN = /^[a-z0-9]{9}$/

/** 就绪校验失败的单条问题（与 HTTP 422 的 issues 同构，无 env 值）。 */
export interface IExecuteTestIssue {
  /** 稳定问题码（如 EXECUTION_NO_TESTS / ENV_REFERENCE_MISSING）。 */
  code: string
  /** 面向用户的中文说明。 */
  message: string
}

/** 发起执行的宿主结果。 */
export type TExecuteTestHostResult =
  | { ok: true; executionId: string; message: string }
  | { ok: false; issues: IExecuteTestIssue[] }

/**
 * 执行宿主端口：由 CLI 组合根注入（技术方案 §6.1 调用链的下半段）。
 *
 * 实现方职责：按 skillId 解析目标 Skill（工作区内，防路径注入）、执行 J1–J8
 * 就绪校验、读取 env.json 组装注入值（值只在此处接触）、驱动 engine testRunner.run。
 *
 * v16 起 `skillId` 必填：/agent 工作台没有「当前打开的 Skill」可绑定，
 * 目标必须由 Agent 经检索定位后显式传入（PRD RUN-1 / ID-4）。
 * Skill 开发页场景另注入适配器（目标恒为会话绑定的 Skill）。
 */
export interface ITestRunnerHost {
  /**
   * 发起一次测试执行（非阻塞）。
   *
   * @param options - 目标 SKILL 唯一 ID（9 位 [a-z0-9]）与取消信号（随会话中止传播）。
   * @returns 发起成功（含执行 ID）或就绪失败（含全部问题）。
   * @throws 实现方可抛出结构化错误（互斥冲突等），由工具作为失败结果返回给模型。
   */
  startExecution(options: {
    /** 目标 SKILL 的唯一 ID；由 Agent 经检索工具定位后传入。 */
    skillId: string
    signal?: AbortSignal
  }): Promise<TExecuteTestHostResult>
}

/** execute_test 工具接受的参数 Schema。 */
const executeTestParameters = Type.Object({
  /**
   * 目标 SKILL 的唯一 ID（必填）。
   *
   * 必填而非可选：缺参必须由模型自修复（先检索再执行），
   * 服务端无从猜测目标（PRD ID-4：标题、目录名、路径一律不接受）。
   */
  skillId: Type.String({
    description:
      '目标 e2e 测试用例的九位唯一 ID（[a-z0-9]）。先用 list_skills 检索候选、用 read_skill_document 确认，再把候选的 ID 传到这里；不要传标题、目录名或路径。',
  }),
})

/** execute_test 工具返回的结构化执行详情。 */
export interface ExecuteTestDetails {
  /** 是否发起成功。 */
  ok: boolean
  /** 发起成功时的执行 ID（进度见侧边栏执行区块）。 */
  executionId?: string
  /** 就绪失败时的问题列表。 */
  issues?: IExecuteTestIssue[]
}

/**
 * 创建发起测试执行的 Agent 工具。
 *
 * @param host - CLI 组合根注入的执行宿主（完成就绪校验与 env 拼装）。
 * @returns 可直接配置到 AgentTool[] 的 execute_test 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createExecuteTestTool(
  host: ITestRunnerHost,
): AgentTool<typeof executeTestParameters, ExecuteTestDetails> {
  return {
    name: 'execute_test',
    label: '执行测试用例',
    description:
      '对指定的 e2e 测试用例发起一次执行：传入该用例的唯一 ID，平台会做执行前就绪校验（脚本、env.json、目标 URL 等），校验通过后有头执行 test.spec.ts，过程与结果在对话流中实时展示。目标必须是本工作区内已存在、且 SKILL.md 与 test.spec.ts 齐备的用例；不要自行拼接测试命令，也不要读取环境变量值——敏感值由平台在命令层注入。',
    parameters: executeTestParameters,
    // 发起是幂等的短操作，但与后续的对话强相关，按顺序执行。
    executionMode: 'sequential',
    /**
     * 经宿主发起执行并返回非阻塞结果。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的调用参数（skillId 必填）。
     * @param signal - 取消信号；透传给宿主以便随会话中止。
     * @param _onUpdate - 流式进度回调；发起为单次等待，无中间进度。
     * @returns 包含发起结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的结构化错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, signal, _onUpdate) {
      void _toolCallId
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''

      // 格式先于宿主校验：非法 ID 不值得打一次磁盘，且提示要能自修复。
      if (!SKILL_ID_PATTERN.test(skillId)) {
        return {
          content: [
            {
              type: 'text',
              text: '需要提供目标用例的九位唯一 ID（[a-z0-9]）。请先用 list_skills 检索候选，再用候选的 ID 调用本工具；不要传标题、目录名或路径。',
            },
          ],
          details: { ok: false },
        }
      }

      const result = await host.startExecution({
        skillId,
        ...(signal ? { signal } : {}),
      })

      if (result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: result.message,
            },
          ],
          details: { ok: true, executionId: result.executionId },
        }
      }

      const issueLines = result.issues
        .map((issue) => `- ${issue.message}`)
        .join('\n')
      return {
        content: [
          {
            type: 'text',
            text: `执行未发起，就绪校验未通过：\n${issueLines}\n请把以上原因以对话文本告知用户，不要重试执行，待用户修复后再发起。`,
          },
        ],
        details: { ok: false, issues: result.issues },
      }
    },
  }
}

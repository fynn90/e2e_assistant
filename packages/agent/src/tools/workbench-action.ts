/**
 * propose_action 工具（v16）：让 /agent 中的 Agent 请求平台发布一张**动作卡片**。
 *
 * 为什么需要这个工具：PRD ID-6/ID-7 要求「缺什么补什么」——未找到用例时给
 * 「创建 e2e SKILL」卡片、缺 SKILL.md 时给「生成 SKILL.md」卡片、缺脚本时给
 * 「生成 Playwright 脚本」卡片。这些**缺口只有 Agent 知道**（它读过候选与文档），
 * 而卡片必须由平台发布（要带 actionId、要落盘、要被点击接口消费）。
 *
 * 因此本工具是「Agent 的意图 → 平台的动作卡片」的唯一通道：Agent 说明要哪个动作、
 * 目标是哪个用例，平台校验后发布卡片并把结果回报给模型。
 *
 * 与执行工具的分工：`execute_test` 是**已经确定可执行**时的直接发起；
 * 本工具用于**还不能执行**时给用户下一步入口（生成、创建、重试），
 * 两者不可互相替代。
 *
 * 安全边界：skillId 若提供，必须是 9 位 [a-z0-9]；是否存在、动作是否适用于该
 * 用例，由宿主在平台边界内校验（PRD SEC-2）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TAgentWorkbenchAction } from '@authine-e2e-agent/types'

/**
 * 动作卡片请求的宿主端口：由 CLI 组合根注入。
 *
 * 实现方职责：校验动作与目标的合法性（ID 格式、存在性、产物缺口是否与动作相符）、
 * 生成文案、发布 `workbench_action` 块并把结果归一化返回。
 */
export interface IWorkbenchActionHost {
  /**
   * 请求发布一张动作卡片。
   *
   * @param input - 动作身份、目标 SKILL（创建动作时为 null）与可选补充说明。
   * @returns 发布结果；被拒绝时 message 说明原因（如目标不存在、动作与缺口不符）。
   * @throws 实现方可抛出结构化错误，由工具作为失败结果返回给模型。
   */
  requestAction(input: {
    action: TAgentWorkbenchAction
    skillId: string | null
    /** 补充说明（可选），如「脚本已被手工修改，重新生成将覆盖」。 */
    description?: string
    /**
     * 修复动作（v17 G2）的失败来源：失败所在的运行编号（报告目录名）。
     *
     * 服务端据此读出该次执行的失败摘要，作为生成 prompt 的一部分交给生成子会话
     *（G2a：输入是失败报告 + 当前脚本 + 用例数据，三者都在平台侧）。
     */
    reportRunId?: string
  }): Promise<{ ok: true; message: string } | { ok: false; message: string }>
}

/** propose_action 工具接受的参数 Schema。 */
const proposeActionParameters = Type.Object({
  /** 动作身份。 */
  action: Type.Union(
    [
      Type.Literal('create-skill'),
      Type.Literal('generate-skill-document'),
      Type.Literal('generate-playwright-script'),
      Type.Literal('update-playwright-script'),
      Type.Literal('execute-test'),
      Type.Literal('retry'),
      Type.Literal('repair-script'),
    ],
    {
      description:
        '要给用户的动作入口：create-skill（未找到用例、询问是否创建时）、generate-skill-document（缺 SKILL.md）、generate-playwright-script（缺脚本）、update-playwright-script（已有脚本需要重新生成）、execute-test（产物齐备、可直接执行）、retry（上一次生成失败后重试）、repair-script（执行失败后，基于失败报告修复脚本；**必须带 reportRunId**）。',
    },
  ),
  /** 目标 SKILL ID；create-skill 时不需要。 */
  skillId: Type.Optional(
    Type.String({
      description:
        '目标 e2e 用例的九位唯一 ID（[a-z0-9]）。除 create-skill 外都必须提供，且必须是 list_skills 返回的候选 ID。',
    }),
  ),
  /** 补充说明。 */
  description: Type.Optional(
    Type.String({
      description:
        '给用户看的一句话补充说明（可选），如「脚本已被手工修改，重新生成将覆盖」。不要在此写大段解释。',
    }),
  ),
  reportRunId: Type.Optional(
    Type.String({
      description:
        'repair-script 专用：失败所在运行的编号（yyyyMMdd-HHmmss，见执行历史或报告卡片上的运行编号）。必须提供——平台据此读失败报告作为修复输入。',
    }),
  ),
})

/** propose_action 工具返回的结构化详情。 */
export interface ProposeActionDetails {
  ok: boolean
  action: TAgentWorkbenchAction
  skillId?: string
}

/**
 * 创建请求发布动作卡片的工具。
 *
 * @param host - CLI 组合根注入的动作宿主。
 * @returns 可直接配置到 AgentTool[] 的 propose_action 工具。
 * @throws 不在创建阶段抛出异常；宿主的错误由工具作为失败结果返回给模型。
 */
export function createProposeActionTool(
  host: IWorkbenchActionHost,
): AgentTool<typeof proposeActionParameters, ProposeActionDetails> {
  return {
    name: 'propose_action',
    label: '给出下一步入口',
    description:
      '在对话流中发布一张可供用户点击的动作卡片（创建用例 / 生成文档 / 生成脚本 / 重新生成 / 执行测试 / 重试 / 修复脚本）。当你判断用户需要的下一步动作**还不能由你直接发起**时使用：未找到用例要给创建入口、产物不完整要先补产物、生成失败要给重试入口、**执行失败要给修复入口**。不要用它代替 execute_test 发起已经就绪的执行。\n\n用 repair-script 时**必须同时给出 reportRunId**（失败所在运行的编号，见执行历史或报告卡片上的「运行编号」）——没有它，平台读不到失败报告，修复就退化成一次普通的重新生成。发起修复前请用文本说明「将基于失败信息重新生成整份脚本」。',
    parameters: proposeActionParameters,
    executionMode: 'sequential',
    /**
     * 经宿主发布动作卡片。
     *
     * @param _toolCallId - 当前工具调用标识；本工具不使用。
     * @param parameters - 已校验的调用参数（action 必填，skillId 视动作而定）。
     * @param _signal - 取消信号；本工具不使用（发布为本地短操作）。
     * @param _onUpdate - 流式进度回调；本工具无中间进度。
     * @returns 包含发布结果的工具结果（模型可见文本 + 结构化详情）。
     * @throws 宿主抛出的错误透传，由运行器记为工具失败。
     */
    async execute(_toolCallId, parameters, _signal, _onUpdate) {
      void _toolCallId
      void _signal
      void _onUpdate

      const skillId = parameters.skillId?.trim() ?? ''
      // 除创建动作外，目标必填——缺目标的卡片点了也不知道该做什么。
      if (parameters.action !== 'create-skill' && skillId.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '该动作需要目标用例的唯一 ID。请先用 list_skills 取得候选，再带上目标 ID 重试。',
            },
          ],
          details: { ok: false, action: parameters.action },
        }
      }

      const reportRunId = parameters.reportRunId?.trim() ?? ''
      // 修复动作必须有失败来源：没有它，「修复」就退化成一次普通的重新生成，
      // 生成子会话也无从知道要修什么（G2a 的输入要求）。
      if (parameters.action === 'repair-script' && reportRunId.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '修复脚本需要失败所在运行的编号（reportRunId）。请从执行历史或报告卡片上取到运行编号（形如 20261009-143012）后重试；若该次执行没有生成报告，说明失败发生在启动阶段，应改用 update-playwright-script。',
            },
          ],
          details: { ok: false, action: parameters.action },
        }
      }

      const result = await host.requestAction({
        action: parameters.action,
        skillId: skillId.length > 0 ? skillId : null,
        ...(parameters.description
          ? { description: parameters.description }
          : {}),
        ...(reportRunId ? { reportRunId } : {}),
      })

      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `${result.message}\n请如实告知用户，并调整做法后重试；不要编造一个已经出现的入口。`,
            },
          ],
          details: {
            ok: false,
            action: parameters.action,
            ...(skillId ? { skillId } : {}),
          },
        }
      }

      return {
        content: [{ type: 'text', text: result.message }],
        details: {
          ok: true,
          action: parameters.action,
          ...(skillId ? { skillId } : {}),
        },
      }
    },
  }
}

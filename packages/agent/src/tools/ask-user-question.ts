/**
 * ask_user_question 工具：AskUserQuestion 的 Agent 侧发问入口。
 *
 * 用途：Agent 在缺少关键信息、面对多种合理解释或对某个决策没有把握时，
 * 向用户发起阻塞式提问以校准意图，而不是靠猜测继续。提问是**通用能力**，
 * 平台不预设主题——具体什么情况下必须问、候选项怎么给、答案如何解释，
 * 由各 Skill 指令约束（例如视觉基准缺目录或图片时必须先问，B6/B8/A13）。
 *
 * 形态：questions 恰 1 项 → 单问题卡片；2-4 项 → 多问题卡片，一张卡片一次问完，
 * 不拆多轮追问。每个问题由 Agent 给出 2-5 个候选项，平台自动在末尾追加固定
 * 「其它」选项承载自定义输入，Agent 不得自行提供「其它」（A17）。
 *
 * 阻塞语义：提问卡片不提供取消出口——用户必须给出回答，Agent 才能继续下一轮工作。
 * 等待**不设超时**（禁止超时自动取默认值）。唯一的退出方式是会话中止或客户端断开，
 * 此时等待被中断、工具以失败告终，由会话的既有取消路径收尾。
 * cancelled 只在异常路径产生（回答格式与形态不符、回答为空、回答 API 直调），
 * 收到它时模型不得就本次提问涉及的信息自行假设或继续推进相关操作。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  askUserRegistry,
  type AskUserQuestionDetails,
  type IAskUserHost,
} from './ask-user-question-registry'

/**
 * ask_user_question 工具接受的参数 Schema。
 *
 * 导出供测试断言数量硬校验（options 2-5 项 / questions 1-4 项）。
 */
export const askUserQuestionParameters = Type.Object({
  /** 卡片标题；缺省时平台用默认标题。 */
  title: Type.Optional(
    Type.String({
      description:
        '卡片标题，一句话概括这次要确认什么，如「请确认视觉基准信息」。缺省用平台默认标题。',
    }),
  ),
  /**
   * 问题与候选项：每个问题给出 2-5 个候选项，平台校验数量并自动在末尾追加固定
   * 「其它」选项，Agent 不得自行提供「其它」（A17）。
   * 只缺一项信息时给 1 个问题；同时缺多项时一次问完（最多 4 个），不要拆多轮追问。
   */
  questions: Type.Array(
    Type.Object({
      /** 问题文案，如「基准目录」「需要覆盖哪些浏览器」。 */
      label: Type.String({
        description: '问题文案，如「基准目录」「需要覆盖哪些浏览器」。',
      }),
      /** 候选项 2-5 项（不含「其它」，数量由 minItems/maxItems 硬校验）。 */
      options: Type.Array(
        Type.Object({
          /** 展示文案。 */
          label: Type.String({ description: '选项展示文案。' }),
          /** 选项值：用户选中后原样回传给你，语义由你与 Skill 约定。 */
          value: Type.String({
            description:
              '选项值：用户选中后原样回传给你的字符串。路径类问题给相对路径，其它问题给便于你后续直接使用的值。',
          }),
          /** 补充说明。 */
          description: Type.Optional(
            Type.String({ description: '选项补充说明。' }),
          ),
        }),
        { minItems: 2, maxItems: 5 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
  /** 提问说明：向用户解释为什么需要补充这些信息（展示在卡片 description）。 */
  context: Type.String({
    description:
      '提问说明：向用户解释为什么需要补充这些信息，以及不补充会有什么影响。',
  }),
})

/**
 * 创建「向用户提问」的 Agent 工具。
 *
 * @param host - 本次会话绑定的发问宿主（由注册表按会话解析后传入）。
 * @returns 可直接配置到 AgentTool[] 的 ask_user_question 工具。
 * @throws 不在创建阶段抛出异常；宿主未注册、问题结构校验失败或会话中止时
 *   由 execute 抛出结构化错误，由运行器记为工具失败。
 */
export function createAskUserQuestionTool(
  host: IAskUserHost,
): AgentTool<typeof askUserQuestionParameters, AskUserQuestionDetails> {
  return {
    name: 'ask_user_question',
    label: '向用户提问',
    description:
      '当你缺少完成任务的关键信息、用户的表述存在多种合理解释、或你对某个决策没有把握时，用本工具向用户发起阻塞式提问以校准意图，不要靠猜测继续。每个问题需给出 2-5 个候选项（由你分析给出），平台会自动追加「其它」选项支持自定义输入；同时缺多项信息时用一张卡片一次问完（最多 4 个问题），不要拆成多轮追问。提问期间不要执行依赖这些答案的操作（如创建目录、覆盖文件、捕获基线）。当前 Skill 若对特定场景规定了必须提问的情形与候选项要求，以 Skill 指令为准。',
    parameters: askUserQuestionParameters,
    // 提问会阻塞整个会话（等待用户回答），必须串行执行。
    executionMode: 'sequential',
    /**
     * 调用宿主发起提问并等待回答。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的标题、问题与候选项、提问说明。
     * @param signal - 取消信号；实际取消由宿主经会话中止统一处理。
     * @param onUpdate - 流式进度回调；单次提问无中间进度。
     * @returns 归一化的提问结果（answered / cancelled 两态）。
     * @throws 宿主未注册或问题结构校验失败时抛出，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const details = await host.ask({
        questions: parameters.questions,
        context: parameters.context,
        ...(parameters.title ? { title: parameters.title } : {}),
      })

      return {
        content: [{ type: 'text', text: formatDetailsText(details) }],
        details,
      }
    },
  }
}

/**
 * 按会话解析 ask_user_question 工具集合（供 Agent 配置工厂调用）。
 *
 * @param sessionId - 当前会话 ID；未提供或未登记宿主时返回空数组。
 * @returns 已授权会话对应的提问工具；未授权时返回空数组。
 * @throws 不抛出异常。
 */
export function createSessionAskTools(
  sessionId: string | undefined,
): AgentTool<any>[] {
  if (!sessionId) {
    return []
  }

  const host = askUserRegistry.get(sessionId)
  return host ? [createAskUserQuestionTool(host)] : []
}

/**
 * 把提问结果组织为模型可读的文本。
 *
 * 提问卡片不提供取消出口（用户必须给出回答才能继续），因此 cancelled 只在
 * 异常路径产生：回答格式与形态不符、回答为空、或绕过前端的回答 API 直调。
 * 文案据此说明「没拿到可用回答」而非「用户拒绝回答」，避免模型误判用户意图；
 * 回答时逐题列出用户的选择，由模型按 Skill 规则解释这些答案。
 *
 * @param details - 宿主返回的归一化结果。
 * @returns 文本内容。
 * @throws 不抛出异常。
 */
function formatDetailsText(details: AskUserQuestionDetails): string {
  if (details.status === 'cancelled') {
    const reason = details.reason ? `原因：${details.reason}。` : ''
    return (
      `本次提问没有拿到可用的回答。${reason}` +
      '不要就本次提问涉及的信息自行假设，也不要继续执行依赖这些答案的操作。' +
      '可以修正问法后重新发起提问；如果当前 Skill 约定了「断点」小节，' +
      '请在最终回复中说明缺少哪些信息及其影响。'
    )
  }

  if (details.answers.length === 0) {
    return '用户已提交，但没有可用的回答内容。请按 Skill 规则决定是否重新发起提问。'
  }

  return [
    '用户已回答：',
    ...details.answers.map((answer) => `- ${answer.label}：${answer.value}`),
    '请按当前 Skill 的规则解释以上答案并继续任务。',
  ].join('\n')
}

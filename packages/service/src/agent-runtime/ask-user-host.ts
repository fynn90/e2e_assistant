/**
 * AskUserQuestion 的 CLI 宿主实现。
 *
 * 职责：把 Agent 侧 `ask_user_question` 工具的提问请求落成一次真实的前端交互——
 *   1. 校验 Agent 给出的问题结构（结构合法性：候选数量、不得自带「其它」；
 *      非法时向工具调用返回明确错误让模型自修复，不产生用户侧坏卡片）；
 *   2. 追加固定「其它」选项并组装单问题/多问题卡片，经事件总线发布 interaction begin；
 *   3. 挂起等待用户回答（不设超时——等待只被回答或会话中止终结）；
 *   4. 回答归一化：把「所选选项值 / 其它自定义文本」收敛为逐题回答，
 *      前端只做提示、不做合并；发布 interaction end 并返回结构化结果。
 *
 * 宿主是**主题无关**的：它不理解答案的领域语义（路径规则、默认值取舍等），
 * 这些约束由各 Skill 指令承载、由模型自行遵守。领域校验之所以可以不在平台侧做，
 * 是因为下游落盘入口各自独立守边界（skill-manager 的 normalizeBaselineUserPath、
 * file-create、执行期 user-workspace-fs-validator），模型给出非法路径会被拒。
 *
 * 提问不提供取消出口：拿到答案才能继续下一轮工作，前端卡片也只提供完整回答
 * 一条路径（答完即自动提交）。中止是唯一出口——会话中止或客户端断开时等待被
 * reject，卡片定格为 aborted 并向上抛出，全程零落盘。回答 API 是公开的，故
 * normalizeAnswer 仍保留对取消哨兵的兜底归一，防止绕过前端的直调让模型收到
 * 无法解释的原始值。
 */

import { randomUUID } from 'node:crypto'
import {
  INTERACTION_CANCEL_ANSWER,
  INTERACTION_OTHER_OPTION_VALUE,
  type IAgentInteraction,
  type IAgentInteractionQuestion,
} from '@charlie_deng/e2e-assistant-types'
import type {
  AskUserQuestionDetails,
  IAskUserHost,
  IAskUserAnswer,
  IAskUserQuestionItem,
} from '@charlie_deng/e2e-assistant-agent'
import type { IAgentWorkRuntime } from './agent-work-runtime'

/** 缺省卡片标题（Agent 未传 title 时使用；标题不含任何领域语义）。 */
const DEFAULT_CARD_TITLE = '需要你确认一些信息'

/** 缺省的「其它」输入框占位文案。 */
const DEFAULT_OTHER_PLACEHOLDER = '输入你的回答…'

/** 宿主构造依赖。 */
export interface IAskUserHostDependencies {
  /**
   * 惰性解析工作通道运行时：事件总线与交互等待。
   *
   * 必须是**惰性**的——注册宿主发生在 Agent 会话创建之前，若在此处急迫
   * getRuntime 会为「从不真正发问」的会话打开工作区的 SQLite 句柄且无人释放
   * （Windows 上导致临时目录 EBUSY）。等到 Agent 真正调用 ask_user_question 时
   * 再解析：此刻会话已创建，getRuntime 命中同一缓存实例，前端订阅的正是这条总线。
   *
   * 在 agent-work-runtime 内部注册时可直接传自身（见 registerAskHost）。
   */
  resolveRuntime: () => IAgentWorkRuntime
  /** 所属会话 ID。 */
  sessionId: string
}

/**
 * 创建绑定到单个会话的 AskUserQuestion 宿主。
 *
 * @param deps - 运行时解析器与会话 ID。
 * @returns 实现-agent 包 IAskUserHost 端口的宿主实例。
 * @throws 不在创建阶段抛出异常；ask 过程中的校验失败、取消与中止见该方法的异常说明。
 */
export function createAskUserHost (
  deps: IAskUserHostDependencies,
): IAskUserHost {
  return {
    async ask (input): Promise<AskUserQuestionDetails> {
      // 1. 结构校验：拒绝时抛出明确错误，让模型修正后重新发起。
      validateAskInput(input)

      // 惰性解析运行时：此刻 Agent 已真正发问，会话必已创建，
      // getRuntime 命中缓存返回前端订阅的同一实例（见依赖说明）。
      const runtime = deps.resolveRuntime()

      // 2. 追加「其它」并组装卡片（问题 ID 由本模块合成，前端与回答表共用）。
      const questionIds = input.questions.map(() => randomUUID())
      const interaction = buildInteraction(input, questionIds)
      const interactionId = interaction.interactionId
      const blockId = randomUUID()
      const timestamp = Date.now()

      runtime.bus.publish({
        type: 'interaction',
        phase: 'begin',
        interaction,
        sessionId: deps.sessionId,
        blockId,
        timestamp,
      })

      // 3. 挂起等待回答（不设超时；中止时 reject → 会话取消路径）。
      let rawAnswer: string | Record<string, string>
      try {
        rawAnswer = await runtime.waitForInteractionAnswer(
          deps.sessionId,
          interactionId,
        )
      } catch (error) {
        // 会话中止：把卡片定格为 aborted（时间线不再悬挂 pending），再向上抛出
        // 让工具失败、会话按既有取消路径收尾——全程零落盘。
        runtime.bus.publish({
          type: 'interaction',
          phase: 'end',
          interactionId,
          answer: INTERACTION_CANCEL_ANSWER,
          answeredBy: 'aborted',
          sessionId: deps.sessionId,
          blockId,
          timestamp: Date.now(),
        })
        throw error
      }

      // 4. 回答归一化（按提问顺序对齐，供模型直接阅读）。
      const details = normalizeAnswer(input, rawAnswer, questionIds)

      // 5. 定格卡片并返回。
      runtime.bus.publish({
        type: 'interaction',
        phase: 'end',
        interactionId,
        answer: rawAnswer,
        answeredBy: 'user',
        sessionId: deps.sessionId,
        blockId,
        timestamp: Date.now(),
      })

      return details
    },
  }
}

/**
 * 校验 Agent 给出的提问输入的结构合法性。
 *
 * 只校验结构，不校验答案的领域语义（后者由 Skill 指令约束模型）。
 *
 * @param input - 工具透传的提问输入。
 * @returns 无返回值；校验通过时静默结束。
 * @throws Error 任何校验失败时抛出携带修正指引的错误（向模型返回，不产生用户侧卡片）。
 */
function validateAskInput (input: Parameters<IAskUserHost['ask']>[0]): void {
  if (input.questions.length === 0 || input.questions.length > 4) {
    throw new Error(
      `一次提问需要 1-4 个问题，实际给了 ${input.questions.length} 个；` +
      '同时缺多项信息时用一张卡片一次问完，不要拆成多轮追问。',
    )
  }

  input.questions.forEach((question, index) => {
    if (!question.label.trim()) {
      throw new Error(`第 ${index + 1} 个问题的文案不能为空。`)
    }

    if (question.options.length < 2 || question.options.length > 5) {
      throw new Error(
        `第 ${index + 1} 个问题（${question.label}）的候选项数量必须为 2-5 项` +
        '（不含平台自动追加的「其它」）。',
      )
    }

    for (const option of question.options) {
      // Agent 不得自行提供「其它」（平台自动追加）。
      if (
        option.value === INTERACTION_OTHER_OPTION_VALUE ||
        option.label === '其它'
      ) {
        throw new Error(
          '不得自行提供「其它」选项；平台会自动在每个问题末尾追加。',
        )
      }

      if (!option.value.trim() || !option.label.trim()) {
        throw new Error(
          `第 ${index + 1} 个问题（${question.label}）的候选项文案与值都不能为空。`,
        )
      }
    }
  })
}

/**
 * 把 Agent 问题组装为交互卡片（恰 1 题用顶层字段，多题用 questions 形态）。
 *
 * 两种形态都**不提供「不继续」取消出口**：提问的语义是「拿到答案才能继续下一轮
 * 工作」，给取消出口等于允许跳过关键决策，与提问的初衷相悖。前端配合卡片自身的
 * 完整性校验（每题必须选中或填「其它」才能作答），用户只能给出完整回答。
 * 退出仍有出口：中止会话或断开客户端连接，宿主据此把卡片定格为 aborted 并抛出
 * （见 ask 的异常处理），不会永久挂起。
 *
 * `source` 标记让前端按来源分发组件，不必靠标题或选项特征嗅探卡片类型。
 *
 * @param input - 已校验的提问输入。
 * @param questionIds - 与 input.questions 一一对应的问题 ID（回答表的键）。
 * @returns 可发布到事件总线的交互元信息（含追加「其它」后的选项）。
 * @throws 不抛出异常。
 */
function buildInteraction (
  input: Parameters<IAskUserHost['ask']>[0],
  questionIds: string[],
): IAgentInteraction {
  const title = input.title?.trim() || DEFAULT_CARD_TITLE

  // 单问题形态：顶层 options（一问一组候选 + 「其它」）。
  if (input.questions.length === 1) {
    return {
      interactionId: randomUUID(),
      kind: 'choice',
      source: 'ask-user-question',
      title,
      description: input.context,
      options: withOtherOption(input.questions[0].options),
    }
  }

  // 多问题形态：一问一个 tab，全部答完一次性提交。
  return {
    interactionId: randomUUID(),
    kind: 'choice',
    source: 'ask-user-question',
    title,
    description: input.context,
    questions: input.questions.map((question, index) =>
      toCardQuestion(questionIds[index], question),
    ),
  }
}

/**
 * 把 Agent 问题转换为卡片问题（追加「其它」）。
 *
 * @param questionId - 问题 ID（回答表键，由宿主合成）。
 * @param question - Agent 给出的问题。
 * @returns 卡片问题。
 * @throws 不抛出异常。
 */
function toCardQuestion (
  questionId: string,
  question: IAskUserQuestionItem,
): IAgentInteractionQuestion {
  return {
    questionId,
    label: question.label,
    options: withOtherOption(question.options),
    placeholder: DEFAULT_OTHER_PLACEHOLDER,
  }
}

/**
 * 在选项末尾追加固定「其它」选项。
 *
 * @param options - Agent 给出的候选。
 * @returns 追加「其它」后的选项列表。
 * @throws 不抛出异常。
 */
function withOtherOption (
  options: IAskUserQuestionItem['options'],
): IAgentInteractionQuestion['options'] {
  return [
    ...options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    { value: INTERACTION_OTHER_OPTION_VALUE, label: '其它', isOther: true },
  ]
}

/**
 * 把前端提交的原始回答归一为逐题回答（顺序与 questions 一致）。
 *
 * 单问题形态的原始回答是 string，多问题形态是以 questionId 为键的回答表；
 * 「其它」的自定义文本已由前端替换为文本本身，此处不再区分。
 *
 * @param input - 已校验的提问输入。
 * @param rawAnswer - 前端提交的原始回答。
 * @param questionIds - 与 input.questions 一一对应的问题 ID。
 * @returns 归一化结果；取消与格式异常返回 cancelled（answers 为空）。
 * @throws 不抛出异常。
 */
function normalizeAnswer (
  input: Parameters<IAskUserHost['ask']>[0],
  rawAnswer: string | Record<string, string>,
  questionIds: string[],
): AskUserQuestionDetails {
  // 取消哨兵：卡片不提供取消入口，此处只是对回答 API 直调的兜底
  // （整卡取消，无部分答案可用）。
  if (rawAnswer === INTERACTION_CANCEL_ANSWER) {
    return { status: 'cancelled', answers: [] }
  }

  // 单问题形态：原始回答即该题答案。
  if (input.questions.length === 1) {
    if (typeof rawAnswer !== 'string') {
      return cancelledWithInvalid('单问题形态的回答格式不正确。')
    }
    const value = rawAnswer.trim()
    if (!value) {
      return cancelledWithInvalid('回答内容为空；请重新发起提问。')
    }
    return {
      status: 'answered',
      answers: [{ label: input.questions[0].label, value }],
    }
  }

  // 多问题形态：按 questionId 逐题取值，缺任一题即视为格式异常。
  if (typeof rawAnswer !== 'object' || rawAnswer === null) {
    return cancelledWithInvalid('多问题形态的回答格式不正确。')
  }

  const answers: IAskUserAnswer[] = []
  for (let index = 0; index < input.questions.length; index += 1) {
    const value = rawAnswer[questionIds[index]]
    if (typeof value !== 'string' || !value.trim()) {
      return cancelledWithInvalid(
        `缺少「${input.questions[index].label}」的回答；请重新发起提问。`,
      )
    }
    answers.push({ label: input.questions[index].label, value: value.trim() })
  }

  return { status: 'answered', answers }
}

/**
 * 构造带原因的取消结果（非法输入兜底，前端即时校验已基本杜绝）。
 *
 * @param reason - 面向模型的取消原因。
 * @returns cancelled 结果。
 * @throws 不抛出异常。
 */
function cancelledWithInvalid (reason: string): AskUserQuestionDetails {
  return { status: 'cancelled', reason, answers: [] }
}

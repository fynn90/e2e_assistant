/**
 * AskUserQuestion 卡片的作答草稿：单问题与多问题形态共用的「先填写、后提交」状态机。
 *
 * 与组件的关系：本 composable 只负责**作答状态与校验**（选了什么、还差哪些、
 * 能否提交、提交什么），不渲染任何内容；组件只管把它绑到界面上。这样两条形态
 * 的作答规则只写一遍，也不会因散落在模板里而漂移。
 *
 * 作答不再「点选即提交」（原 Q18）：用户可以先填一填、再回头改，点底部的提交
 * 按钮才作答。作答对象的构造因此需要区分两种形态：
 *   - 单问题形态：交出一个选项值，或「其它」的输入原文；
 *   - 多问题形态：交出以 questionId 为键的回答表，且**已作答的 Key 必须来自
 *     最初的问题列表**——回答表是直接回传服务端并绑定到本次交互的，
 *     必须挡住调用方混入未知键的路径，避免把脏数据发给服务端。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  INTERACTION_OTHER_OPTION_VALUE,
  INTERACTION_OTHER_TEXT_LIMIT,
  type IAgentInteractionOption,
  type IAgentInteractionQuestion,
} from '@fynn90-e2e_assistant/types'

/** 作答草稿的对外接口。 */
export interface IAskUserQuestionDraft {
  /** 各题已填的选项值（«其它» 存哨兵值；单问题形态的键为 ''）。 */
  selections: Ref<Record<string, string>>
  /** 各题「其它」输入框的原文。 */
  otherTexts: Ref<Record<string, string>>
  /**
   * 取某题当前的作答值：未作答返回 undefined；『其它』有内容时返回其原文。
   *
   * 这是「该题填完了吗」的唯一判据，也是最终回答表里每题的取值来源。
   */
  answerOf: (questionKey: string) => string | undefined
  /** 取某题选中的选项值（未选中为 ''），用于把选中态绑到界面上。 */
  selectionOf: (questionKey: string) => string
  /** 取某题「其它」输入框的原文（未填为 ''），用于受控绑定输入框。 */
  otherTextOf: (questionKey: string) => string
  /** 某题是否已填完（可据此打勾、算进度）。 */
  isAnswered: (questionKey: string) => boolean
  /** 未填完的题数。 */
  remaining: ComputedRef<number>
  /** 能否提交（所有题都已填完）。 */
  canSubmit: ComputedRef<boolean>
  /** 记录某题选中的选项（含「其它」哨兵）。 */
  setSelection: (questionKey: string, value: string) => void
  /** 记录某题「其它」输入框的原文。 */
  setOtherText: (questionKey: string, text: string) => void
}

/**
 * 创建一个作答草稿。
 *
 * @param questions - 题目列表；空数组即单问题形态（键为 '' 的单条记录）。
 * @returns 作答草稿接口。
 * @throws 不抛出异常。
 */
export function useAskUserQuestionDraft (
  questions: ComputedRef<IAgentInteractionQuestion[]>,
): IAskUserQuestionDraft {
  const selections = ref<Record<string, string>>({})
  const otherTexts = ref<Record<string, string>>({})

  /** 待作答的题键列表：多问题为各 questionId，单问题形态为单个 ''。 */
  const keys = computed<string[]>(() =>
    questions.value.length > 0
      ? questions.value.map((question) => question.questionId)
      : [''],
  )

  /**
   * 取某题当前生效的作答值。
   *
   * @param questionKey - 题键（单问题为 ''）。
   * @returns 选项值 / 「其它」原文；未作答时 undefined。
   * @throws 不抛出异常。
   */
  function answerOf (questionKey: string): string | undefined {
    const selection = selections.value[questionKey]
    if (selection === undefined) return undefined
    if (selection !== INTERACTION_OTHER_OPTION_VALUE) return selection

    // 「其它」：输入原文才是答案，空白视为尚未作答（提交时另有长度下限兜底）。
    const text = (otherTexts.value[questionKey] ?? '').trim()
    return text.length > 0 ? text : undefined
  }

  /**
   * 某题是否已填完。
   *
   * @param questionKey - 题键。
   * @returns 已填完为 true。
   * @throws 不抛出异常。
   */
  function isAnswered (questionKey: string): boolean {
    return answerOf(questionKey) !== undefined
  }

  const remaining = computed(
    () => keys.value.filter((key) => !isAnswered(key)).length,
  )
  const canSubmit = computed(() => remaining.value === 0)

  /**
   * 记录某题选中的选项。
   *
   * @param questionKey - 题键。
   * @param value - 选项值（「其它」为哨兵值）。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function setSelection (questionKey: string, value: string): void {
    selections.value = { ...selections.value, [questionKey]: value }
  }

  /**
   * 记录某题「其它」输入框的原文。
   *
   * @param questionKey - 题键。
   * @param text - 输入原文。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function setOtherText (questionKey: string, text: string): void {
    otherTexts.value = { ...otherTexts.value, [questionKey]: text }
  }

  /**
   * 取某题选中的选项值。
   *
   * @param questionKey - 题键。
   * @returns 选项值；未选中时为空串。
   * @throws 不抛出异常。
   */
  function selectionOf (questionKey: string): string {
    return selections.value[questionKey] ?? ''
  }

  /**
   * 取某题「其它」输入框的原文。
   *
   * @param questionKey - 题键。
   * @returns 输入原文；未填时为空串。
   * @throws 不抛出异常。
   */
  function otherTextOf (questionKey: string): string {
    return otherTexts.value[questionKey] ?? ''
  }

  return {
    selections,
    otherTexts,
    answerOf,
    selectionOf,
    otherTextOf,
    isAnswered,
    remaining,
    canSubmit,
    setSelection,
    setOtherText,
  }
}

/**
 * 把作答草稿组装为提交给服务端的回答。
 *
 * @param questions - 题目列表；为空即单问题形态。
 * @param answerOf - 取某题作答值的函数（见 `useAskUserQuestionDraft`）。
 * @returns 单问题形态为该题的作答值；多问题形态为以 questionId 为键的回答表。
 * @throws Error 存在未作答的题，或「其它」内容为空、超长时抛出。
 */
export function buildAskUserQuestionAnswer (
  questions: IAgentInteractionQuestion[],
  answerOf: (questionKey: string) => string | undefined,
): string | Record<string, string> {
  if (questions.length === 0) {
    const value = answerOf('')
    if (value === undefined) throw new Error('还没有作答，不能提交。')
    return value
  }

  const answer: Record<string, string> = {}
  for (const question of questions) {
    const value = answerOf(question.questionId)
    if (value === undefined) {
      throw new Error(`「${question.label}」还没有作答，不能提交。`)
    }
    // 键取自问题列表，提交值只可能来自这一轮的问法。
    answer[question.questionId] = value
  }
  return answer
}

/**
 * 取某题「其它」输入框的即时校验错误；没有错误时返回 undefined。
 *
 * 空内容**不算错误**：刚展开时输入框必然是空的，此时标红等于在用户还没动手
 * 之前就先指责他一次；空内容只让提交按钮不可用，并用中性的必填提示说明原因。
 *
 * @param option - 该题被选中的选项；非「其它」时无校验可言。
 * @param text - 「其它」输入框的原文。
 * @returns 超长时的错误文案；否则 undefined。
 * @throws 不抛出异常。
 */
export function otherTextError (
  option: IAgentInteractionOption | undefined,
  text: string,
): string | undefined {
  if (option?.isOther !== true) return undefined
  if (text.trim().length > INTERACTION_OTHER_TEXT_LIMIT) {
    return `内容超过 ${INTERACTION_OTHER_TEXT_LIMIT} 字符上限。`
  }
  return undefined
}

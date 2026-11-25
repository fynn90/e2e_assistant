/**
 * AskUserQuestion 作答草稿（composables/useAskUserQuestionDraft）的单元测试。
 *
 * 这一层是卡片的作答规则中枢：选了什么、还差几题、能否提交、提交什么。
 * 组件测试覆盖的是「界面绑对了没有」，本文件覆盖规则本身——尤其是
 * 「提交前可改答」这条：改答必须是**覆盖**而非追加，且最后一次选择生效。
 */

import { computed } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildAskUserQuestionAnswer,
  otherTextError,
  useAskUserQuestionDraft,
} from '../../src/modules/agent-work/composables/useAskUserQuestionDraft'
import type { IAgentInteractionQuestion } from '@charlie_deng/e2e-assistant-types'

/** 造一份多问题形态的题目列表。 */
function makeQuestions (): IAgentInteractionQuestion[] {
  return [
    {
      questionId: 'q1',
      label: '基准目录',
      options: [
        { value: 'baselines', label: '默认目录' },
        { value: '__other__', label: '其它', isOther: true },
      ],
    },
    {
      questionId: 'q2',
      label: '基准图片',
      options: [
        { value: 'a.png', label: 'a.png' },
        { value: '__other__', label: '其它', isOther: true },
      ],
    },
  ]
}

/** 建一个绑定到指定题目的草稿。 */
function makeDraft (questions: IAgentInteractionQuestion[]) {
  return useAskUserQuestionDraft(computed(() => questions))
}

describe('作答草稿：单问题形态', () => {
  it('未作答时取不到答案，也不能提交', () => {
    const draft = makeDraft([])

    expect(draft.answerOf('')).toBeUndefined()
    expect(draft.remaining.value).toBe(1)
    expect(draft.canSubmit.value).toBe(false)
  })

  it('选中候选项后即可提交，答案即该选项值', () => {
    const draft = makeDraft([])
    draft.setSelection('', 'preview')

    expect(draft.answerOf('')).toBe('preview')
    expect(draft.canSubmit.value).toBe(true)
    expect(buildAskUserQuestionAnswer([], draft.answerOf)).toBe('preview')
  })

  it('「其它」以输入原文为答案，空内容视为未作答', () => {
    const draft = makeDraft([])
    draft.setSelection('', '__other__')

    // 只选了「其它」还没填内容：不算作答。
    expect(draft.answerOf('')).toBeUndefined()
    expect(draft.canSubmit.value).toBe(false)

    draft.setOtherText('', '  自定义值  ')
    expect(draft.answerOf('')).toBe('自定义值')
    expect(draft.canSubmit.value).toBe(true)
  })
})

describe('作答草稿：多问题形态', () => {
  it('逐题记录，未全部填完时不能提交', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')

    expect(draft.remaining.value).toBe(1)
    expect(draft.canSubmit.value).toBe(false)
  })

  it('全部填完后可提交，回答表以 questionId 为键', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')
    draft.setSelection('q2', 'a.png')

    expect(draft.canSubmit.value).toBe(true)
    expect(buildAskUserQuestionAnswer(makeQuestions(), draft.answerOf)).toEqual(
      {
        q1: 'baselines',
        q2: 'a.png',
      },
    )
  })

  it('改答是覆盖而非追加，最后一次选择生效', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')
    draft.setSelection('q1', 'preview')

    expect(draft.answerOf('q1')).toBe('preview')
  })

  it('从候选项改成「其它」时，改由输入原文作答', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')
    draft.setSelection('q1', '__other__')
    draft.setOtherText('q1', '自定义目录')

    expect(draft.answerOf('q1')).toBe('自定义目录')
  })

  it('从「其它」改回候选项时，忽略遗留的输入原文', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', '__other__')
    draft.setOtherText('q1', '写了又改主意')
    draft.setSelection('q1', 'baselines')

    expect(draft.answerOf('q1')).toBe('baselines')
  })

  it('存在未作答的题时构建回答会抛出，错误指明是哪一题', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')

    expect(() =>
      buildAskUserQuestionAnswer(makeQuestions(), draft.answerOf),
    ).toThrow(/基准图片/)
  })

  it('回答表的键只可能来自问题列表：未登记的题键不会混进结果', () => {
    const draft = makeDraft(makeQuestions())
    draft.setSelection('q1', 'baselines')
    draft.setSelection('q2', 'a.png')
    // 混入一个不属于本次提问的键（例如上层状态串了）。
    draft.setSelection('q-unknown', 'x')

    expect(
      Object.keys(buildAskUserQuestionAnswer(makeQuestions(), draft.answerOf)),
    ).toEqual(['q1', 'q2'])
  })
})

describe('「其它」文本校验', () => {
  const other = { value: '__other__', label: '其它', isOther: true }

  it('非「其它」选项不参与校验', () => {
    expect(
      otherTextError({ value: 'a', label: 'A' }, 'x'.repeat(3000)),
    ).toBeUndefined()
    // 未选中任何选项时同样不校验。
    expect(otherTextError(undefined, 'x'.repeat(3000))).toBeUndefined()
  })

  it('空内容不判错（该由必填提示承担，不是错误）', () => {
    expect(otherTextError(other, '')).toBeUndefined()
    expect(otherTextError(other, '   ')).toBeUndefined()
  })

  it('超长返回错误文案', () => {
    expect(otherTextError(other, 'x'.repeat(2001))).toContain('字符上限')
    expect(otherTextError(other, 'x'.repeat(2000))).toBeUndefined()
  })
})

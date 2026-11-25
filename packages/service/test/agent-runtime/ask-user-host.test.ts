/**
 * AskUserQuestion 宿主的单元测试。
 *
 * 宿主是**主题无关**的，因此本文件只覆盖通用契约：
 *   - 结构校验（问题数量、候选数量、不得自带「其它」、文案非空）→ 拒绝时不产生坏卡片；
 *   - 卡片组装（追加 isOther「其它」、source 来源标记、单问题用顶层 options、多问题用 questions）；
 *   - 回答归一化（单问题 string / 多问题按 questionId 取值，按提问顺序对齐）；
 *   - 取消哨兵、缺答兜底、会话中止定格。
 *
 * 不覆盖答案的领域语义（路径是否越界、是否 .png、基准是否已存在）——
 * 这些约束已下沉到 Skill 指令由模型遵守，落盘入口另有独立边界校验。
 */

import { describe, expect, it } from 'vitest'
import type {
  TAgentClientEventDraft,
  TAgentInteractionAnswer,
} from '@fynn90-e2e_assistant/types'
import type { IAskUserHost } from '@fynn90-e2e_assistant/agent'
import type { IAgentWorkRuntime } from '../../src/agent-runtime'
import { createAskUserHost } from '../../src/agent-runtime/ask-user-host'

/** interaction begin 事件的判别守卫（begin/end 两态联合需要 phase 收窄）。 */
type TInteractionBeginEvent = Extract<
  TAgentClientEventDraft,
  { type: 'interaction'; phase: 'begin' }
>

/**
 * 判别 interaction begin 事件。
 *
 * @param event - 总线事件草稿。
 * @returns 是 begin 事件时返回 true（同时完成类型收窄）。
 * @throws 不抛出异常。
 */
function isInteractionBegin (
  event: TAgentClientEventDraft,
): event is TInteractionBeginEvent {
  return event.type === 'interaction' && event.phase === 'begin'
}

/** 从事件流中取第一条 interaction begin 事件（未定义时断言失败）。 */
function firstInteractionBegin (
  events: TAgentClientEventDraft[],
): TInteractionBeginEvent {
  const begin = events.find(isInteractionBegin)
  expect(begin).toBeDefined()
  return begin as TInteractionBeginEvent
}

/** 一次提问的可观测现场：发布的总线事件与可注入的回答/中止。 */
interface IAskHarness {
  host: IAskUserHost
  events: TAgentClientEventDraft[]
  answerWith (answer: TAgentInteractionAnswer): void
  /** 模拟会话中止：让等待中的提问以 reject 结束。 */
  abortWith (error: Error): void
}

/**
 * 构造可控的 fake 运行时与 ask 宿主。
 *
 * @returns 提问现场。
 */
function createHarness (): IAskHarness {
  const events: TAgentClientEventDraft[] = []
  let resolveAnswer!: (answer: TAgentInteractionAnswer) => void
  let rejectAnswer!: (error: Error) => void

  const runtime = {
    bus: {
      publish (event: TAgentClientEventDraft) {
        events.push(event)
      },
    },
    waitForInteractionAnswer: () =>
      new Promise<TAgentInteractionAnswer>((resolve, reject) => {
        resolveAnswer = resolve
        rejectAnswer = reject
      }),
  } as unknown as IAgentWorkRuntime

  return {
    host: createAskUserHost({
      resolveRuntime: () => runtime,
      sessionId: 'session-1',
    }),
    events,
    answerWith: (answer) => resolveAnswer(answer),
    abortWith: (error) => rejectAnswer(error),
  }
}

/** 合法的多问题输入。 */
function buildTwoQuestionInput () {
  return {
    questions: [
      {
        label: '基准目录',
        options: [
          { label: '使用默认目录 userWorkSpace/baselines', value: 'baselines' },
          { label: 'preview 目录', value: 'preview' },
        ],
      },
      {
        label: '基准图片',
        options: [
          { label: 'preview/template.png', value: 'preview/template.png' },
          { label: 'candidate-a.png', value: 'candidate-a.png' },
        ],
      },
    ],
    context: '测试步骤要求视觉对比，但基准目录与图片都未指明。',
  }
}

/** 合法的单问题输入。 */
function buildOneQuestionInput () {
  return {
    questions: [
      {
        label: '需要覆盖哪些浏览器',
        options: [
          { label: '仅 Chromium', value: 'chromium' },
          { label: 'Chromium 与 Firefox', value: 'chromium,firefox' },
        ],
      },
    ],
    context: '用例未说明浏览器范围，选错会导致脚本覆盖不足。',
  }
}

/**
 * 从 begin 事件取出多问题形态各题的 questionId（由宿主随机合成，测试不可硬编码）。
 *
 * @param events - 已发布的总线事件。
 * @returns 与 questions 顺序一致的 questionId 数组。
 */
function questionIdsOf (events: TAgentClientEventDraft[]): string[] {
  const begin = firstInteractionBegin(events)
  return (begin.interaction.questions ?? []).map(
    (question) => question.questionId,
  )
}

describe('结构校验（拒绝时不产生用户侧坏卡片）', () => {
  it('问题数量越界被拒绝（1-4 题）', async () => {
    const harness = createHarness()
    const input = buildTwoQuestionInput()
    const question = input.questions[0]

    await expect(harness.host.ask({ ...input, questions: [] })).rejects.toThrow(
      /1-4 个问题/,
    )
    await expect(
      harness.host.ask({
        ...input,
        questions: Array.from({ length: 5 }, () => question),
      }),
    ).rejects.toThrow(/1-4 个问题/)

    // 校验失败不发布任何卡片事件。
    expect(harness.events).toEqual([])
  })

  it('Agent 自行提供「其它」选项被拒绝（A17）', async () => {
    const harness = createHarness()
    const input = buildTwoQuestionInput()
    input.questions[0].options.push({ label: '其它', value: '__other__' })

    await expect(harness.host.ask(input)).rejects.toThrow(/「其它」/)
    expect(harness.events).toEqual([])
  })

  it('候选项数量越界被拒绝（2-5 项）', async () => {
    const harness = createHarness()
    const input = buildTwoQuestionInput()
    input.questions[1].options = [{ label: 'only', value: 'a.png' }]

    await expect(harness.host.ask(input)).rejects.toThrow(/2-5 项/)
    expect(harness.events).toEqual([])
  })

  it('问题文案或候选项文案为空被拒绝', async () => {
    const emptyLabel = createHarness()
    await expect(
      emptyLabel.host.ask({
        questions: [
          {
            label: '   ',
            options: buildOneQuestionInput().questions[0].options,
          },
        ],
        context: '缺少信息。',
      }),
    ).rejects.toThrow(/文案不能为空/)
    expect(emptyLabel.events).toEqual([])

    const emptyOption = createHarness()
    await expect(
      emptyOption.host.ask({
        questions: [
          {
            label: '基准目录',
            options: [
              { label: '默认', value: 'baselines' },
              { label: '', value: 'preview' },
            ],
          },
        ],
        context: '缺少信息。',
      }),
    ).rejects.toThrow(/都不能为空/)
    expect(emptyOption.events).toEqual([])
  })

  it('答案的领域语义不做校验：越界路径也能正常发问（约束已下沉到 Skill）', async () => {
    const harness = createHarness()
    const input = buildTwoQuestionInput()
    // 这些值在改造前会被宿主拒绝；现在宿主不理解领域语义，原样透传给用户选择，
    // 非法路径会在真正落盘的入口（skill-manager / 执行期校验器）被拦。
    input.questions[0].options[1].value = '../outside'
    input.questions[1].options[1].value = 'bad name.txt'

    const pending = harness.host.ask(input)
    const begin = firstInteractionBegin(harness.events)
    expect(begin.interaction.questions?.[0]?.options?.[1]).toMatchObject({
      value: '../outside',
    })

    const ids = questionIdsOf(harness.events)
    harness.answerWith({ [ids[0]]: '../outside', [ids[1]]: 'bad name.txt' })

    const details = await pending
    expect(details.status).toBe('answered')
    expect(details.answers).toEqual([
      { label: '基准目录', value: '../outside' },
      { label: '基准图片', value: 'bad name.txt' },
    ])
  })
})

describe('卡片组装', () => {
  it('多问题形态：每题末尾追加 isOther「其它」，标记来源', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())

    const begin = firstInteractionBegin(harness.events)

    // 来源标记让前端按来源分发组件，不必嗅探标题或选项特征。
    expect(begin.interaction.source).toBe('ask-user-question')
    expect(begin.interaction.kind).toBe('choice')
    expect(begin.interaction.questions).toHaveLength(2)
    const firstOptions = begin.interaction.questions?.[0]?.options ?? []
    expect(firstOptions.at(-1)).toMatchObject({
      value: '__other__',
      label: '其它',
      isOther: true,
    })
    expect(begin.interaction.description).toContain('基准目录与图片都未指明')

    const ids = questionIdsOf(harness.events)
    harness.answerWith({ [ids[0]]: 'baselines', [ids[1]]: 'template.png' })
    await pending
  })

  it('单问题形态：使用顶层 options（含「其它」），不下发 questions', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildOneQuestionInput())

    const begin = firstInteractionBegin(harness.events)
    expect(begin.interaction.source).toBe('ask-user-question')
    expect(begin.interaction.questions).toBeUndefined()
    expect((begin.interaction.options ?? []).at(-1)).toMatchObject({
      isOther: true,
    })

    harness.answerWith('chromium')
    await pending
  })

  it('标题缺省用平台默认标题，Agent 传入时用其标题', async () => {
    const withTitle = createHarness()
    const withTitlePending = withTitle.host.ask({
      ...buildOneQuestionInput(),
      title: '请确认浏览器覆盖范围',
    })
    expect(firstInteractionBegin(withTitle.events).interaction.title).toBe(
      '请确认浏览器覆盖范围',
    )
    withTitle.answerWith('chromium')
    await withTitlePending

    const withoutTitle = createHarness()
    const withoutTitlePending = withoutTitle.host.ask(buildOneQuestionInput())
    const title = firstInteractionBegin(withoutTitle.events).interaction.title
    // 默认标题不含任何领域语义，前端也不再靠标题猜主题。
    expect(title).toBe('需要你确认一些信息')
    expect(title).not.toContain('视觉基准')
    withoutTitle.answerWith('chromium')
    await withoutTitlePending
  })

  it('多问题形态每题都带默认占位文案', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())

    const begin = firstInteractionBegin(harness.events)
    for (const question of begin.interaction.questions ?? []) {
      expect(question.placeholder).toBe('输入你的回答…')
      expect(question.placeholder).not.toContain('userWorkSpace')
    }

    const ids = questionIdsOf(harness.events)
    harness.answerWith({ [ids[0]]: 'baselines', [ids[1]]: 'template.png' })
    await pending
  })
})

describe('回答归一化', () => {
  it('单问题：原始回答即该题答案', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildOneQuestionInput())
    harness.answerWith('chromium,firefox')

    expect(await pending).toEqual({
      status: 'answered',
      answers: [{ label: '需要覆盖哪些浏览器', value: 'chromium,firefox' }],
    })
  })

  it('多问题：按提问顺序对齐，回传 label 便于模型对号', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())

    const ids = questionIdsOf(harness.events)
    harness.answerWith({ [ids[0]]: 'preview', [ids[1]]: 'preview/x.png' })

    expect(await pending).toEqual({
      status: 'answered',
      answers: [
        { label: '基准目录', value: 'preview' },
        { label: '基准图片', value: 'preview/x.png' },
      ],
    })
  })

  it('「其它」自定义文本原样作为回答（宿主不改写、不校验语义）', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildOneQuestionInput())
    harness.answerWith('  webkit，仅移动端  ')

    const details = await pending
    expect(details.answers[0]?.value).toBe('webkit，仅移动端')
  })

  it('取消哨兵 → cancelled 且无部分答案', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())
    harness.answerWith('__cancelled__')

    expect(await pending).toEqual({ status: 'cancelled', answers: [] })
  })

  it('多问题缺任一题回答 → cancelled 并指明缺哪一题', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())

    const ids = questionIdsOf(harness.events)
    harness.answerWith({ [ids[0]]: 'baselines' })

    const details = await pending
    expect(details.status).toBe('cancelled')
    expect(details.reason).toContain('基准图片')
  })

  it('回答格式与形态不符 → cancelled 兜底', async () => {
    // 单问题形态收到回答表（API 直调等异常路径）。
    const single = createHarness()
    const singlePending = single.host.ask(buildOneQuestionInput())
    single.answerWith({ unexpected: 'chromium' })
    expect((await singlePending).status).toBe('cancelled')

    // 多问题形态收到字符串。
    const multi = createHarness()
    const multiPending = multi.host.ask(buildTwoQuestionInput())
    multi.answerWith('baselines')
    expect((await multiPending).status).toBe('cancelled')
  })

  it('单问题回答为空串 → cancelled 兜底', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildOneQuestionInput())
    harness.answerWith('   ')

    const details = await pending
    expect(details.status).toBe('cancelled')
    expect(details.reason).toContain('回答内容为空')
  })
})

describe('事件契约', () => {
  it('回答后发布 interaction end（answer + answeredBy=user）', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildTwoQuestionInput())
    const ids = questionIdsOf(harness.events)
    const answerTable = { [ids[0]]: 'baselines', [ids[1]]: 'template.png' }
    harness.answerWith(answerTable)
    await pending

    const end = harness.events.find(
      (event) => event.type === 'interaction' && event.phase === 'end',
    )
    expect(end).toBeDefined()
    if (!end || end.phase !== 'end') return
    expect(end.answeredBy).toBe('user')
    expect(end.answer).toEqual(answerTable)
    expect(end.interactionId).toBe(
      firstInteractionBegin(harness.events).interaction.interactionId,
    )
  })

  it('会话中止：卡片定格为 aborted 并向工具抛出，零落盘', async () => {
    const harness = createHarness()
    const pending = harness.host.ask(buildOneQuestionInput())
    const aborted = new Error('会话已中止')
    harness.abortWith(aborted)

    await expect(pending).rejects.toBe(aborted)

    const end = harness.events.find(
      (event) => event.type === 'interaction' && event.phase === 'end',
    )
    expect(end).toBeDefined()
    if (!end || end.phase !== 'end') return
    expect(end.answeredBy).toBe('aborted')
    expect(end.answer).toBe('__cancelled__')
  })
})

/**
 * ask_user_question 工具与宿主注册表的单元测试。
 *
 * 覆盖：
 *   - 注册表 register/get/unregister 的会话隔离语义；
 *   - 工具参数 schema 的数量硬校验（options 2-5 项、questions 1-4 项）；
 *   - 宿主未注册时会话拿不到工具（授权边界）；
 *   - 工具返回的文本与 details 组装（answered / cancelled 两态）；
 *   - 提问能力是主题无关的：schema 不含 topic 等领域字段。
 */

import { describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'
import {
  createAskUserQuestionTool,
  createSessionAskTools,
  askUserQuestionParameters,
} from '../src/tools/ask-user-question'
import {
  askUserRegistry,
  createAskUserRegistry,
  type AskUserQuestionDetails,
  type IAskUserHost,
} from '../src/tools/ask-user-question-registry'

/** 构造一组合法的单问题输入。 */
function buildValidInput() {
  return {
    questions: [
      {
        label: '基准目录',
        options: [
          { label: '使用默认目录 userWorkSpace/baselines', value: 'baselines' },
          { label: 'preview', value: 'preview' },
        ],
      },
    ],
    context: '测试步骤要求视觉对比，但未指明基准目录。',
  }
}

/** 构造一个按脚本返回结果的假宿主，并记录收到的入参。 */
function fakeHost(details: AskUserQuestionDetails) {
  const received: Parameters<IAskUserHost['ask']>[0][] = []
  const host: IAskUserHost = {
    async ask(input) {
      received.push(input)
      return details
    },
  }
  return { host, received }
}

describe('askUserRegistry', () => {
  it('register/get/unregister 按会话隔离', () => {
    const registry = createAskUserRegistry()
    const { host } = fakeHost({ status: 'cancelled', answers: [] })

    expect(registry.get('s1')).toBeUndefined()

    registry.register('s1', host)
    expect(registry.get('s1')).toBe(host)
    expect(registry.get('s2')).toBeUndefined()

    registry.unregister('s1')
    expect(registry.get('s1')).toBeUndefined()

    // 未登记时注销是安全无操作。
    expect(() => registry.unregister('never')).not.toThrow()
  })
})

describe('工具参数 schema 的数量硬校验', () => {
  it('options 2-5 项通过，1 项或 6 项拒绝', () => {
    const makeOptions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        label: `选项${index}`,
        value: `dir-${index}`,
      }))

    const check = (count: number) =>
      Value.Check(askUserQuestionParameters, {
        ...buildValidInput(),
        questions: [{ label: '基准目录', options: makeOptions(count) }],
      })

    expect(check(2)).toBe(true)
    expect(check(5)).toBe(true)
    expect(check(1)).toBe(false)
    expect(check(6)).toBe(false)
  })

  it('questions 1-4 项通过，0 项或 5 项拒绝', () => {
    const question = buildValidInput().questions[0]
    const check = (count: number) =>
      Value.Check(askUserQuestionParameters, {
        ...buildValidInput(),
        questions: Array.from({ length: count }, () => question),
      })

    expect(check(1)).toBe(true)
    expect(check(4)).toBe(true)
    expect(check(0)).toBe(false)
    expect(check(5)).toBe(false)
  })

  it('缺少 context 时拒绝', () => {
    expect(
      Value.Check(askUserQuestionParameters, {
        questions: buildValidInput().questions,
      }),
    ).toBe(false)
  })

  it('文案是否为空由宿主校验，schema 只管结构与数量', () => {
    // schema 不校验空字符串（分层：结构数量归 schema，文案合法性归宿主的
    // validateAskInput），此处锁定该边界，避免误把职责挪到 schema。
    expect(
      Value.Check(askUserQuestionParameters, {
        ...buildValidInput(),
        questions: [
          { label: '', options: buildValidInput().questions[0].options },
        ],
      }),
    ).toBe(true)
  })

  it('提问能力是主题无关的：不接受 topic 等领域字段', () => {
    // schema 顶层只有 title / questions / context 三个属性，
    // 任何领域字段（topic / missing / knownDirectory / knownImage）都不存在。
    expect(Object.keys(askUserQuestionParameters.properties).sort()).toEqual([
      'context',
      'questions',
      'title',
    ])

    // title 可选：不传与传空对象都应通过 schema（缺省标题由宿主兜底）。
    expect(Value.Check(askUserQuestionParameters, buildValidInput())).toBe(true)
    expect(
      Value.Check(askUserQuestionParameters, {
        ...buildValidInput(),
        title: '请确认视觉基准信息',
      }),
    ).toBe(true)
  })
})

describe('createSessionAskTools（授权边界）', () => {
  it('未登记宿主的会话拿不到提问工具', () => {
    expect(createSessionAskTools(undefined)).toEqual([])
    expect(createSessionAskTools('no-host-session')).toEqual([])
  })

  it('登记宿主后该会话获得 ask_user_question 工具', () => {
    const { host } = fakeHost({ status: 'cancelled', answers: [] })
    askUserRegistry.register('authorized', host)
    try {
      const tools = createSessionAskTools('authorized')
      expect(tools).toHaveLength(1)
      expect(tools[0]?.name).toBe('ask_user_question')
    } finally {
      askUserRegistry.unregister('authorized')
    }
  })
})

describe('ask_user_question 工具执行', () => {
  it('answered：逐题列出用户的选择，并提示按 Skill 规则解释', async () => {
    const { host } = fakeHost({
      status: 'answered',
      answers: [
        { label: '基准目录', value: 'baselines' },
        { label: '基准图片', value: 'baselines/template.png' },
      ],
    })
    const tool = createAskUserQuestionTool(host)

    const result = await tool.execute(
      'call-1',
      buildValidInput(),
      undefined,
      undefined,
    )
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('用户已回答')
    expect(text).toContain('基准目录：baselines')
    expect(text).toContain('基准图片：baselines/template.png')
    expect(result.details.status).toBe('answered')
    expect(result.details.answers).toHaveLength(2)
  })

  it('把 title / questions / context 原样透传给宿主', async () => {
    const { host, received } = fakeHost({ status: 'cancelled', answers: [] })
    const tool = createAskUserQuestionTool(host)

    await tool.execute(
      'call-1',
      { ...buildValidInput(), title: '请确认基准信息' },
      undefined,
      undefined,
    )

    expect(received).toHaveLength(1)
    expect(received[0]?.title).toBe('请确认基准信息')
    expect(received[0]?.questions).toEqual(buildValidInput().questions)
    expect(received[0]?.context).toBe(buildValidInput().context)
  })

  it('未传 title 时不向宿主下发该字段（由宿主用默认标题兜底）', async () => {
    const { host, received } = fakeHost({ status: 'cancelled', answers: [] })
    const tool = createAskUserQuestionTool(host)

    await tool.execute('call-1', buildValidInput(), undefined, undefined)

    expect('title' in (received[0] ?? {})).toBe(false)
  })

  it('cancelled：说明未拿到可用回答，不得自行假设，可修正问法后重试', async () => {
    const { host } = fakeHost({
      status: 'cancelled',
      reason: '回答内容为空',
      answers: [],
    })
    const tool = createAskUserQuestionTool(host)

    const result = await tool.execute(
      'call-1',
      buildValidInput(),
      undefined,
      undefined,
    )
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('本次提问没有拿到可用的回答')
    expect(text).toContain('回答内容为空')
    expect(text).toContain('不要就本次提问涉及的信息自行假设')
    expect(text).toContain('重新发起提问')
    expect(text).toContain('断点')
    // 提问卡片不提供取消出口，cancelled 只来自异常路径——
    // 文案不得暗示「用户主动拒绝」，否则模型会误判用户意图。
    expect(text).not.toContain('用户选择不继续')
    expect(text).not.toContain('用户取消')
    expect(result.details.status).toBe('cancelled')
    expect(result.details.answers).toEqual([])
  })

  it('cancelled 无 reason 时不输出空的原因句', async () => {
    const { host } = fakeHost({ status: 'cancelled', answers: [] })
    const tool = createAskUserQuestionTool(host)

    const result = await tool.execute(
      'call-1',
      buildValidInput(),
      undefined,
      undefined,
    )
    const text = (result.content[0] as { text: string }).text

    expect(text).not.toContain('原因：')
    expect(text).toContain('不要就本次提问涉及的信息自行假设')
  })

  it('answered 但无可用回答时提示按 Skill 规则决定是否重新提问', async () => {
    const { host } = fakeHost({ status: 'answered', answers: [] })
    const tool = createAskUserQuestionTool(host)

    const result = await tool.execute(
      'call-1',
      buildValidInput(),
      undefined,
      undefined,
    )
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('没有可用的回答内容')
  })

  it('工具 description 不含视觉基准等领域语义', () => {
    const { host } = fakeHost({ status: 'cancelled', answers: [] })
    const tool = createAskUserQuestionTool(host)

    expect(tool.description).not.toContain('视觉基准')
    expect(tool.description).not.toContain('baselines')
    expect(tool.description).toContain('2-5 个候选项')
    // 提问会阻塞会话，必须串行。
    expect(tool.executionMode).toBe('sequential')
  })
})

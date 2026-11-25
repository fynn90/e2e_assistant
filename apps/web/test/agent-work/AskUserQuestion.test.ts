/**
 * AskUserQuestion 卡片（v14 D5/D7）的组件测试。
 *
 * 卡片是**主题无关**的，因此本文件覆盖两种形态的通用契约：
 *   - 作答模型为「先填写、后提交」：点选候选项只是记录选择，不立即作答；
 *     提交由卡片底部的提交按钮触发，提交前可随时改选、切 tab 回改；
 *   - 单问题形态：选一项（或选「其它」并填写）后点提交；
 *   - 多问题形态：一问一 tab，各 tab 自由填答，全部填完才能提交，
 *     一次性提交 `Record<questionId, value>`（Q11）；
 *   - 提交按钮在未填完时禁用，并写明还差什么；
 *   - 不提供「不继续」入口（提问必须回答才能继续）；
 *   - 已回答/已中止的定格展示。
 *
 * 不覆盖答案的领域语义（路径是否越界等）——约束已下沉到 Skill 指令，
 * 由下游落盘入口守边界。
 */

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { INTERACTION_CANCEL_ANSWER } from '@authine-e2e-agent/types'
import AskUserQuestion from '../../src/modules/agent-work/components/AskUserQuestion.vue'
import type { IInteractionTimelineItem } from '../../src/modules/agent-work/timeline'

/** 单问题形态的时间线项。 */
function createSingleItem(): IInteractionTimelineItem {
  return {
    kind: 'interaction',
    blockId: 'b1',
    seq: 1,
    status: 'pending',
    interaction: {
      interactionId: 'i1',
      kind: 'choice',
      source: 'ask-user-question',
      title: '请确认视觉基准信息',
      description: '默认基准目录：userWorkSpace/baselines。',
      options: [
        { value: 'baselines', label: '使用默认目录 userWorkSpace/baselines' },
        { value: 'preview', label: 'preview 目录' },
        { value: '__other__', label: '其它', isOther: true },
      ],
    },
  }
}

/** 多问题形态的时间线项。 */
function createMultiItem(): IInteractionTimelineItem {
  return {
    kind: 'interaction',
    blockId: 'b2',
    seq: 2,
    status: 'pending',
    interaction: {
      interactionId: 'i2',
      kind: 'choice',
      source: 'ask-user-question',
      title: '请确认视觉基准信息',
      questions: [
        {
          questionId: 'baseline-directory',
          label: '基准目录',
          options: [
            {
              value: 'baselines',
              label: '使用默认目录 userWorkSpace/baselines',
            },
            { value: 'preview', label: 'preview 目录' },
            { value: '__other__', label: '其它', isOther: true },
          ],
          placeholder: '输入你的回答…',
        },
        {
          questionId: 'baseline-image',
          label: '基准图片',
          options: [
            {
              value: 'baselines/template.png',
              label: 'baselines/template.png',
            },
            { value: 'candidate-a.png', label: 'candidate-a.png' },
            { value: '__other__', label: '其它', isOther: true },
          ],
          placeholder: '输入你的回答…',
        },
      ],
    },
  }
}

/**
 * 找到选项按钮（按文案）。
 *
 * 不带面板圈定：多问题形态下面板全部保持挂载，同名候选项（如两题都有「其它」）
 * 会命中**第一个**面板里的那个。多问题形态请用 `paneOptionButton` 按下标圈定。
 */
function optionButton(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper
    .findAll('.ask-option')
    .find((button) => button.text().includes(label))
}

/** 找到底部的提交按钮。 */
function submitButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').find((button) => button.text() === '提交')
}

/**
 * 找到全部 tab（naive-ui 渲染为 `.n-tabs-tab`，无 role="tab"）。
 *
 * 过滤没有 `data-name` 的节点：分栏占位等元素也带 `n-tabs-tab` 前缀。
 */
function tabButtons(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('.n-tabs-tab')
    .filter((tab) => tab.attributes('data-name') !== undefined)
}

/** 切到指定下标的 tab。 */
async function openTab(
  wrapper: ReturnType<typeof mount>,
  index: number,
): Promise<void> {
  await tabButtons(wrapper)[index]?.trigger('click')
}

/**
 * 取指定 tab 面板内的元素。
 *
 * 面板用 `display-directive="show"` 保持挂载，未激活的也留在 DOM 里，
 * 不带面板下标的查询（`find('textarea')` / `findAll('.ask-option')`）会命中
 * 第一个面板——多问题形态的查询必须按下标圈定面板。
 */
function pane(wrapper: ReturnType<typeof mount>, tabIndex: number) {
  return wrapper.findAll('.n-tab-pane')[tabIndex]
}

/** 取指定面板内的候选项按钮（按文案）。 */
function paneOptionButton(
  wrapper: ReturnType<typeof mount>,
  tabIndex: number,
  label: string,
) {
  return pane(wrapper, tabIndex)
    ?.findAll('.ask-option')
    .find((button) => button.text().includes(label))
}

/** 填完单问题形态（选一项后提交）。 */
async function answerSingle(
  wrapper: ReturnType<typeof mount>,
  label: string,
): Promise<void> {
  await optionButton(wrapper, label)?.trigger('click')
  await submitButton(wrapper)?.trigger('click')
}

describe('AskUserQuestion：单问题形态（填完后提交）', () => {
  it('点选候选项只是记录选择，不立即提交', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await optionButton(wrapper, 'preview 目录')?.trigger('click')

    // 尚未点提交：没有任何 answer 事件。
    expect(wrapper.emitted('answer')).toBeUndefined()
    // 选中态已生效，且提交按钮可用。
    expect(optionButton(wrapper, 'preview 目录')?.classes()).toContain(
      'selected',
    )
    expect(submitButton(wrapper)?.attributes('disabled')).toBeUndefined()
  })

  it('点提交后按所选值作答', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await answerSingle(wrapper, 'preview 目录')

    expect(wrapper.emitted('answer')).toEqual([['i1', 'preview']])
  })

  it('提交前可以改选，以最后一次选择为准', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await optionButton(wrapper, 'preview 目录')?.trigger('click')
    await optionButton(wrapper, 'baselines')?.trigger('click')
    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.emitted('answer')).toEqual([['i1', 'baselines']])
  })

  it('未选择时提交按钮禁用并给出原因', () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    expect(submitButton(wrapper)?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('请先选择一项')
  })

  it('不渲染「不继续」按钮（提问必须回答才能继续）', () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    const texts = wrapper.findAll('button').map((button) => button.text())
    expect(texts).not.toContain('不继续')
    // 提交按钮必须存在（作答统一由它落定）。
    expect(texts).toContain('提交')
  })

  it('选中「其它」展开长文本，填写后提交其原文（Q19/Q20）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await optionButton(wrapper, '其它')?.trigger('click')
    expect(wrapper.find('textarea').exists()).toBe(true)
    // 展开输入框本身不算作答。
    expect(wrapper.emitted('answer')).toBeUndefined()

    // 空文本：中性必填提示 + 提交不可用（不标红——用户还没动手，不算错误）。
    expect(submitButton(wrapper)?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('「其它」为必填')
    expect(wrapper.find('.ask-other-hint').classes()).not.toContain('is-error')

    // 超长：升级为红色错误，提交仍不可用。
    await wrapper.find('textarea').setValue('x'.repeat(2001))
    expect(wrapper.text()).toContain('字符上限')
    expect(wrapper.find('.ask-other-hint').classes()).toContain('is-error')
    expect(submitButton(wrapper)?.attributes('disabled')).toBeDefined()
    await submitButton(wrapper)?.trigger('click')
    expect(wrapper.emitted('answer')).toBeUndefined()

    // 有内容即可提交，回传文本值（首尾空白已去除）。
    await wrapper.find('textarea').setValue('  preview  ')
    await submitButton(wrapper)?.trigger('click')
    expect(wrapper.emitted('answer')).toEqual([['i1', 'preview']])
  })

  it('提交后不再接受作答（冻结态防重复提交）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await answerSingle(wrapper, 'preview 目录')
    await optionButton(wrapper, 'baselines')?.trigger('click')
    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.emitted('answer')).toHaveLength(1)
  })

  it('不校验答案的领域语义：越界路径原样提交（约束已下沉到 Skill）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createSingleItem() },
    })

    await optionButton(wrapper, '其它')?.trigger('click')
    await wrapper.find('textarea').setValue('../outside/绝对\\路径')
    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.text()).not.toContain('只能输入 userWorkSpace 内的相对路径')
    expect(wrapper.emitted('answer')).toEqual([['i1', '../outside/绝对\\路径']])
  })
})

describe('AskUserQuestion：多问题形态（一问一 tab + 底部提交）', () => {
  it('每道题渲染为一个 tab（短标签），首个 tab 默认激活', () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    const tabs = tabButtons(wrapper)
    expect(tabs).toHaveLength(2)
    // tab 上是短标签：完整题干由 Agent 生成、长短不可控，整句塞进 tab 会挤到横向滚动。
    expect(tabs[0]?.text()).toBe('问题 1')
    expect(tabs[1]?.text()).toBe('问题 2')
    // 首题激活：第一题的完整题干与候选项都可见。
    expect(pane(wrapper, 0)?.find('.ask-question-title').text()).toBe(
      '基准目录',
    )
    expect(wrapper.text()).toContain('preview 目录')
  })

  it('完整题干渲染在各自面板内，不随 tab 切换丢失', () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    // 两个面板都保持挂载，各自带上自己的题干。
    expect(pane(wrapper, 0)?.find('.ask-question-title').text()).toBe(
      '基准目录',
    )
    expect(pane(wrapper, 1)?.find('.ask-question-title').text()).toBe(
      '基准图片',
    )
  })

  it('选完一题自动切到下一道未填的题（但不提交）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    await optionButton(wrapper, '使用默认目录')?.trigger('click')

    // 没有任何提交；焦点已自动移到第二题。
    expect(wrapper.emitted('answer')).toBeUndefined()
    const tabs = tabButtons(wrapper)
    expect(tabs[0]?.classes()).not.toContain('n-tabs-tab--active')
    expect(tabs[1]?.classes()).toContain('n-tabs-tab--active')
  })

  it('选中「其它」不自动换页（还要输入文本，换走等于藏起输入框）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    await optionButton(wrapper, '其它')?.trigger('click')

    // 停在当前题，输入框仍可见。
    expect(tabButtons(wrapper)[0]?.classes()).toContain('n-tabs-tab--active')
    expect(pane(wrapper, 0)?.find('textarea').exists()).toBe(true)
  })

  it('回头改答已填的题时不会被自动推走', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    // 两道题都填完（每次选完都自动前进，最终停在第二题）。
    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    await optionButton(wrapper, 'candidate-a.png')?.trigger('click')
    expect(tabButtons(wrapper)[1]?.classes()).toContain('n-tabs-tab--active')

    // 切回第一题改答：两题都已填完，没有「下一道未填的题」，焦点留在原地。
    await openTab(wrapper, 0)
    await optionButton(wrapper, 'preview 目录')?.trigger('click')
    expect(tabButtons(wrapper)[0]?.classes()).toContain('n-tabs-tab--active')
  })

  it('未全部填完时提交按钮禁用并写明还差几题', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    expect(submitButton(wrapper)?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('还有 2 题未填完')

    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    expect(submitButton(wrapper)?.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('还有 1 题未填完')

    await openTab(wrapper, 1)
    await optionButton(wrapper, 'candidate-a.png')?.trigger('click')
    expect(submitButton(wrapper)?.attributes('disabled')).toBeUndefined()
  })

  it('全部填完后一次性提交 Record<questionId, value>（Q11）', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    await openTab(wrapper, 1)
    await optionButton(wrapper, 'candidate-a.png')?.trigger('click')
    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.emitted('answer')).toEqual([
      [
        'i2',
        {
          'baseline-directory': 'baselines',
          'baseline-image': 'candidate-a.png',
        },
      ],
    ])
  })

  it('提交前可以切回上一个 tab 改选，以最后一次选择为准', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    await openTab(wrapper, 1)
    await optionButton(wrapper, 'candidate-a.png')?.trigger('click')

    // 回到第一个 tab 改选，再回来提交。
    await openTab(wrapper, 0)
    await optionButton(wrapper, 'preview 目录')?.trigger('click')
    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.emitted('answer')).toEqual([
      [
        'i2',
        {
          'baseline-directory': 'preview',
          'baseline-image': 'candidate-a.png',
        },
      ],
    ])
  })

  it('已填的 tab 被打勾标记，且切走再切回不丢选择', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    // 作答前无勾选标记。
    expect(wrapper.findAll('.ask-tab-check')).toHaveLength(0)

    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    expect(wrapper.findAll('.ask-tab-check')).toHaveLength(1)

    // 切到第二题再切回来：第一题的候选项仍是选中态（面板未被销毁）。
    await openTab(wrapper, 1)
    await openTab(wrapper, 0)
    expect(optionButton(wrapper, '使用默认目录')?.classes()).toContain(
      'selected',
    )
  })

  it('「其它」在 tab 内填写，答案并入回答表', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    // 第一题选「其它」并填写。
    await paneOptionButton(wrapper, 0, '其它')?.trigger('click')
    await pane(wrapper, 0)?.find('textarea').setValue('preview')

    // 第二题同样走「其它」。
    await paneOptionButton(wrapper, 1, '其它')?.trigger('click')
    await pane(wrapper, 1)?.find('textarea').setValue('preview/new.png')

    await submitButton(wrapper)?.trigger('click')

    expect(wrapper.emitted('answer')).toEqual([
      [
        'i2',
        {
          'baseline-directory': 'preview',
          'baseline-image': 'preview/new.png',
        },
      ],
    ])
  })

  it('不渲染「不继续」按钮', () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    const texts = wrapper.findAll('button').map((button) => button.text())
    expect(texts).not.toContain('不继续')
    expect(texts).toContain('提交')
  })

  it('进度徽标展示已填题数', async () => {
    const wrapper = mount(AskUserQuestion, {
      props: { item: createMultiItem() },
    })

    expect(wrapper.text()).toContain('0 / 2')
    await optionButton(wrapper, '使用默认目录')?.trigger('click')
    expect(wrapper.text()).toContain('1 / 2')
  })
})

describe('AskUserQuestion：定格展示', () => {
  it('单问题形态展示所选选项的文案', () => {
    const item = createSingleItem()
    item.status = 'answered'
    item.answer = 'baselines'
    item.answeredBy = 'user'

    const wrapper = mount(AskUserQuestion, { props: { item } })
    expect(wrapper.text()).toContain(
      '已选择：使用默认目录 userWorkSpace/baselines',
    )
  })

  it('多问题形态逐题展示所选答案（Q6）', () => {
    const item = createMultiItem()
    item.status = 'answered'
    item.answer = {
      'baseline-directory': 'baselines',
      'baseline-image': 'candidate-a.png',
    }
    item.answeredBy = 'user'

    const wrapper = mount(AskUserQuestion, { props: { item } })
    expect(wrapper.text()).toContain(
      '基准目录：使用默认目录 userWorkSpace/baselines',
    )
    expect(wrapper.text()).toContain('基准图片：candidate-a.png')
  })

  it('会话中止时展示「已中止」并标注来源', () => {
    const item = createSingleItem()
    item.status = 'answered'
    item.answer = INTERACTION_CANCEL_ANSWER
    item.answeredBy = 'aborted'

    const wrapper = mount(AskUserQuestion, { props: { item } })
    expect(wrapper.text()).toContain('已中止')
    expect(wrapper.text()).toContain('会话已中止')
  })
})

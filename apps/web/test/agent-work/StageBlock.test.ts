/**
 * 阶段区块的组件测试（PRD 5.3 / AC-04）。
 *
 * 覆盖：标题行两态内容一致、整行热区、箭头随折叠切换、统计实时推进与终态停钟、
 * 到终态自动折叠、用户手动展开后不再自动折叠、停止按钮与等待提示。
 */
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StageBlock from '../../src/modules/agent-work/components/StageBlock.vue'
import type { IStageRecord } from '../../src/modules/generation-flow/types'
import type { TWorkTimelineItem } from '../../src/modules/agent-work/timeline'

/**
 * 构造最小阶段记录（时间线为空，摘要回退为「已完成」/「准备中…」）。
 * @param overrides 需要覆盖的字段。
 * @returns 阶段记录。
 * @throws 不抛出异常。
 */
function createStage(overrides: Partial<IStageRecord> = {}): IStageRecord {
  return {
    kind: 'skill',
    title: 'SKILL 阶段',
    status: 'writing-skill',
    timeline: {
      items: { value: [] },
      activity: { value: 'idle' },
      activityLabel: { value: undefined },
      connection: { value: 'offline' },
      dispose: () => undefined,
    } as unknown as IStageRecord['timeline'],
    card: null,
    failureCard: null,
    stageText: 'Agent 正在写入当前 Skill 的 SKILL.md…',
    cancelable: true,
    startedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * 构造一个运行中（未定型）的思考项。
 * @param startedAt 思考开始的毫秒时间戳。
 * @returns 思考项。
 * @throws 不抛出异常。
 */
function streamingThinking(startedAt: number): TWorkTimelineItem {
  return {
    kind: 'thinking',
    blockId: 'think-1',
    seq: 1,
    status: 'streaming',
    text: '正在分析用例…',
    startedAt,
  }
}

/**
 * 构造一个已定型的思考项。
 * @param durationMs 思考耗时（毫秒）。
 * @returns 思考项。
 * @throws 不抛出异常。
 */
function doneThinking(durationMs: number): TWorkTimelineItem {
  return {
    kind: 'thinking',
    blockId: 'think-1',
    seq: 1,
    status: 'done',
    text: '分析完成',
    durationMs,
  }
}

/**
 * 构造带指定时间线的阶段记录。
 * @param items 时间线项。
 * @param overrides 需要覆盖的字段。
 * @returns 阶段记录。
 * @throws 不抛出异常。
 */
function stageWithTimeline(
  items: TWorkTimelineItem[],
  overrides: Partial<IStageRecord> = {},
): IStageRecord {
  const stage = createStage(overrides)
  return {
    ...stage,
    timeline: {
      ...stage.timeline,
      items: { value: items },
    } as unknown as IStageRecord['timeline'],
  }
}

const mountOptions = {
  global: {
    stubs: {
      WorkTimeline: true,
      NTag: { template: '<span class="n-tag-stub"><slot /></span>' },
      NButton: { template: '<button class="n-button-stub"><slot /></button>' },
    },
  },
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StageBlock（PRD 5.3）', () => {
  it('运行中始终展开，展示阶段文案', () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    expect(wrapper.classes()).not.toContain('collapsed')
    expect(wrapper.text()).toContain('Agent 正在写入当前 Skill 的 SKILL.md…')
    wrapper.unmount()
  })

  it('不内嵌 Agent 工作台的状态条（避免与状态徽标重复、终态下自相矛盾）', () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    // 阶段进度只由标题行状态徽标与页脚阶段文案表达。
    expect(wrapper.find('.status-bar').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('空闲')
    expect(wrapper.text()).not.toContain('实时')
    wrapper.unmount()
  })

  it('到达终态后自动折叠（AC-04）', async () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    expect(wrapper.classes()).not.toContain('collapsed')

    await wrapper.setProps({ stage: createStage({ status: 'completed' }) })

    expect(wrapper.classes()).toContain('collapsed')
    // 折叠后标题行的统计与状态徽标仍在（两态内容一致）。
    expect(wrapper.find('.stage-head__stats').exists()).toBe(true)
    expect(wrapper.find('.stage-head__status').exists()).toBe(true)
    wrapper.unmount()
  })

  it('用户手动展开后不再自动折叠回去（PRD 5.3）', async () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'completed' }) },
      ...mountOptions,
    })
    await nextTick()
    expect(wrapper.classes()).toContain('collapsed')

    // 用户点击标题行展开。
    await wrapper.find('.stage-head').trigger('click')
    expect(wrapper.classes()).not.toContain('collapsed')

    // 状态再次变化（例如重新进入终态）时不得自动折叠回去，否则会打断回看。
    await wrapper.setProps({ stage: createStage({ status: 'failed' }) })

    expect(wrapper.classes()).not.toContain('collapsed')
    wrapper.unmount()
  })

  it('展开态与折叠态渲染完全相同的标题行内容', async () => {
    // 本用例是「两种显示合并为一套」的核心收口断言：此前折叠态显示摘要、
    // 展开态显示状态徽标 + 收起按钮，用户需跨状态对照才能拼出全貌。
    const wrapper = mount(StageBlock, {
      props: {
        stage: stageWithTimeline([doneThinking(5000)], { status: 'completed' }),
      },
      ...mountOptions,
    })
    await nextTick()
    expect(wrapper.classes()).toContain('collapsed')
    const collapsedText = wrapper.find('.stage-head').text()

    await wrapper.find('.stage-head').trigger('click')
    expect(wrapper.classes()).not.toContain('collapsed')

    expect(wrapper.find('.stage-head').text()).toBe(collapsedText)
    wrapper.unmount()
  })

  it('标题行不再有「收起」按钮', () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    const texts = wrapper.findAll('button').map((button) => button.text())
    expect(texts.some((text) => text.includes('收起'))).toBe(false)
    wrapper.unmount()
  })

  it('整行是一个按钮，点击任意位置都切换折叠', async () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    const head = wrapper.find('.stage-head')
    expect(head.element.tagName).toBe('BUTTON')
    // 统计与状态徽标都在这个按钮**内部**，点击它们同样触发折叠。
    expect(head.find('.stage-head__stats').exists()).toBe(true)
    expect(head.find('.stage-head__status').exists()).toBe(true)

    await head.trigger('click')
    expect(wrapper.classes()).toContain('collapsed')

    await head.trigger('click')
    expect(wrapper.classes()).not.toContain('collapsed')
    wrapper.unmount()
  })

  it('箭头随折叠状态切换字形，且字号明显大于改前的 11px', async () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    const chevron = wrapper.find('.stage-head__chevron')
    expect(chevron.classes()).toContain('h-icon-all-caret-down')

    const size = Number(
      /font-size:\s*(\d+(?:\.\d+)?)px/.exec(
        chevron.attributes('style') ?? '',
      )?.[1],
    )
    expect(size).toBeGreaterThanOrEqual(14)

    await wrapper.find('.stage-head').trigger('click')
    expect(wrapper.find('.stage-head__chevron').classes()).toContain(
      'h-icon-all-caret-right',
    )
    wrapper.unmount()
  })

  it('运行中统计的秒数每秒实时推进（事件静默期也在走）', async () => {
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'))
    const wrapper = mount(StageBlock, {
      props: {
        stage: stageWithTimeline([streamingThinking(Date.now())], {
          status: 'writing-skill',
        }),
      },
      ...mountOptions,
    })

    // 挂载瞬间耗时为 0，靠 `max(1, …)` 的兜底展示为 1 秒。
    expect(wrapper.find('.stage-head__stats').text()).toBe('已思考 1 秒')

    // 关键：这 3 秒内**没有任何 SSE 事件到达**（思考块处于 append 静默期），
    // 秒数仍应推进——这正是引入 ticker 的唯一理由。
    await vi.advanceTimersByTimeAsync(3000)
    await nextTick()

    expect(wrapper.find('.stage-head__stats').text()).toBe('已思考 3 秒')
    wrapper.unmount()
  })

  it('到达终态后停止计时，统计不再变化', async () => {
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'))
    const wrapper = mount(StageBlock, {
      props: {
        stage: stageWithTimeline([streamingThinking(Date.now())], {
          status: 'writing-skill',
        }),
      },
      ...mountOptions,
    })

    // 终态：已定型耗时接管，ticker 应停止（否则白烧 CPU）。
    await wrapper.setProps({
      stage: stageWithTimeline([doneThinking(7000)], { status: 'completed' }),
    })
    await nextTick()
    const frozen = wrapper.find('.stage-head__stats').text()
    expect(frozen).toBe('已思考 7 秒')

    await vi.advanceTimersByTimeAsync(5000)
    await nextTick()

    expect(wrapper.find('.stage-head__stats').text()).toBe(frozen)
    wrapper.unmount()
  })

  it('运行中且尚无任何统计时显示「准备中…」而非「已完成」', () => {
    const wrapper = mount(StageBlock, {
      props: { stage: createStage({ status: 'writing-skill' }) },
      ...mountOptions,
    })

    // 与同一行右侧的「进行中」徽标保持一致，不能自相矛盾。
    expect(wrapper.find('.stage-head__stats').text()).toBe('准备中…')
    wrapper.unmount()
  })

  it('startedAt 为脏值时统计退化为「准备中…」，不出现 NaN 与负秒', () => {
    const wrapper = mount(StageBlock, {
      props: {
        stage: stageWithTimeline([streamingThinking(Number.NaN)], {
          status: 'writing-skill',
        }),
      },
      ...mountOptions,
    })

    const stats = wrapper.find('.stage-head__stats').text()
    expect(stats).not.toContain('NaN')
    expect(stats).not.toContain('-')
    wrapper.unmount()
  })

  it('可取消阶段展示「停止 Agent」，并向上抛出取消事件（PRD 10.2）', async () => {
    const wrapper = mount(StageBlock, {
      props: {
        stage: createStage({ status: 'writing-skill', cancelable: true }),
      },
      ...mountOptions,
    })

    const buttons = wrapper.findAll('button')
    expect(buttons.some((button) => button.text().includes('停止 Agent'))).toBe(
      true,
    )

    const stopButton = buttons.find((button) =>
      button.text().includes('停止 Agent'),
    )!
    await stopButton.trigger('click')

    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('不可取消阶段展示等待提示而非停止按钮（PRD 10.2）', () => {
    const wrapper = mount(StageBlock, {
      props: {
        stage: createStage({ status: 'saving-skill', cancelable: false }),
      },
      ...mountOptions,
    })

    expect(wrapper.text()).toContain('请等待完成')
    expect(wrapper.text()).not.toContain('停止 Agent')
    wrapper.unmount()
  })
})

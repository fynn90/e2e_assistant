/**
 * v17 两类新卡片、二次确认弹框与 batch 卡的组件测试（PRD R / E / V / L 组）。
 *
 * 覆盖（按需求里点名的三件事，另加回归价值最高的三处）：
 *   1. **两个新块的分发**：`workbench_view` / `workbench_proposal` 在 `WorkTimeline`
 *      的分发链里必须排在 ContentBlock 的兜底之前（否则卡片会被静默渲染成
 *      内容块）；归约器把两个新块的 begin 事件建成对应时间线项；
 *   2. **提案卡的终态定格**：pending 可点、终态隐藏按钮并显示结果文案；
 *   3. **二次弹框只在 `requiresModalConfirm === true` 时出现**，且弹框内取消
 *      **不发任何请求**（技术方案 §7.2）；
 *   4. batch 卡的三态、停止语义提前告知（R4e）与汇总（R4f）；
 *   5. L2d：用例已删除时 v16 卡片的入口禁用。
 *
 * 视图卡五种 viewKind 的渲染断言在 `WorkbenchV17Views.test.ts`。
 * 不覆盖：内嵌执行区块（`WorkbenchExecutionBody`）的网络取数——那属于执行 store
 * 的既有测试范围，此处用替身隔离。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import WorkbenchProposalCard from '../../src/modules/agent-work/components/WorkbenchProposalCard.vue'
import WorkbenchProposalConfirmModal from '../../src/modules/agent-work/components/WorkbenchProposalConfirmModal.vue'
import WorkbenchBatchCard from '../../src/modules/agent-work/components/WorkbenchBatchCard.vue'
import WorkbenchTaskCard from '../../src/modules/agent-work/components/WorkbenchTaskCard.vue'
import WorkbenchViewCard from '../../src/modules/agent-work/components/WorkbenchViewCard.vue'
import WorkbenchActionCard from '../../src/modules/agent-work/components/WorkbenchActionCard.vue'
import WorkbenchReportCard from '../../src/modules/agent-work/components/WorkbenchReportCard.vue'
import WorkTimeline from '../../src/modules/agent-work/components/WorkTimeline.vue'
import {
  applyEventToTimeline,
  createTimelineState,
  createWorkbenchActionItem,
  createWorkbenchReportItem,
  createWorkbenchViewItem,
  type IWorkbenchProposalTimelineItem,
  type IWorkbenchTaskTimelineItem,
} from '../../src/modules/agent-work/timeline'
import {
  createBatchItem,
  createProposalItem,
  createViewItem,
  eventOf,
} from './fixtures/workbench-v17-fixtures'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('WorkTimeline 分发（v17 两个新块）', () => {
  it('workbench_view 渲染为视图卡（不落到 ContentBlock 兜底）', () => {
    const wrapper = mount(WorkTimeline, {
      props: {
        items: [
          createViewItem({
            viewKind: 'capability',
            payload: { domains: [], notSupported: [] },
          }),
        ],
      },
    })

    expect(wrapper.text()).toContain('我能做什么')
    expect(wrapper.findComponent(WorkbenchViewCard).exists()).toBe(true)
    wrapper.unmount()
  })

  it('workbench_proposal 渲染为提案卡（不落到 ContentBlock 兜底）', () => {
    const wrapper = mount(WorkTimeline, {
      props: { items: [createProposalItem()] },
    })

    expect(wrapper.text()).toContain('修改用例标题')
    expect(wrapper.findComponent(WorkbenchProposalCard).exists()).toBe(true)
    wrapper.unmount()
  })

  it('归约器把两个新块的 begin 事件建成对应时间线项', () => {
    const state = createTimelineState()

    applyEventToTimeline(
      state,
      eventOf(1, 'v1', {
        type: 'workbench_view',
        phase: 'begin',
        viewId: 'view-1',
        viewKind: 'skill-list',
        skillId: null,
        payload: { rows: [], total: 0 },
      }),
    )
    applyEventToTimeline(
      state,
      eventOf(2, 'p1', {
        type: 'workbench_proposal',
        phase: 'begin',
        proposalId: 'p1',
        proposalKind: 'report-cleanup',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        label: '删除 6 份报告',
        state: 'pending',
        requiresModalConfirm: true,
      }),
    )

    expect(state.items.map((item) => item.kind)).toEqual([
      'workbench_view',
      'workbench_proposal',
    ])
    const proposal = state.items[1] as IWorkbenchProposalTimelineItem
    expect(proposal.requiresModalConfirm).toBe(true)
    expect(proposal.label).toBe('删除 6 份报告')
  })
})

describe('WorkbenchProposalCard（v17 E / V / L 组）', () => {
  it('pending 时渲染主按钮与取消，主按钮点击向上抛出（不需要弹框时直接应用）', async () => {
    const wrapper = mount(WorkbenchProposalCard, {
      props: { item: createProposalItem() },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons.map((button) => button.text())).toEqual(['取消', '应用变更'])

    await buttons[1]!.trigger('click')
    expect(wrapper.emitted('apply')).toHaveLength(1)
    expect(wrapper.emitted('requestConfirm')).toBeUndefined()
    wrapper.unmount()
  })

  it('requiresModalConfirm 为 true 时点击主按钮只抛 requestConfirm，不发 apply', async () => {
    const wrapper = mount(WorkbenchProposalCard, {
      props: {
        item: createProposalItem({
          proposalKind: 'report-cleanup',
          label: '删除 6 份报告',
          requiresModalConfirm: true,
          releaseBytes: 1024 * 1024,
        }),
      },
    })

    const primary = wrapper
      .findAll('button')
      .find((button) => button.text() === '删除 6 份报告')
    expect(primary).toBeDefined()
    await primary!.trigger('click')

    expect(wrapper.emitted('requestConfirm')).toHaveLength(1)
    expect(wrapper.emitted('apply')).toBeUndefined()
    wrapper.unmount()
  })

  it('终态定格：applied 显示「已应用」并隐藏按钮', () => {
    const wrapper = mount(WorkbenchProposalCard, {
      props: { item: createProposalItem({ state: 'applied', status: 'done' }) },
    })

    expect(wrapper.text()).toContain('已应用')
    expect(wrapper.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  })

  it('终态定格：conflict / failed / expired 各显示对应文案', () => {
    const conflict = mount(WorkbenchProposalCard, {
      props: {
        item: createProposalItem({
          state: 'conflict',
          resultMessage: '用例已被其他入口修改，请重新生成提案。',
        }),
      },
    })
    expect(conflict.text()).toContain('用例已被其他入口修改，请重新生成提案。')
    conflict.unmount()

    const failed = mount(WorkbenchProposalCard, {
      props: { item: createProposalItem({ state: 'failed' }) },
    })
    expect(failed.text()).toContain('应用失败')
    failed.unmount()

    const expired = mount(WorkbenchProposalCard, {
      props: { item: createProposalItem({ state: 'expired' }) },
    })
    expect(expired.text()).toContain('已失效')
    expect(expired.findAll('button')).toHaveLength(0)
    expired.unmount()
  })

  it('skillMissing 时标注「用例已删除」并禁用入口（L2d）', () => {
    const wrapper = mount(WorkbenchProposalCard, {
      props: { item: createProposalItem({ skillMissing: true }) },
    })

    expect(wrapper.text()).toContain('用例已删除')
    expect(wrapper.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  })

  it('env-fill：输入框为密码型，说明文案与值一起随 apply 抛出', async () => {
    const wrapper = mount(WorkbenchProposalCard, {
      props: {
        item: createProposalItem({
          proposalKind: 'env-fill',
          label: '补齐环境变量',
          envKeys: [{ key: 'E2E_PASSWORD', usage: '登录口令' }],
        }),
      },
    })

    expect(wrapper.text()).toContain('不会出现在对话与日志中')
    // 密码型输入：naive-ui 的 n-input 渲染 type=password 的 input。
    const input = wrapper.get('input')
    expect(input.attributes('type')).toBe('password')

    await input.setValue('s3cret')
    const save = wrapper
      .findAll('button')
      .find((button) => button.text() === '保存')
    await save!.trigger('click')

    expect(wrapper.emitted('apply')?.[0]?.[1]).toEqual({
      E2E_PASSWORD: 's3cret',
    })
    wrapper.unmount()
  })
})

describe('WorkbenchProposalConfirmModal（D2 / L1a / L2a）', () => {
  it('复述数量与对象、给出不可撤销警告', () => {
    const wrapper = mount(WorkbenchProposalConfirmModal, {
      props: {
        show: true,
        proposal: createProposalItem({
          proposalKind: 'case-delete',
          label: '删除用例「云7登录」',
          reportCount: 6,
          requiresModalConfirm: true,
          changes: [{ target: '用例', op: 'remove', after: '云7登录' }],
        }),
      },
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('确认删除用例？')
    expect(text).toContain('将一并删除 6 份报告')
    expect(text).toContain('不可撤销')
    wrapper.unmount()
  })

  it('弹框内取消只关窗，不发任何请求（proposal 仍是 pending）', async () => {
    const wrapper = mount(WorkbenchProposalConfirmModal, {
      props: {
        show: true,
        proposal: createProposalItem({ requiresModalConfirm: true }),
      },
    })

    const cancel = document.body.querySelector('button')
    expect(cancel).not.toBeNull()
    // naive-ui 的按钮文本为「取消」；此处按文本定位避免顺序依赖。
    const buttons = Array.from(document.body.querySelectorAll('button'))
    const cancelButton = buttons.find((node) => node.textContent === '取消')
    expect(cancelButton).toBeDefined()
    cancelButton!.click()
    await wrapper.vm.$nextTick()

    // 只抛 update:show(false)，**没有 confirm**——这正是「取消不发请求」的契约。
    expect(wrapper.emitted('update:show')?.at(-1)).toEqual([false])
    expect(wrapper.emitted('confirm')).toBeUndefined()
    wrapper.unmount()
  })

  it('弹框内确认向上抛出提案（由面板层发 apply）', async () => {
    const wrapper = mount(WorkbenchProposalConfirmModal, {
      props: {
        show: true,
        proposal: createProposalItem({
          proposalKind: 'report-cleanup',
          requiresModalConfirm: true,
        }),
      },
    })

    const buttons = Array.from(document.body.querySelectorAll('button'))
    const confirmButton = buttons.find((node) => node.textContent === '确认')
    expect(confirmButton).toBeDefined()
    confirmButton!.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('WorkbenchBatchCard（v17 R4）', () => {
  it('待确认态：逐条就绪状态 + 提前写明停止/取消语义', () => {
    const wrapper = mount(WorkbenchBatchCard, {
      props: { item: createBatchItem() },
    })

    const text = wrapper.text()
    expect(text).toContain('就绪')
    expect(text).toContain('缺少环境变量')
    expect(text).toContain('取消')
    expect(text).toContain('不产生执行记录')
    wrapper.unmount()
  })

  it('执行中态：写明「停止会终止整个批次、剩余标记未执行」（R4e）', () => {
    const wrapper = mount(WorkbenchBatchCard, {
      props: {
        item: createBatchItem({
          batchStatus: 'running',
          items: [
            {
              skillId: 'a',
              skillTitle: '云7登录',
              status: 'running',
              executionId: 'exec-1',
            },
            { skillId: 'b', skillTitle: '结算', status: 'pending' },
          ],
        }),
      },
      global: { stubs: { WorkbenchExecutionBody: true } },
    })

    const text = wrapper.text()
    expect(text).toContain('停止会终止整个批次')
    expect(text).toContain('剩余条目标记为未执行')
    expect(text).toContain('第 1 / 2 个')
    wrapper.unmount()
  })

  it('终态：给出汇总（通过 / 失败 / 跳过 / 未执行）与报告入口', async () => {
    const wrapper = mount(WorkbenchBatchCard, {
      props: {
        item: createBatchItem({
          batchStatus: 'completed',
          taskStatus: 'completed',
          items: [
            {
              skillId: 'a',
              skillTitle: '云7登录',
              status: 'passed',
              runId: 'r1',
            },
            { skillId: 'b', skillTitle: '结算', status: 'failed' },
            {
              skillId: 'c',
              skillTitle: '订单',
              status: 'skipped',
              skippedReason: '缺脚本',
            },
            { skillId: 'd', skillTitle: '退款', status: 'not-executed' },
          ],
        }),
      },
    })

    const text = wrapper.text()
    expect(text).toContain('通过 1')
    expect(text).toContain('失败 1')
    expect(text).toContain('跳过 1')
    expect(text).toContain('未执行 1')
    expect(text).toContain('缺脚本')
    // 无中断条目时不展示「中断 0」（零值行是噪音，与报告卡同一口径）。
    expect(text).not.toContain('中断 0')

    // 只有带 runId 的条目才有报告入口。
    const reportButton = wrapper
      .findAll('button')
      .find((button) => button.text() === '查看报告')
    await reportButton!.trigger('click')
    expect(wrapper.emitted('openReport')?.[0]?.[0]).toEqual({
      skillId: 'a',
      skillTitle: '云7登录',
      runId: 'r1',
    })
    wrapper.unmount()
  })

  it('被停止的批次：中断条目计入汇总（R4e 的四数相加等于条目数）', async () => {
    const wrapper = mount(WorkbenchBatchCard, {
      props: {
        item: createBatchItem({
          batchStatus: 'interrupted',
          taskStatus: 'interrupted',
          items: [
            { skillId: 'a', skillTitle: '已跑完', status: 'passed' },
            // 点击停止时正在跑的那条：按中断处理（R4e）。
            { skillId: 'b', skillTitle: '被停止的', status: 'interrupted' },
            { skillId: 'c', skillTitle: '没轮到', status: 'not-executed' },
          ],
        }),
      },
    })

    const text = wrapper.text()
    // 中断数必须出现——否则「通过 1 / 未执行 1」会漏掉一条，
    // 用户会以为有条目凭空消失。
    expect(text).toContain('中断 1')
    expect(text).toContain('通过 1')
    expect(text).toContain('未执行 1')
    // 停止语义要在终态再说明一次（R4e 要求提前写明）。
    expect(text).toContain('剩余条目按未执行处理')
    wrapper.unmount()
  })

  it('取消 / 开始 / 停止各自向上抛出（由面板层调接口）', async () => {
    const awaiting = mount(WorkbenchBatchCard, {
      props: { item: createBatchItem() },
    })
    const buttons = awaiting.findAll('button')
    await buttons[0]!.trigger('click')
    await buttons[1]!.trigger('click')
    expect(awaiting.emitted('cancel')).toHaveLength(1)
    expect(awaiting.emitted('confirm')).toHaveLength(1)
    awaiting.unmount()

    const running = mount(WorkbenchBatchCard, {
      props: { item: createBatchItem({ batchStatus: 'running' }) },
      global: { stubs: { WorkbenchExecutionBody: true } },
    })
    await running.get('button').trigger('click')
    expect(running.emitted('stop')).toHaveLength(1)
    running.unmount()
  })
})

describe('L2d：用例已删除时禁用入口（v16 卡片的回归）', () => {
  it('动作卡片：标注「用例已删除」且按钮不可点', async () => {
    const actionItem = createWorkbenchActionItem(
      eventOf(9, 'action-1', {
        type: 'workbench_action',
        phase: 'begin',
        actionId: 'a1',
        action: 'execute-test',
        skillId: 'abc123456',
        label: '执行测试',
        state: 'pending',
      }) as never,
    )

    const wrapper = mount(WorkbenchActionCard, {
      props: { item: { ...actionItem, skillMissing: true } },
    })

    expect(wrapper.text()).toContain('用例已删除')
    const button = wrapper.get('button')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(wrapper.emitted('trigger')).toBeUndefined()
    wrapper.unmount()
  })

  it('报告卡片：标注已删除，且不渲染报告入口', () => {
    const reportItem = createWorkbenchReportItem(
      eventOf(10, 'report-1', {
        type: 'workbench_report',
        phase: 'begin',
        executionId: 'exec-1',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        taskStatus: 'completed',
        summary: { total: 1, passed: 1, runId: '20261009-120000' },
      }) as never,
    )

    const wrapper = mount(WorkbenchReportCard, {
      props: { item: { ...reportItem, skillMissing: true } },
    })

    expect(wrapper.text()).toContain('该用例已被删除')
    expect(wrapper.text()).not.toContain('查看测试报告')
    wrapper.unmount()
  })
})

describe('WorkbenchTaskCard 的 batch 分派', () => {
  it('taskKind 为 batch 时渲染连续执行卡，不落到生成分支（v-else 之前）', () => {
    const wrapper = mount(WorkbenchTaskCard, {
      props: { item: createBatchItem() },
      global: {
        stubs: {
          WorkbenchExecutionBody: true,
          WorkbenchGenerationBody: true,
        },
      },
    })

    expect(wrapper.findComponent(WorkbenchBatchCard).exists()).toBe(true)
    expect(wrapper.text()).toContain('连续执行：')
    // batch 分支若排在 v-else 之后，这里会落到生成分支去订阅不存在的子会话。
    expect(
      wrapper.findComponent({ name: 'WorkbenchGenerationBody' }).exists(),
    ).toBe(false)
    wrapper.unmount()
  })
})

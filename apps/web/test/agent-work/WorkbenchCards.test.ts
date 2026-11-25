/**
 * 工作台两类新卡片（v16）的组件测试。
 *
 * 覆盖：
 *   - 动作卡片的可点性判定（pending 可点 / consumed 与 expired 定格）；
 *   - 任务卡片的 taskKind 分派与终态摘要（执行统计、生成诊断徽标、报告入口）；
 *   - 报告弹窗的 missing 分支（RPT-5：报告被删时明确提示，不渲染空白）。
 *
 * 不覆盖嵌套子组件（执行区块 / 子会话时间线）的网络取数：那属于各自的
 * 既有测试范围，此处只锁卡片自身的分派与文案契约。
 */
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import WorkbenchActionCard from '../../src/modules/agent-work/components/WorkbenchActionCard.vue'
import WorkbenchTaskCard from '../../src/modules/agent-work/components/WorkbenchTaskCard.vue'
import WorkbenchReportCard from '../../src/modules/agent-work/components/WorkbenchReportCard.vue'
import ReportDialog from '../../src/modules/agent-work/components/ReportDialog.vue'
import type {
  IWorkbenchActionTimelineItem,
  IWorkbenchReportTimelineItem,
  IWorkbenchTaskTimelineItem,
} from '../../src/modules/agent-work/timeline'

/**
 * 构造动作卡片项。
 * @param overrides 需要覆盖的字段。
 * @returns 动作卡片项。
 * @throws 不抛出异常。
 */
function createActionItem(
  overrides: Partial<IWorkbenchActionTimelineItem> = {},
): IWorkbenchActionTimelineItem {
  return {
    kind: 'workbench_action',
    blockId: 'action-block-1',
    seq: 1,
    status: 'pending',
    actionId: 'action-1',
    action: 'generate-playwright-script',
    skillId: 'abc123456',
    skillTitle: '云7登录',
    label: '生成 Playwright 脚本',
    state: 'pending',
    ...overrides,
  }
}

/**
 * 构造任务卡片项。
 * @param overrides 需要覆盖的字段。
 * @returns 任务卡片项。
 * @throws 不抛出异常。
 */
function createTaskItem(
  overrides: Partial<IWorkbenchTaskTimelineItem> = {},
): IWorkbenchTaskTimelineItem {
  return {
    kind: 'workbench_task',
    blockId: 'task-block-1',
    seq: 2,
    status: 'streaming',
    taskId: 'exec-1',
    taskKind: 'execution',
    skillId: 'abc123456',
    skillTitle: '云7登录',
    taskStatus: 'running',
    startedAt: Date.now(),
    executionId: 'exec-1',
    ...overrides,
  }
}

describe('WorkbenchActionCard', () => {
  it('pending 时按钮可点，点击向上抛出该卡片', async () => {
    const wrapper = mount(WorkbenchActionCard, {
      props: { item: createActionItem() },
    })

    await wrapper.find('button').trigger('click')

    const emitted = wrapper.emitted('trigger')
    expect(emitted).toHaveLength(1)
    expect(emitted?.[0]?.[0]).toMatchObject({ actionId: 'action-1' })
    wrapper.unmount()
  })

  it('consumed 后按钮禁用并展示定格徽标', async () => {
    const wrapper = mount(WorkbenchActionCard, {
      props: { item: createActionItem({ state: 'consumed', status: 'done' }) },
    })

    const button = wrapper.find('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('已执行')

    await button.trigger('click')
    expect(wrapper.emitted('trigger')).toBeUndefined()
    wrapper.unmount()
  })

  it('expired 展示失效徽标且不可点', () => {
    const wrapper = mount(WorkbenchActionCard, {
      props: { item: createActionItem({ state: 'expired' }) },
    })

    expect(wrapper.text()).toContain('已失效')
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('展示目标用例与补充说明', () => {
    const wrapper = mount(WorkbenchActionCard, {
      props: {
        item: createActionItem({
          description:
            '当前 test.spec.ts 已被手工修改，重新生成会覆盖这些改动。',
        }),
      },
    })

    expect(wrapper.text()).toContain('云7登录')
    expect(wrapper.text()).toContain('已被手工修改')
    wrapper.unmount()
  })
})

/**
 * 构造报告卡片项。
 * @param overrides 需要覆盖的字段。
 * @returns 报告卡片项。
 * @throws 不抛出异常。
 */
function createReportItem(
  overrides: Partial<IWorkbenchReportTimelineItem> = {},
): IWorkbenchReportTimelineItem {
  return {
    kind: 'workbench_report',
    blockId: 'report-block-1',
    seq: 3,
    status: 'done',
    executionId: 'exec-1',
    skillId: 'abc123456',
    skillTitle: '云7登录',
    taskStatus: 'completed',
    summary: { total: 1, passed: 1, failed: 0, runId: 'r1' },
    ...overrides,
  }
}

describe('WorkbenchReportCard', () => {
  it('按 PRD RPT-2 展示统计 / 耗时 / 运行时间 / 目标 URL', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: {
            total: 1,
            passed: 1,
            failed: 0,
            interrupted: 0,
            skipped: 0,
            durationMs: 12_345,
            runId: '20260930-192916',
            startedAt: '2026-09-30T19:29:16.000Z',
            baseUrl: 'https://test-v1.cloudpivot.cn/platform/#/login',
          },
        }),
      },
    })

    const text = wrapper.text()
    expect(text).toContain('执行结果结论')
    expect(text).toContain('20260930-192916')
    expect(text).toContain('用例总数')
    expect(text).toContain('1 条')
    expect(text).toContain('12.3s')
    expect(text).toContain('运行时间：')
    expect(text).toContain('https://test-v1.cloudpivot.cn/platform/#/login')
    wrapper.unmount()
  })

  it('全部通过时结论文案为成功态', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: { total: 2, passed: 2, failed: 0, runId: 'r1' },
        }),
      },
    })

    expect(wrapper.text()).toContain('全部通过')
    wrapper.unmount()
  })

  it('存在失败时结论文案为失败态', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: { total: 2, passed: 1, failed: 1, runId: 'r1' },
        }),
      },
    })

    expect(wrapper.text()).toContain('存在失败用例')
    wrapper.unmount()
  })

  it('中断态结论为「执行已中断」', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          taskStatus: 'interrupted',
          summary: {
            total: 2,
            passed: 1,
            failed: 0,
            interrupted: 1,
            runId: 'r1',
          },
        }),
      },
    })

    expect(wrapper.text()).toContain('执行已中断')
    // 非零的中断计数单独成行。
    expect(wrapper.text()).toContain('中断')
    wrapper.unmount()
  })

  it('跳过与中断为 0 时不占行（零值行是噪音）', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: {
            total: 1,
            passed: 1,
            failed: 0,
            interrupted: 0,
            skipped: 0,
            runId: 'r1',
          },
        }),
      },
    })

    expect(wrapper.text()).not.toContain('跳过')
    expect(wrapper.text()).not.toContain('中断')
    wrapper.unmount()
  })

  it('底部「查看测试报告」点击时向上抛出 Skill 与运行编号（RPT-3）', async () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: { total: 1, passed: 1, failed: 0, runId: '20260930-192916' },
        }),
      },
    })

    const button = wrapper
      .findAll('button')
      .find((node) => node.text().includes('查看测试报告'))
    expect(button).toBeDefined()
    await button!.trigger('click')

    expect(wrapper.emitted('openReport')?.[0]?.[0]).toEqual({
      skillId: 'abc123456',
      skillTitle: '云7登录',
      runId: '20260930-192916',
    })
    wrapper.unmount()
  })

  it('无运行编号时不展示报告入口（点开必然 missing）', () => {
    const wrapper = mount(WorkbenchReportCard, {
      props: {
        item: createReportItem({
          summary: { total: 1, passed: 1, failed: 0 },
        }),
      },
    })

    expect(wrapper.text()).not.toContain('查看测试报告')
    wrapper.unmount()
  })

  /**
   * 报告卡片与执行卡片是**平级的两张卡**：执行卡片记过程、报告卡片记结果。
   * 本断言锁住「报告卡片不被塞进执行卡片内部」——那是本次修正的形态问题。
   */
  it('报告卡片独立渲染，不嵌套在执行卡片内', () => {
    const card = mount(WorkbenchTaskCard, {
      props: {
        item: createTaskItem({
          taskStatus: 'completed',
          summary: { total: 1, passed: 1, failed: 0, runId: 'r1' },
        }),
      },
      global: { stubs: { WorkbenchExecutionBody: true } },
    })

    // 执行卡片自己不再画统计表与报告入口。
    expect(card.text()).not.toContain('执行结果结论')
    expect(card.text()).not.toContain('查看测试报告')
    card.unmount()
  })
})

describe('WorkbenchTaskCard', () => {
  it('生成任务终态展示诊断计数徽标（v15 的质量分级）', () => {
    const wrapper = mount(WorkbenchTaskCard, {
      props: {
        item: createTaskItem({
          taskKind: 'generation',
          taskId: 'generation-1',
          taskStatus: 'completed',
          status: 'done',
          summary: { diagnostics: 2 },
        }),
        onOpenReport: () => undefined,
      },
      global: { stubs: { WorkbenchGenerationBody: true } },
    })

    expect(wrapper.text()).toContain('2 项提示')
    wrapper.unmount()
  })

  it('失败任务展示原因、且不展示报告入口', () => {
    const wrapper = mount(WorkbenchTaskCard, {
      props: {
        item: createTaskItem({
          taskStatus: 'failed',
          status: 'failed',
          errorMessage: '脚本未通过静态校验：包含被禁止的 API。',
          summary: { runId: 'x' },
        }),
        onOpenReport: () => undefined,
      },
      global: { stubs: { WorkbenchExecutionBody: true } },
    })

    expect(wrapper.text()).toContain('失败')
    expect(wrapper.text()).toContain('被禁止的 API')
    wrapper.unmount()
  })
})

describe('ReportDialog', () => {
  // n-modal 将内容 teleport 到 body；统一恢复网络替身并清理弹窗内容。
  const originalDialogFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalDialogFetch
    document.body.innerHTML = ''
  })

  it('报告加载成功后用 srcdoc 渲染，iframe 不再依赖 blob 地址', async () => {
    setActivePinia(createPinia())
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            '<!doctype html><html><body><main>Agent 报告内容</main></body></html>',
        }) as Response,
    )

    const wrapper = mount(ReportDialog, {
      props: {
        show: true,
        skillId: 'abc123456',
        skillTitle: '云7登录',
        runId: '20260930-120000',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    const iframe = document.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute('srcdoc')).toContain('Agent 报告内容')
    expect(iframe?.hasAttribute('src')).toBe(false)

    wrapper.unmount()
  })

  it('报告不存在时提示「报告文件不存在」（RPT-5）', async () => {
    setActivePinia(createPinia())
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => ({ status: 404 }) as Response)

    const wrapper = mount(ReportDialog, {
      props: {
        show: true,
        skillId: 'abc123456',
        skillTitle: '云7登录',
        runId: '20260930-120000',
      },
    })
    // n-modal 的内容 teleport 到 body，因此从 document 断言而非 wrapper。
    await new Promise((resolve) => setTimeout(resolve, 0))
    await wrapper.vm.$nextTick()

    expect(document.body.textContent ?? '').toContain('报告文件不存在')
    // 不得渲染空白 iframe（静默失败的反面）。
    expect(document.querySelector('iframe')).toBeNull()

    wrapper.unmount()
  })
})

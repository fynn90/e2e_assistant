/**
 * v17 只读视图卡（`workbench_view`）的组件测试（PRD Q1–Q7 / R3 / H2）。
 *
 * 覆盖五个 `viewKind` 的分派与关键文案：
 *   - 清单卡：**有 `inlineActionId` 才渲染按钮**（Q6 的登记与呈现解耦）、
 *     筛选说明（Q3）、行内点击向上抛出 (item, actionId)；
 *   - 历史卡：从未执行过的如实说明与「更早报告在开发页」的截断提示（Q7）；
 *   - 体检卡：修复入口与「全部通过时的执行」按宿主下发的动作登记 ID 渲染
 *     按钮（`fixActionId` / `executeActionId`），点击向上抛出 actionId；
 *     **没有 ID 就不渲染按钮**——凭空调动作接口会得到「动作不存在」，
 *     那正是 C9 禁止的「点了没反应」；
 *   - 未知 `viewKind` 落到兜底文案，而不是渲染空白卡片。
 *
 * dispatcher 层的「不落到 ContentBlock 兜底」在 `WorkbenchV17Cards.test.ts` 断言。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import WorkbenchViewCard from '../../src/modules/agent-work/components/WorkbenchViewCard.vue'
import { createViewItem } from './fixtures/workbench-v17-fixtures'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('WorkbenchViewCard（v17 Q 组）', () => {
  it('按 viewKind 分派到对应子视图，不落到兜底文案', () => {
    const capability = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'capability',
          payload: {
            domains: [{ key: 'q', label: '问询', examples: ['有哪些用例'] }],
            notSupported: [{ label: '定时执行', alternative: '手动执行' }],
          },
        }),
      },
    })
    expect(capability.text()).toContain('我能做什么')
    expect(capability.text()).toContain('问询')
    expect(capability.text()).toContain('定时执行')
    expect(capability.text()).not.toContain('还不支持')
    capability.unmount()

    const list = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'skill-list',
          payload: { rows: [], total: 0 },
        }),
      },
    })
    expect(list.text()).toContain('用例清单')
    list.unmount()
  })

  it('未知 viewKind 如实说明，不渲染空白卡片', () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'future-kind' as never,
          payload: {},
        }),
      },
    })

    expect(wrapper.text()).toContain('还不支持')
    wrapper.unmount()
  })

  it('清单卡：有 inlineActionId 才渲染按钮，缺省行不渲染（Q6 登记与呈现解耦）', () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'skill-list',
          payload: {
            total: 2,
            filter: { status: 'last-failed' },
            rows: [
              {
                skillId: 'abc123456',
                title: '云7登录',
                description: '登录主流程',
                hasSkillDocument: false,
                hasPlaywrightScript: false,
                inlineActionId: 'inline-1',
                inlineAction: 'generate-skill-document',
              },
              {
                skillId: 'abc123457',
                title: '结算',
                description: '',
                hasSkillDocument: true,
                hasPlaywrightScript: true,
              },
            ],
          },
        }),
      },
    })

    expect(wrapper.text()).toContain('按状态「最近失败」筛出 2 个用例')
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toBe('生成 SKILL.md')
    wrapper.unmount()
  })

  it('清单卡：点击行内按钮向上抛出 (item, actionId)', async () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'skill-list',
          payload: {
            total: 1,
            rows: [
              {
                skillId: 'abc123456',
                title: '云7登录',
                description: '',
                hasSkillDocument: true,
                hasPlaywrightScript: true,
                inlineActionId: 'inline-9',
                inlineAction: 'execute-test',
              },
            ],
          },
        }),
      },
    })

    await wrapper.get('button').trigger('click')

    // 视图卡向上抛 (item, actionId)：面板据此调动作接口（Q6）。
    const emitted = wrapper.emitted('inlineAction')?.[0]
    expect(emitted?.[0]).toMatchObject({ kind: 'workbench_view' })
    expect(emitted?.[1]).toBe('inline-9')
    wrapper.unmount()
  })

  it('历史卡：从未执行过时如实说明；被截断时补一句开发页提示（Q7）', () => {
    const never = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'run-history',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            runs: [],
            truncatedAt: 0,
            neverExecuted: true,
          },
        }),
      },
    })
    expect(never.text()).toContain('还没有执行过')
    never.unmount()

    const truncated = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'run-history',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            runs: [
              {
                runId: 'r1',
                startedAt: '2026-10-08T10:00:00.000Z',
                passed: 1,
                failed: 0,
                interrupted: 0,
                skipped: 0,
                total: 1,
                durationMs: 1000,
              },
            ],
            truncatedAt: 9,
            neverExecuted: false,
          },
        }),
      },
    })
    expect(truncated.text()).toContain('更早的报告可在该用例的开发页查看')
    truncated.unmount()
  })

  it('体检卡：无动作登记 ID 时不渲染按钮（登记与呈现解耦）', () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'readiness',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            ok: true,
            checks: [{ code: 'J1', label: '脚本存在', ok: true }],
          },
        }),
      },
    })

    expect(wrapper.text()).toContain('全部通过')
    // 宿主没登记动作 → 没有可点的入口 → 不渲染按钮（好过渲染一个点了报错的）。
    expect(wrapper.findAll('button')).toHaveLength(0)
    wrapper.unmount()
  })

  it('体检卡：全通过时渲染「执行」按钮并向上抛出 actionId（R3 ③）', async () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'readiness',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            ok: true,
            checks: [{ code: 'J1', label: '脚本存在', ok: true }],
            executeActionId: 'act-exec-1',
          },
        }),
      },
    })

    const button = wrapper.findAll('button')[0]!
    expect(button.text()).toBe('执行')
    await button.trigger('click')
    expect(wrapper.emitted('inlineAction')?.[0]?.[1]).toBe('act-exec-1')
    wrapper.unmount()
  })

  it('体检卡：未通过项带 fixActionId 时渲染修复按钮并抛出（Q6/E3 同构）', async () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'readiness',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            ok: false,
            checks: [
              {
                code: 'EXECUTION_SPEC_MISSING',
                label: '脚本存在',
                ok: false,
                message: 'test.spec.ts 不存在，无法执行。',
                fixAction: 'generate-playwright-script',
                fixActionId: 'act-gen-1',
              },
              // 环境变量缺失这类修复要走提案通道，没有动作登记 ID。
              {
                code: 'ENV_REFERENCE_MISSING',
                label: '环境变量齐备',
                ok: false,
                message: '脚本引用的 key "E2E_PASSWORD" 不存在。',
              },
            ],
          },
        }),
      },
    })

    const buttons = wrapper.findAll('button')
    // 只有登记过动作的那一项才有按钮。
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.text()).toBe('生成脚本')
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('inlineAction')?.[0]?.[1]).toBe('act-gen-1')

    // 未通过项的原因必须给出（R3 ②）。
    expect(wrapper.text()).toContain('E2E_PASSWORD')
    wrapper.unmount()
  })

  it('体检卡：有动作在途时按钮禁用（防重复点击）', () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        pendingActionId: 'act-exec-1',
        item: createViewItem({
          viewKind: 'readiness',
          payload: {
            skillId: 'abc123456',
            skillTitle: '云7登录',
            ok: true,
            checks: [{ code: 'J1', label: '脚本存在', ok: true }],
            executeActionId: 'act-exec-1',
          },
        }),
      },
    })

    expect(wrapper.findAll('button')[0]!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('详情卡：默认收起文档原文，且只列 env key（Q4/Q5 + D7）', async () => {
    const wrapper = mount(WorkbenchViewCard, {
      props: {
        item: createViewItem({
          viewKind: 'skill-detail',
          payload: {
            skillId: 'abc123456',
            title: '云7登录',
            description: '登录主流程',
            preconditions: [{ id: 'p1', description: '账号已开通' }],
            steps: [
              {
                id: 's1',
                order: 1,
                description: '打开登录页',
                action: 'navigate',
                expectedResult: '看到登录表单',
                enabled: true,
              },
            ],
            hasSkillDocument: true,
            hasPlaywrightScript: true,
            envKeys: ['E2E_USER', 'E2E_PASSWORD'],
            missingEnvKeys: ['E2E_PASSWORD'],
            documentContent: '# 云7登录\n正文内容',
          },
        }),
      },
    })

    const text = wrapper.text()
    expect(text).toContain('账号已开通')
    expect(text).toContain('打开登录页')
    expect(text).toContain('E2E_PASSWORD（缺失）')
    expect(text).toContain('在开发页打开')
    // Q5：文档原文默认收起，正文不得出现在卡片文本里。
    expect(text).not.toContain('正文内容')

    const toggle = wrapper
      .findAll('button')
      .find((button) => button.text().includes('查看文档原文'))
    expect(toggle).toBeDefined()
    await toggle!.trigger('click')
    expect(wrapper.text()).toContain('正文内容')
    wrapper.unmount()
  })
})

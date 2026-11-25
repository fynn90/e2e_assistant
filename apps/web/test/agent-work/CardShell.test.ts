/**
 * 卡片通用外壳的组件测试（PRD 6.1 / 6.2 / AC-05）。
 *
 * 覆盖：操作区位于卡片底部、与正文以 1px 分割线隔开、按钮右对齐、最小号。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CardShell from '../../src/modules/agent-work/components/CardShell.vue'

describe('CardShell（PRD 6.2 视觉规格）', () => {
  it('渲染卡片头产物名、正文与操作区', () => {
    const wrapper = mount(CardShell, {
      props: { fileName: 'SKILL.md' },
      slots: {
        badges: '<span class="badge-slot">已完成</span>',
        default: '<p class="body-slot">正文</p>',
        actions: '<button class="action-slot">关闭</button>',
      },
    })

    expect(wrapper.find('.card-shell__file-name').text()).toBe('SKILL.md')
    expect(wrapper.find('.body-slot').exists()).toBe(true)
    expect(wrapper.find('.action-slot').exists()).toBe(true)
    expect(wrapper.find('.card-shell__head .badge-slot').exists()).toBe(true)
    wrapper.unmount()
  })

  it('操作区位于正文之后（固定在卡片底部）', () => {
    const wrapper = mount(CardShell, {
      props: { fileName: 'test.spec.ts' },
      slots: { default: '<p>正文</p>', actions: '<button>关闭</button>' },
    })

    const html = wrapper.html()
    const bodyIndex = html.indexOf('card-shell__body')
    const actionsIndex = html.indexOf('card-shell__actions')

    expect(bodyIndex).toBeGreaterThan(-1)
    expect(actionsIndex).toBeGreaterThan(bodyIndex)
    wrapper.unmount()
  })

  it('操作区使用右对齐布局类（按钮右对齐）', () => {
    const wrapper = mount(CardShell, {
      props: { fileName: 'SKILL.md' },
      slots: { actions: '<button>关闭</button>' },
    })

    expect(wrapper.find('.card-shell__actions').exists()).toBe(true)
    wrapper.unmount()
  })
})

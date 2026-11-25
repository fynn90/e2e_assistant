/**
 * 验证就绪说明可聚焦并把字段导航作为显式组件事件上报。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import E2ETestCaseReadinessPanel from '../../src/modules/e2e-test-case/components/E2ETestCaseReadinessPanel.vue'

const reason = {
  key: 'base-url',
  path: 'baseUrl',
  targetId: 'e2e-base-url',
  label: '目标 URL',
  message: '目标 URL 不能为空。',
}

describe('E2ETestCaseReadinessPanel', () => {
  it('focuses the summary and emits the selected field reason', async () => {
    const wrapper = mount(E2ETestCaseReadinessPanel, {
      attachTo: document.body,
      props: {
        actionLabel: '保存并生成',
        reasons: [reason],
      },
      global: {
        stubs: {
          NAlert: { template: '<div><slot /></div>' },
          NButton: {
            emits: ['click'],
            template: '<button @click="$emit(\'click\')"><slot /></button>',
          },
        },
      },
    })

    wrapper.vm.focus()
    expect(document.activeElement).toBe(wrapper.get('.readiness-panel').element)
    expect(wrapper.text()).toContain('保存并生成前还需要完成')

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([[reason]])
    wrapper.unmount()
  })

  it('explains the save-then-generate sequence before a valid dirty generation', () => {
    const wrapper = mount(E2ETestCaseReadinessPanel, {
      props: {
        actionLabel: '保存并生成',
        reasons: [],
        requiresSave: true,
      },
      global: {
        stubs: {
          NAlert: { template: '<div><slot /></div>' },
          NButton: true,
        },
      },
    })

    // v9 起生成完成即落盘，不再有「确认」这一步；提示应说明保存成功后自动开始。
    expect(wrapper.text()).toContain('将先保存结构化用例')
    expect(wrapper.text()).toContain('保存成功后自动开始')
    expect(wrapper.text()).toContain('无需再确认')
    expect(wrapper.text()).not.toContain('确认前不会提交生成元数据')
  })
})

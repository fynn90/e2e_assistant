/**
 * 验证测试步骤列表的展开控制、错误导航入口和新增步骤数据流。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TestStepTable from '../../src/modules/e2e-test-case/components/TestStepTable.vue'

const firstStep = {
  id: 'step_one',
  order: 1,
  description: '打开登录页',
  action: '打开页面',
  expectedResult: '显示登录表单',
  testData: {},
  enabled: true,
}

function mountTable(errors: Record<string, string> = {}) {
  return mount(TestStepTable, {
    props: { modelValue: [firstStep], errors },
    global: {
      stubs: {
        NAlert: { template: '<div><slot /></div>' },
        NEmpty: {
          props: ['description'],
          template: '<div>{{ description }}</div>',
        },
        NSpace: { template: '<div><slot /></div>' },
        NButton: {
          emits: ['click'],
          template:
            '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
        },
        TestStepRow: {
          props: ['step', 'index', 'expanded'],
          emits: ['toggle'],
          template:
            '<article class="step-stub" :data-index="index" :data-expanded="expanded"><button class="row-toggle" @click="$emit(\'toggle\')">toggle</button></article>',
        },
      },
    },
  })
}

describe('TestStepTable', () => {
  it('opens the first step and supports expand-all controls', async () => {
    const wrapper = mountTable()

    expect(wrapper.get('.step-stub').attributes('data-expanded')).toBe('true')
    const collapseAll = wrapper
      .findAll('button')
      .find((button) => button.text() === '收起全部')
    await collapseAll!.trigger('click')
    expect(wrapper.get('.step-stub').attributes('data-expanded')).toBe('false')

    const expandAll = wrapper
      .findAll('button')
      .find((button) => button.text() === '展开全部')
    await expandAll!.trigger('click')
    expect(wrapper.get('.step-stub').attributes('data-expanded')).toBe('true')
  })

  it('adds a new ordered step and exposes error-step navigation', async () => {
    const wrapper = mountTable({ 'steps.0.action': '操作动作不能为空。' })

    expect(wrapper.text()).toContain('定位错误步骤（1）')
    const add = wrapper
      .findAll('button')
      .find((button) => button.text() === '新增步骤')
    await add!.trigger('click')
    const nextSteps = wrapper
      .emitted('update:modelValue')
      ?.at(-1)?.[0] as (typeof firstStep)[]

    expect(nextSteps).toHaveLength(2)
    expect(nextSteps[1]).toMatchObject({ order: 2, enabled: true })
    await wrapper.setProps({ modelValue: nextSteps })
    expect(wrapper.findAll('.step-stub')[1]?.attributes('data-expanded')).toBe(
      'true',
    )
  })
})

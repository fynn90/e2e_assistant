/**
 * 验证测试步骤的渐进披露、可访问名称和更多操作事件。
 */
import { mount } from '@vue/test-utils'
import { NDropdown } from 'naive-ui'
import { describe, expect, it } from 'vitest'
import TestStepRow from '../../src/modules/e2e-test-case/components/TestStepRow.vue'

const step = {
  id: 'step_login',
  order: 1,
  description: '打开登录页面',
  action: '填写账号密码并提交',
  expectedResult: '进入工作台',
  testData: {},
  enabled: true,
}

function mountRow(expanded: boolean) {
  return mount(TestStepRow, {
    props: {
      step,
      index: 0,
      total: 2,
      errors: {},
      expanded,
    },
    global: {
      stubs: {
        NAlert: { template: '<div><slot /></div>' },
        NButton: {
          props: ['disabled'],
          emits: ['click'],
          template:
            '<button :disabled="disabled" v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
        },
        NInput: {
          props: ['value', 'type', 'placeholder', 'inputProps'],
          emits: ['update:value'],
          template: `
            <textarea
              v-if="type === 'textarea'"
              v-bind="inputProps"
              :placeholder="placeholder"
              :value="value"
              @input="$emit('update:value', $event.target.value)"
            />
            <input
              v-else
              v-bind="inputProps"
              :placeholder="placeholder"
              :value="value"
              @input="$emit('update:value', $event.target.value)"
            />
          `,
        },
        NSwitch: {
          props: ['value'],
          emits: ['update:value'],
          template:
            '<button role="switch" :aria-checked="value" v-bind="$attrs" @click="$emit(\'update:value\', !value)" />',
        },
        NDropdown: {
          emits: ['select'],
          template: `
            <div>
              <slot />
              <button class="menu-option" @click="$emit('select', 'move-up')">上移</button>
              <button class="menu-option" @click="$emit('select', 'move-down')">下移</button>
              <button class="menu-option" @click="$emit('select', 'insert-after')">在后面插入</button>
              <button class="menu-option" @click="$emit('select', 'duplicate')">复制步骤</button>
              <button class="menu-option" @click="$emit('select', 'remove')">删除步骤</button>
            </div>
          `,
        },
      },
    },
  })
}

describe('TestStepRow', () => {
  it('keeps secondary editing hidden while preserving labelled controls', async () => {
    const wrapper = mountRow(false)

    expect(wrapper.text()).toContain('打开登录页面')
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.get('[role="switch"]').attributes('aria-label')).toBe(
      '停用步骤 1',
    )
    expect(
      wrapper
        .findAll('button')
        .some(
          (button) => button.attributes('aria-label') === '步骤 1 更多操作',
        ),
    ).toBe(true)

    const summaryButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('展开编辑'))
    await summaryButton!.trigger('click')
    expect(wrapper.emitted('toggle')).toHaveLength(1)

    wrapper.findComponent(NDropdown).vm.$emit('select', 'duplicate')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('duplicate')).toHaveLength(1)
  })

  it('shows Chinese domain placeholders and discloses test data on demand', async () => {
    const wrapper = mountRow(true)
    const placeholders = wrapper
      .findAll('textarea')
      .map((input) => input.attributes('placeholder'))

    expect(placeholders).toEqual([
      '例如：打开登录页面',
      '例如：填写账号密码并提交',
      '例如：进入工作台并显示用户名',
    ])
    expect(wrapper.text()).toContain('按需添加')
    expect(wrapper.text()).not.toContain('添加第一项测试数据')

    const testDataToggle = wrapper
      .findAll('button')
      .find((button) => button.text().includes('按需添加'))
    await testDataToggle!.trigger('click')
    const addFirst = wrapper
      .findAll('button')
      .find((button) => button.text() === '添加第一项测试数据')
    await addFirst!.trigger('click')

    expect(wrapper.emitted('update')?.at(-1)?.[0]).toMatchObject({
      testData: { key_1: '' },
    })
  })
})

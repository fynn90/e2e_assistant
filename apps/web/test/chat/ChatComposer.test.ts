import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ChatComposer from '../../src/common/chat/ChatComposer.vue'

describe('ChatComposer', () => {
  it('sends with Enter and keeps the controlled draft intact', async () => {
    const wrapper = mount(ChatComposer, {
      props: { modelValue: '检查当前文件' },
    })

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send')).toEqual([['检查当前文件']])
    expect(wrapper.props('modelValue')).toBe('检查当前文件')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('keeps Shift+Enter and IME Enter as text input interactions', async () => {
    const wrapper = mount(ChatComposer, {
      props: { modelValue: '继续输入' },
    })

    await wrapper
      .get('textarea')
      .trigger('keydown', { key: 'Enter', shiftKey: true })
    await wrapper
      .get('textarea')
      .trigger('keydown', { key: 'Enter', isComposing: true })

    expect(wrapper.emitted('send')).toBeUndefined()
  })

  it('allows drafting while streaming and exposes the stop action', async () => {
    const wrapper = mount(ChatComposer, {
      props: { modelValue: '下一条消息', streaming: true },
    })

    expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('button').text()).toBe('停止')

    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })
})

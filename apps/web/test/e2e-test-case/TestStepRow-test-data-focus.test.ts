/**
 * 验证「测试数据」输入框在逐字符输入键名时不会丢失焦点。
 * 回归背景：v-for 的 key 曾混入易变的键名，导致每输入一个字符就重建整行 DOM。
 */
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import TestStepRow from '../../src/modules/e2e-test-case/components/TestStepRow.vue'

const baseStep = {
  id: 'step_login',
  order: 1,
  description: '填写用户名和密码',
  action: '填写用户名或手机号和密码',
  expectedResult: '进入工作台',
  testData: { key_1: '' },
  enabled: true,
}

type TStep = typeof baseStep

/** 暴露内部草稿状态的 Harness 实例类型，用于断言连续输入后的落盘结果。 */
type THarnessVm = { step: TStep }

/** 模拟真实父级链路：把子组件 emit 的新步骤对象写回 props。 */
const Harness = defineComponent({
  setup(_, { expose }) {
    const step = ref<TStep>({ ...baseStep, testData: { ...baseStep.testData } })
    expose({ step })

    return () =>
      h(TestStepRow as never, {
        step: step.value,
        index: 0,
        total: 1,
        errors: {},
        expanded: true,
        onUpdate: (value: unknown) => {
          step.value = value as TStep
        },
      })
  },
})

/**
 * 在指定输入框中追加一个字符，模拟真实键盘键入。
 * @param wrapper 已挂载的组件包装器。
 * @param selector 目标输入框选择器。
 * @param char 待输入的单个字符。
 * @returns 输入后焦点是否仍然停留在同一 DOM 元素上。
 * @throws 选择器未匹配到元素时由测试包装器的 get 抛出异常。
 */
async function typeChar(
  wrapper: ReturnType<typeof mount>,
  selector: string,
  char: string,
): Promise<boolean> {
  const input = wrapper.get(selector).element as HTMLInputElement
  input.focus()
  input.value += char
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()

  // 元素未被重建时，activeElement 与新查询到的元素都应指向同一个原始节点
  return (
    document.activeElement === input && wrapper.get(selector).element === input
  )
}

describe('测试数据输入框焦点', () => {
  it('逐字符编辑数据键时应保持焦点且元素不被重建', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })

    // 先清空默认键名，模拟用户重新命名数据键
    const keyInput = wrapper.get('.test-data-row input')
      .element as HTMLInputElement
    keyInput.focus()
    keyInput.value = ''
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    const selector = '.test-data-row input[aria-label*="测试数据键"]'

    expect(await typeChar(wrapper, selector, 'u')).toBe(true)
    expect(await typeChar(wrapper, selector, 's')).toBe(true)
    expect(await typeChar(wrapper, selector, 'e')).toBe(true)

    // 连续输入应完整落盘为 use，而不是只剩最后一个字符
    expect((wrapper.vm as unknown as THarnessVm).step.testData).toEqual({
      use: '',
    })

    wrapper.unmount()
  })

  it('逐字符编辑数据值时应保持焦点且元素不被重建', async () => {
    const wrapper = mount(Harness, { attachTo: document.body })
    const selector = '.test-data-row input[aria-label*="测试数据值"]'

    expect(await typeChar(wrapper, selector, 'a')).toBe(true)
    expect(await typeChar(wrapper, selector, 'b')).toBe(true)

    expect((wrapper.vm as unknown as THarnessVm).step.testData).toEqual({
      key_1: 'ab',
    })

    wrapper.unmount()
  })
})

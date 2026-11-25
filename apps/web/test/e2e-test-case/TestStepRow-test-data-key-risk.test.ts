/**
 * 验证「测试数据」在增删场景下使用稳定行标识作为 v-for key 的数据正确性。
 * 背景：testData 为 Record<string, string>，键名可变，因此 v-for key 只能取下标。
 * 本文件重点覆盖下标 key 的经典风险场景——删除中间项后剩余行是否错位。
 */
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import TestStepRow from '../../src/modules/e2e-test-case/components/TestStepRow.vue'

type TTestData = Record<string, string>

/** 暴露内部草稿状态的 Harness 实例类型。 */
type THarnessVm = { step: { testData: TTestData } }

/**
 * 构造受控 Harness，把子组件 emit 的新步骤对象写回 props，模拟真实父级链路。
 * @param testData 初始测试数据。
 * @returns 已挂载的组件包装器。
 * @throws 不抛出异常。
 */
function mountHarness(testData: TTestData) {
  const Harness = defineComponent({
    setup(_, { expose }) {
      const step = ref({
        id: 'step_login',
        order: 1,
        description: '填写用户名和密码',
        action: '填写用户名或手机号和密码',
        expectedResult: '进入工作台',
        testData: { ...testData },
        enabled: true,
      })
      expose({ step })

      return () =>
        h(TestStepRow as never, {
          step: step.value,
          index: 0,
          total: 1,
          errors: {},
          expanded: true,
          onUpdate: (value: unknown) => {
            step.value = value as typeof step.value
          },
        })
    },
  })

  return mount(Harness, { attachTo: document.body })
}

/**
 * 读取当前各行输入框实际显示的键与值。
 * @param wrapper 已挂载的组件包装器。
 * @returns 每行的键名与数据值数组。
 * @throws 不抛出异常。
 */
function renderedRows(wrapper: ReturnType<typeof mountHarness>) {
  return wrapper.findAll('.test-data-row').map((row) => {
    const inputs = row.findAll('input')
    return {
      key: (inputs[0]?.element as HTMLInputElement).value,
      value: (inputs[1]?.element as HTMLInputElement).value,
    }
  })
}

/**
 * 读取 Harness 中当前落盘的测试数据。
 * @param wrapper 已挂载的组件包装器。
 * @returns 当前测试数据对象。
 * @throws 不抛出异常。
 */
function storedTestData(wrapper: ReturnType<typeof mountHarness>): TTestData {
  return (wrapper.vm as unknown as THarnessVm).step.testData
}

/**
 * 点击指定行的「删除」按钮（v10 三段式起各类型行统一文案为「删除」）。
 * @param wrapper 已挂载的组件包装器。
 * @param rowIndex 目标行下标。
 * @returns DOM 更新完成后兑现的 Promise。
 * @throws 目标行或按钮不存在时抛出异常。
 */
async function clickRemove(
  wrapper: ReturnType<typeof mountHarness>,
  rowIndex: number,
): Promise<void> {
  const row = wrapper.findAll('.test-data-row')[rowIndex]
  const button = row!
    .findAll('button')
    .find((item) => item.text().includes('删除'))
  await button!.trigger('click')
  await wrapper.vm.$nextTick()
}

/**
 * 在指定输入框中追加文本，模拟真实键盘键入。
 * @param wrapper 已挂载的组件包装器。
 * @param rowIndex 目标行下标。
 * @param column 目标列，0 为数据键，1 为数据值。
 * @param text 待追加输入的文本。
 * @returns 输入结束后焦点是否仍停留在同一元素上。
 * @throws 目标输入框不存在时抛出异常。
 */
async function typeInto(
  wrapper: ReturnType<typeof mountHarness>,
  rowIndex: number,
  column: 0 | 1,
  text: string,
): Promise<boolean> {
  const input = wrapper.findAll('.test-data-row')[rowIndex]!.findAll('input')[
    column
  ]!.element as HTMLInputElement
  input.focus()
  let keepsFocus = true

  for (const char of text) {
    input.value += char
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    if (document.activeElement !== input) keepsFocus = false
  }

  return keepsFocus
}

describe('测试数据行删除后的数据正确性', () => {
  it('删除中间一项后，剩余行显示并落盘正确的键值', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })

    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'key_2', value: 'b' },
      { key: 'key_3', value: 'c' },
    ])

    await clickRemove(wrapper, 1)

    // 不能出现「第 2 行仍显示 key_2 的残留值」这类下标错位
    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'key_3', value: 'c' },
    ])
    expect(storedTestData(wrapper)).toEqual({ key_1: 'a', key_3: 'c' })

    wrapper.unmount()
  })

  it('删除首项后，剩余行显示并落盘正确的键值', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })

    await clickRemove(wrapper, 0)

    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_2', value: 'b' },
      { key: 'key_3', value: 'c' },
    ])
    expect(storedTestData(wrapper)).toEqual({ key_2: 'b', key_3: 'c' })

    wrapper.unmount()
  })

  it('删除后再输入，应写入正确的条目而非错位的条目', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })

    // 删除中间项后，第二行变为 key_3/c；向它的数据值追加内容
    await clickRemove(wrapper, 1)
    expect(await typeInto(wrapper, 1, 1, 'z')).toBe(true)

    // 追加内容必须落在 key_3 上，而不是被删除的 key_2 或其他条目
    expect(storedTestData(wrapper)).toEqual({ key_1: 'a', key_3: 'cz' })
    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'key_3', value: 'cz' },
    ])

    wrapper.unmount()
  })

  it('删除全部条目后应回到空列表状态', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b' })

    await clickRemove(wrapper, 0)
    await clickRemove(wrapper, 0)

    expect(renderedRows(wrapper)).toEqual([])
    expect(storedTestData(wrapper)).toEqual({})

    wrapper.unmount()
  })

  it('把键名逐字符改为普通名字时，行顺序与数据都应保持正确', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })

    // 用户把第 2 行的 key_2 改名成 username（真实场景：语义化命名）
    const keyInput = wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!
      .element as HTMLInputElement
    keyInput.focus()
    keyInput.value = ''
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(await typeInto(wrapper, 1, 0, 'username')).toBe(true)

    // 非整数键不会触发引擎重排，三行的相对顺序必须原样保持
    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'username', value: 'b' },
      { key: 'key_3', value: 'c' },
    ])
    expect(storedTestData(wrapper)).toEqual({
      key_1: 'a',
      username: 'b',
      key_3: 'c',
    })

    wrapper.unmount()
  })

  it('删除后再改名，仍作用于同一行', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })

    // 先删除中间项，再对当前第 2 行（原 key_3）改名
    await clickRemove(wrapper, 1)
    const keyInput = wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!
      .element as HTMLInputElement
    keyInput.focus()
    keyInput.value = ''
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(await typeInto(wrapper, 1, 0, 'token')).toBe(true)

    expect(storedTestData(wrapper)).toEqual({ key_1: 'a', token: 'c' })
    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'token', value: 'c' },
    ])

    wrapper.unmount()
  })

  it('行标识随改名迁移，元素不被重建（_id 方案的核心保障）', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })
    const targetRow = wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!
      .element as HTMLInputElement
    targetRow.focus()
    targetRow.value = ''
    targetRow.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // 逐字符改名过程中，DOM 元素必须始终是同一个节点
    for (const char of 'username') {
      targetRow.value += char
      targetRow.dispatchEvent(new Event('input', { bubbles: true }))
      await wrapper.vm.$nextTick()
      expect(
        wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!.element,
      ).toBe(targetRow)
      expect(document.activeElement).toBe(targetRow)
    }

    wrapper.unmount()
  })

  it('数字键重排时，数据仍绑定正确的行（旧方案的数据损坏点已修复）', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })
    const keyInput = wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!
      .element as HTMLInputElement
    keyInput.focus()
    keyInput.value = ''
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // 逐字符输入纯数字键名 "23"，引擎会把整数键排到最前，行位置会变化
    for (const char of '23') {
      keyInput.value += char
      keyInput.dispatchEvent(new Event('input', { bubbles: true }))
      await wrapper.vm.$nextTick()
    }

    // 核心断言：用户想改的是 key_2，最终必须是 23，且 key_1 不能被误改。
    // 旧的下标 key 方案会在此把 key_1 污染成 key_13。
    expect(storedTestData(wrapper)).toEqual({
      key_1: 'a',
      '23': 'b',
      key_3: 'c',
    })

    // 已知限制：整数键重排会让 Vue 移动 DOM 节点，浏览器在节点移出文档时强制失焦。
    // 这是浏览器行为而非 key 选择问题，只能通过禁止整数键规避。
    expect(document.contains(keyInput)).toBe(true)

    wrapper.unmount()
  })

  it('禁止整数键后，行不会再重排', async () => {
    const wrapper = mountHarness({ key_1: 'a', key_2: 'b', key_3: 'c' })
    const keyInput = wrapper.findAll('.test-data-row')[1]!.findAll('input')[0]!
      .element as HTMLInputElement
    keyInput.focus()
    keyInput.value = ''
    keyInput.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // 非整数键不会触发引擎重排，三行顺序与元素身份都应原样保持
    expect(await typeInto(wrapper, 1, 0, 'token')).toBe(true)

    expect(renderedRows(wrapper)).toEqual([
      { key: 'key_1', value: 'a' },
      { key: 'token', value: 'b' },
      { key: 'key_3', value: 'c' },
    ])

    wrapper.unmount()
  })
})

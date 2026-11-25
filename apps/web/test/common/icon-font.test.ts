/**
 * 字体图标基元 IconFont 的组件测试。
 *
 * 核心保护点：该图标库要求 class **同时**包含 `aufontAll` 与 `h-icon-all-*`。
 * 前者提供字体族，后者只提供 ::before 的 content；漏写基础类会渲染成空白方块
 * 且无任何控制台报错。本测试是这一踩坑点的直接回归防线。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import IconFont from '../../src/common/icon/IconFont.vue'

describe('IconFont 类名拼接', () => {
  it('同时输出基础类与字形类（缺一不可）', () => {
    const wrapper = mount(IconFont, {
      props: { name: 'earth-o', size: 15 },
    })

    // 只有 h-icon-all-* 不生效：字体族仅由 .aufontAll 提供
    expect(wrapper.classes()).toContain('aufontAll')
    expect(wrapper.classes()).toContain('h-icon-all-earth-o')
    wrapper.unmount()
  })

  it('字形名拼接带 h-icon-all- 前缀', () => {
    const wrapper = mount(IconFont, {
      props: { name: 'warning-o', size: 14 },
    })

    expect(wrapper.classes()).toContain('h-icon-all-warning-o')
    expect(wrapper.classes()).not.toContain('warning-o')
    wrapper.unmount()
  })
})

describe('IconFont 字号', () => {
  it('以行内样式输出字号，覆盖 .aufontAll 硬编码的 16px', () => {
    // .aufontAll 把 font-size 固定为 16px，且类规则优先于继承；
    // 必须靠行内样式覆盖，否则靠继承字号的位置会静默变成 16px。
    const wrapper = mount(IconFont, {
      props: { name: 'bulb-o', size: 13 },
    })

    expect(wrapper.attributes('style')).toContain('font-size: 13px')
    wrapper.unmount()
  })
})

describe('IconFont 无障碍', () => {
  it('默认隐藏装饰性图标', () => {
    const wrapper = mount(IconFont, {
      props: { name: 'ai-robot-o', size: 42 },
    })

    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.attributes('role')).toBeUndefined()
    wrapper.unmount()
  })

  it('提供 label 时转为 img 语义且不再隐藏', () => {
    const wrapper = mount(IconFont, {
      props: { name: 'warning-o', size: 14, label: '警告' },
    })

    expect(wrapper.attributes('role')).toBe('img')
    expect(wrapper.attributes('aria-label')).toBe('警告')
    expect(wrapper.attributes('aria-hidden')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('IconFont 元素契约', () => {
  it('元素内不含文本内容（字形由 ::before 提供）', () => {
    // .aufontAll 的 font-family 带 !important，元素内任何文本都会被渲染成方块。
    const wrapper = mount(IconFont, {
      props: { name: 'message-o', size: 26 },
    })

    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('为单根元素：模板里的注释会让组件变多根，透传属性随之失效', () => {
    // 多根组件不会做属性透传，调用方的 class="tool-icon" 会被静默丢弃、scoped 样式失效。
    // 组件曾因模板内注释踩此坑，故直接断言根元素是 span 而非外层容器 div。
    const wrapper = mount(IconFont, {
      props: { name: 'earth-o', size: 15 },
    })

    expect(wrapper.element.tagName).toBe('SPAN')
    wrapper.unmount()
  })

  it('把调用方传入的 class 透传到根元素（scoped 样式依赖此行为）', () => {
    const wrapper = mount(IconFont, {
      props: { name: 'earth-o', size: 15 },
      attrs: { class: 'tool-icon' },
    })

    expect(wrapper.classes()).toContain('tool-icon')
    // 透传的 class 与自身类名共存
    expect(wrapper.classes()).toContain('aufontAll')
    expect(wrapper.classes()).toContain('h-icon-all-earth-o')
    wrapper.unmount()
  })
})

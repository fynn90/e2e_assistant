/**
 * 内容输出块的组件测试。
 *
 * 覆盖：按 contentType 分发渲染器、代码分支的语法高亮与只读性、
 * 以及**流式光标的挂载方式**。
 *
 * 光标的挂载方式是本文件的重点：它曾经是容器末尾的一个行内 `<span>`，
 * 而三种分支的根（markdown 的 `<article>`、code 的 `<pre>`、text 的 `<p>`）
 * 都是块级元素，行内兄弟节点会被挤到下一行、单独成行，看起来像一个跑偏的
 * 空输入框。现在改为挂在**文本元素**上的伪元素（见组件内 `.content-block.streaming`
 * 样式规则），因此这里断言「容器带 streaming 类」且「不存在独立的光标元素」。
 *
 * 伪元素的实际渲染位置无法在 happy-dom 中断言（`getComputedStyle` 不解析
 * `::after`），这里锁的是**驱动它的运行时条件**与**已废弃的实现形态**。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ContentBlock from '../../src/modules/agent-work/components/ContentBlock.vue'
import type { IContentTimelineItem } from '../../src/modules/agent-work/timeline'

/**
 * 构造内容块时间线项。
 * @param overrides 需要覆盖的字段。
 * @returns 内容块项。
 * @throws 不抛出异常。
 */
function createItem(
  overrides: Partial<IContentTimelineItem> = {},
): IContentTimelineItem {
  return {
    kind: 'content',
    blockId: 'content-1',
    seq: 1,
    status: 'streaming',
    contentType: 'markdown',
    text: '我来',
    ...overrides,
  }
}

describe('ContentBlock 流式光标', () => {
  it('流式期间容器带 streaming 类（伪元素光标的挂载点）', () => {
    const wrapper = mount(ContentBlock, {
      props: { item: createItem({ status: 'streaming' }) },
    })

    expect(wrapper.classes()).toContain('streaming')
    wrapper.unmount()
  })

  it('内容结束后移除 streaming 类，光标随之消失', async () => {
    const wrapper = mount(ContentBlock, {
      props: { item: createItem({ status: 'streaming' }) },
    })

    await wrapper.setProps({ item: createItem({ status: 'done' }) })

    expect(wrapper.classes()).not.toContain('streaming')
    wrapper.unmount()
  })

  it('不再渲染独立的光标元素（回归：行内兄弟节点会被挤到下一行）', () => {
    const wrapper = mount(ContentBlock, {
      props: { item: createItem({ status: 'streaming' }) },
    })

    // 光标必须是挂在文本元素上的伪元素，不能是容器末尾的兄弟节点。
    expect(wrapper.find('.stream-caret').exists()).toBe(false)
    // 容器内容里也不该混入光标字符本身。
    expect(wrapper.text()).not.toContain('▍')
    wrapper.unmount()
  })

  it('三种 contentType 分支都不渲染独立光标元素', () => {
    for (const contentType of ['markdown', 'code', 'text'] as const) {
      const wrapper = mount(ContentBlock, {
        props: { item: createItem({ status: 'streaming', contentType }) },
      })

      expect(wrapper.classes(), `${contentType} 分支`).toContain('streaming')
      expect(
        wrapper.find('.stream-caret').exists(),
        `${contentType} 分支`,
      ).toBe(false)
      wrapper.unmount()
    }
  })
})

describe('ContentBlock 内容分发', () => {
  it('markdown 走富文本预览渲染', () => {
    const wrapper = mount(ContentBlock, {
      props: { item: createItem({ contentType: 'markdown', text: '## 标题' }) },
    })

    expect(wrapper.find('.markdown-preview').exists()).toBe(true)
    wrapper.unmount()
  })

  it('code 走只读高亮渲染，并展示语言标签', () => {
    const wrapper = mount(ContentBlock, {
      props: {
        item: createItem({
          contentType: 'code',
          language: 'typescript',
          text: 'const a = 1',
        }),
      },
    })

    // 高亮块替代了原先的裸 <pre class="code-body">（本次改动的回归锁）
    expect(wrapper.find('.readonly-code').exists()).toBe(true)
    expect(wrapper.find('.readonly-code').text()).toContain('const a = 1')
    expect(wrapper.find('.code-header').text()).toBe('typescript')
    wrapper.unmount()
  })

  it('code 的源码按语言着色，且不可编辑', () => {
    const wrapper = mount(ContentBlock, {
      props: {
        item: createItem({
          contentType: 'code',
          language: 'typescript',
          text: 'const a = 1',
        }),
      },
    })

    // hljs 的 token 类名是「高亮了」的可观测证据
    expect(wrapper.find('.readonly-code .hljs-keyword').exists()).toBe(true)
    // 只读：展示用代码块不提供任何输入控件
    expect(wrapper.find('input, textarea, [contenteditable]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('text 走纯文本段落渲染', () => {
    const wrapper = mount(ContentBlock, {
      props: { item: createItem({ contentType: 'text', text: '纯文本内容' }) },
    })

    expect(wrapper.find('.plain-text').exists()).toBe(true)
    expect(wrapper.text()).toContain('纯文本内容')
    wrapper.unmount()
  })
})

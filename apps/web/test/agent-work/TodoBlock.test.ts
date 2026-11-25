/**
 * 待办清单块的组件测试（v12-pre）。
 *
 * 覆盖：进度统计与进度条、三种状态的可辨识标记、全部完成时的完成态配色、
 * 头部清单图标，以及空清单不产生除零与渲染异常。
 */
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TodoBlock from '../../src/modules/agent-work/components/TodoBlock.vue'
import { TODO_BLOCK_ICON } from '../../src/modules/agent-work/icons'
import type { ITodoTimelineItem } from '../../src/modules/agent-work/timeline'

/**
 * 构造待办清单块项。
 *
 * @param items - 清单条目。
 * @returns 时间线项。
 * @throws 不抛出异常。
 */
function createItem(items: ITodoTimelineItem['items']): ITodoTimelineItem {
  return {
    kind: 'todo',
    blockId: 'b1',
    seq: 1,
    status: 'done',
    items,
  }
}

describe('TodoBlock', () => {
  it('展示进度统计与每条待办', () => {
    const wrapper = mount(TodoBlock, {
      props: {
        item: createItem([
          { id: 's1', content: '登录', status: 'completed' },
          {
            id: 's2',
            content: '打开列表',
            status: 'in_progress',
            activeForm: '正在核对',
          },
          { id: 's3', content: '提交', status: 'pending' },
        ]),
      },
    })

    expect(wrapper.text()).toContain('1/3')
    expect(wrapper.text()).toContain('登录')
    expect(wrapper.text()).toContain('打开列表')
    expect(wrapper.text()).toContain('正在核对')
    expect(wrapper.text()).toContain('提交')
  })

  it('头部渲染清单图标（与时间线其余块一致，此前漏配）', () => {
    const wrapper = mount(TodoBlock, {
      props: {
        item: createItem([{ id: 's1', content: '登录', status: 'pending' }]),
      },
    })

    // 图标由 IconFont 渲染，基础类与字形类缺一不可（漏写会变空白方块且无报错）。
    const icon = wrapper.find('.todo-icon')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('aufontAll')
    expect(icon.classes()).toContain(`h-icon-all-${TODO_BLOCK_ICON}`)
  })

  it('三种状态使用可辨识的标记', () => {
    const wrapper = mount(TodoBlock, {
      props: {
        item: createItem([
          { id: 's1', content: '已完成项', status: 'completed' },
          { id: 's2', content: '进行中项', status: 'in_progress' },
          { id: 's3', content: '待开始项', status: 'pending' },
        ]),
      },
    })

    const glyphs = wrapper.findAll('.todo-glyph').map((node) => node.text())
    expect(glyphs).toEqual(['✓', '▸', '○'])
  })

  it('进度条宽度与完成比例一致', () => {
    const wrapper = mount(TodoBlock, {
      props: {
        item: createItem([
          { id: 's1', content: 'A', status: 'completed' },
          { id: 's2', content: 'B', status: 'completed' },
          { id: 's3', content: 'C', status: 'pending' },
          { id: 's4', content: 'D', status: 'pending' },
        ]),
      },
    })

    const bar = wrapper.find('.todo-bar')
    expect(bar.attributes('aria-valuenow')).toBe('50')
    expect(wrapper.find('.todo-bar-fill').attributes('style')).toContain(
      'width: 50%',
    )
  })

  it('全部完成时切换为完成态', () => {
    const wrapper = mount(TodoBlock, {
      props: {
        item: createItem([
          { id: 's1', content: '唯一一步', status: 'completed' },
        ]),
      },
    })

    expect(wrapper.find('.todo-block').classes()).toContain('completed')
    expect(wrapper.find('.todo-bar').attributes('aria-valuenow')).toBe('100')
  })

  it('空清单不产生除零或渲染异常', () => {
    const wrapper = mount(TodoBlock, { props: { item: createItem([]) } })

    // 0/0 若直接相除会得到 NaN；组件必须按 0 处理。
    expect(wrapper.text()).toContain('0/0')
    expect(wrapper.find('.todo-bar').attributes('aria-valuenow')).toBe('0')
    expect(wrapper.find('.todo-block').classes()).not.toContain('completed')
    expect(wrapper.findAll('.todo-entry')).toHaveLength(0)
  })
})

/**
 * todo_write 工具的单元测试。
 *
 * 该工具不读写文件、不访问页面，纯参数规范化与回显，
 * 因此测试聚焦：清单规范化（截断/丢弃空条目）、进度统计与边界拒绝。
 */

import { describe, expect, it } from 'vitest'
import {
  createTodoWriteTool,
  todoWriteLimits,
} from '../../src/tools/todo_write'

/** 执行工具并返回结果（省略调用标识等无关参数）。 */
async function runTodo(
  items: Array<{
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm?: string
  }>,
) {
  const tool = createTodoWriteTool()
  return tool.execute('call-1', { items }, undefined, undefined)
}

describe('createTodoWriteTool', () => {
  it('回显完整清单并统计进度', async () => {
    const result = await runTodo([
      { id: 's1', content: '登录', status: 'completed' },
      {
        id: 's2',
        content: '打开列表',
        status: 'in_progress',
        activeForm: '正在核对',
      },
      { id: 's3', content: '提交', status: 'pending' },
    ])

    expect(result.details).toEqual({ total: 3, completed: 1, inProgress: 1 })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('1/3 已完成')
    // 三种状态各有可辨识的标记，便于模型与用户对齐进度。
    expect(text).toContain('[x] 登录')
    expect(text).toContain('[~] 打开列表（正在核对）')
    expect(text).toContain('[ ] 提交')
  })

  it('丢弃内容为空白或全空白的条目', async () => {
    const result = await runTodo([
      { id: 's1', content: '有效项', status: 'pending' },
      { id: 's2', content: '   ', status: 'pending' },
    ])

    expect(result.details).toEqual({ total: 1, completed: 0, inProgress: 0 })
  })

  it('截断超长内容，避免长文本撑爆时间线', async () => {
    const result = await runTodo([
      { id: 's1', content: '长'.repeat(500), status: 'pending' },
    ])

    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('长'.repeat(todoWriteLimits.maxContentCharacters))
    expect(text).not.toContain(
      '长'.repeat(todoWriteLimits.maxContentCharacters + 1),
    )
  })

  it('清单条数超过上限时拒绝并说明如何修正', async () => {
    const items = Array.from(
      { length: todoWriteLimits.maxItems + 1 },
      (_, index) => ({
        id: `s${index}`,
        content: `步骤 ${index}`,
        status: 'pending' as const,
      }),
    )

    await expect(runTodo(items)).rejects.toThrow(/最多 50 条/)
  })

  it('清单全部为空时拒绝，避免渲染出空气泡', async () => {
    await expect(
      runTodo([{ id: 's1', content: '  ', status: 'pending' }]),
    ).rejects.toThrow(/不能为空/)
  })

  it('id 缺失时用内容兜底，保证同一清单内可定位', async () => {
    const result = await runTodo([
      { id: '', content: '无 id 的步骤', status: 'pending' },
    ])

    expect(result.details).toMatchObject({ total: 1 })
  })
})

/**
 * 工具展示映射器测试：工具名 → 动作 / 类别 / 标题。
 *
 * 重点覆盖「动作与标题同源」这一防复发设计：
 *   1. 每个已登记工具都映射出**明确**的动作（而非落进 other 兜底）；
 *   2. 浏览器动作的 action 与 title 一一对应，新增浏览器工具只改 BROWSER_ACTIONS 一处；
 *   3. 全部浏览器动作的 action 两两互异——「查询/点击/截图/下拉同图标」的缺陷
 *      在服务端一侧的防线（前端由 icons.test.ts 的同组断言兜住）。
 */
import { describe, expect, it } from 'vitest'
import { presentTool } from '../src/harness/client-events/tool-presenter'

/**
 * 全部已登记的浏览器工具名（与 BROWSER_ACTIONS 的表项保持一致）。
 *
 * 独立列一份而非从实现导出：这样新增浏览器动作却漏配 title/action 时，
 * 断言会失败，而不是「实现导出了什么就断言什么」的空转。
 */
const BROWSER_TOOL_NAMES = [
  'browser_navigate',
  'browser_snapshot',
  'browser_query',
  'browser_click',
  'browser_select',
  'browser_fill',
  'browser_waitFor',
  'browser_screenshot',
  'browser_capture_baseline',
]

describe('presentTool：非浏览器工具的动作映射', () => {
  it.each([
    ['load_skill', 'skill'],
    ['read', 'read'],
    ['write', 'write'],
    ['edit', 'edit'],
    ['grep', 'grep'],
    ['find', 'find'],
    ['ls', 'find'],
    ['execute_test', 'test'],
  ])('%s → action=%s', (toolName, expectedAction) => {
    expect(presentTool(toolName, {}).action).toBe(expectedAction)
  })

  it('未登记工具落进 other 兜底（且不抛异常）', () => {
    const presentation = presentTool('some_future_tool', {}, '未来工具')

    expect(presentation.action).toBe('other')
    expect(presentation.category).toBe('other')
    expect(presentation.title).toBe('未来工具')
  })
})

describe('presentTool：浏览器动作', () => {
  it('每个浏览器动作都映射出明确动作，且标题不是「浏览器操作：」兜底文案', () => {
    for (const toolName of BROWSER_TOOL_NAMES) {
      const presentation = presentTool(toolName, {})

      expect(presentation.category, `${toolName} 类别`).toBe('browser')
      expect(presentation.action, `${toolName} 应映射出明确动作`).not.toBe(
        'other',
      )
      // 兜底标题形如「浏览器操作：capture_baseline」——命中即说明漏登记（本 bug 的形态之一）
      expect(presentation.title, `${toolName} 标题落进兜底`).not.toContain(
        '浏览器操作：',
      )
    }
  })

  it('全部浏览器动作的 action 两两互异', () => {
    // 本 bug 的服务端侧防线：曾因所有 browser_* 共用 category=browser，
    // 前端拿到的图标选择依据完全一致，四个动作渲染成同一个地球。
    const actions = BROWSER_TOOL_NAMES.map(
      (name) => presentTool(name, {}).action,
    )
    expect(new Set(actions).size, `动作塌缩：${actions.join(', ')}`).toBe(
      actions.length,
    )
  })

  it('全部浏览器动作的 title 两两互异', () => {
    // action 与 title 同源后两者应当同进同退，但仍各自断言一次：
    // 若有人绕过 BROWSER_ACTIONS 单独改标题，这里会拦住。
    const titles = BROWSER_TOOL_NAMES.map((name) => presentTool(name, {}).title)
    expect(new Set(titles).size, `标题重复：${titles.join(', ')}`).toBe(
      titles.length,
    )
  })

  it('未登记的浏览器动作回退为 other 动作 + 兜底标题', () => {
    const presentation = presentTool('browser_hoverSomething', {})

    expect(presentation.category).toBe('browser')
    expect(presentation.action).toBe('other')
    expect(presentation.title).toBe('浏览器操作：hoverSomething')
  })

  it('浏览器动作的副标题取 url 或 selector，优先 url', () => {
    expect(
      presentTool('browser_navigate', { url: 'https://a.com' }).subtitle,
    ).toBe('https://a.com')
    expect(presentTool('browser_click', { selector: '#ok' }).subtitle).toBe(
      '#ok',
    )
    // 两者同时存在时 url 优先（与既有行为一致）
    expect(
      presentTool('browser_click', { url: 'https://a.com', selector: '#ok' })
        .subtitle,
    ).toBe('https://a.com')
  })
})

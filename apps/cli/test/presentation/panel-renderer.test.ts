/**
 * 面板渲染器的测试。
 *
 * 两类断言最关键：
 *   1. **边框对齐**——每行可见宽度必须完全一致，否则卡片右侧呈锯齿状；
 *   2. **概述行原样保留**——`headline` 是 e2e 断言的载体，任何层级都不得截断它。
 */
import { describe, expect, it } from 'vitest'
import { measureTextWidth } from '../../src/presentation/console/text-width'
import {
  renderPanel,
  type IPanelContent,
} from '../../src/presentation/console/panel-renderer'
import {
  createPanelStyle,
  type IPanelStyle,
} from '../../src/presentation/console/ansi-style'
import { CARD_MIN_COLUMNS } from '../../src/presentation/console/terminal-output-mode'

/** 测试用配色：恒等函数，断言时不受 ANSI 序列干扰。 */
const plainStyle: IPanelStyle = {
  title: (text) => text,
  border: (text) => text,
  label: (text) => text,
  value: (text) => text,
  command: (text) => text,
  ok: (text) => text,
  warn: (text) => text,
  muted: (text) => text,
}

const baseContent: IPanelContent = {
  title: 'AUTHINE E2E AGENT PLATFORM',
  headline: '🚀 Authine E2E Agent Platform started in the background',
  fields: [
    { icon: '📌', label: '状态', value: '已启动 · 后台运行中', tone: 'ok' },
    { icon: '🔗', label: '地址', value: 'http://127.0.0.1:5826', tone: 'ok' },
    { icon: '🔌', label: '端口', value: '5826' },
  ],
  notes: [],
  actions: [],
  mascot: '( •_•)  我先去后台待命了～',
}

/**
 * 取渲染结果的卡片各行（去掉结尾换行产生的空串）。
 *
 * 吉祥物台词**刻意画在卡片之外**（与卡片左对齐的独立一行），因此不计入
 * 对齐断言——把它算进来测的就不是边框对齐了。
 */
function renderCardLines (content: IPanelContent, columns = 80): string[] {
  return renderPanel({ content, mode: 'card', style: plainStyle, columns })
    .split('\n')
    .slice(0, -1)
    .filter((line) => !line.startsWith('   ( '))
}

/** 取渲染结果的全部行，含卡片外的吉祥物台词。 */
function renderAllLines (content: IPanelContent, columns = 80): string[] {
  return renderPanel({ content, mode: 'card', style: plainStyle, columns })
    .split('\n')
    .slice(0, -1)
}

describe('renderPanel（卡片层级）', () => {
  it('所有行的可见宽度完全一致', () => {
    const lines = renderCardLines(baseContent)
    const widths = new Set(lines.map((line) => measureTextWidth(line)))

    expect(widths.size).toBe(1)
  })

  it('中文标签与 emoji 混排时边框仍对齐', () => {
    // 中文占 2 列、emoji 占 2 列、ANSI 零宽——三者任一算错都会让宽度集合出现多个值。
    const lines = renderCardLines({
      ...baseContent,
      fields: [
        { icon: '🕒', label: '启动时间', value: '2026-10-13 14:32:08' },
        {
          icon: '📜',
          label: '日志',
          value:
            'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log',
        },
      ],
    })

    expect(new Set(lines.map((line) => measureTextWidth(line))).size).toBe(1)
  })

  it('超长字段值被截断，不会顶破右边框', () => {
    const longPath = `C:\\${'x'.repeat(200)}`
    const lines = renderCardLines({
      ...baseContent,
      fields: [{ icon: '📜', label: '日志', value: longPath }],
    })

    expect(new Set(lines.map((line) => measureTextWidth(line))).size).toBe(1)
    expect(lines.join('\n')).toContain('…')
  })

  it('概述行在最窄的卡片宽度下仍落在同一行，不把断言短语切断', () => {
    // 概述行刻意不带地址，正是为了在最窄的卡片宽度下也不折行——折行会把
    // `started in the background` 切成两行，破坏 e2e 的整串断言。
    const lines = renderCardLines(baseContent, CARD_MIN_COLUMNS)
    const headlineLine = lines.find((line) => line.includes('started in the'))

    expect(headlineLine).toBeDefined()
    expect(headlineLine).toContain('started in the background')
  })

  it('终端越宽卡片越宽，但不超过上限', () => {
    const narrow = renderCardLines(baseContent, 62)
    const wide = renderCardLines(baseContent, 200)

    expect(measureTextWidth(narrow[0] as string)).toBe(62)
    expect(measureTextWidth(wide[0] as string)).toBe(78)
  })

  it('自动采用配色提供的四个命名色块', () => {
    const style = createPanelStyle()
    const rendered = renderPanel({
      content: baseContent,
      mode: 'card',
      style,
      columns: 80,
    })

    // 标题走 title 色、边框走 border 色；两者都应产生真实 ANSI 序列。
    expect(rendered).toContain(style.title('x').replace('x', ''))
  })

  it('带补充说明时仍保持对齐', () => {
    const lines = renderCardLines({
      ...baseContent,
      notes: [
        '⚠️ 检测到陈旧的运行态记录（原服务已不再运行），已自动忽略并启动新服务。',
      ],
    })

    expect(new Set(lines.map((line) => measureTextWidth(line))).size).toBe(1)
  })

  it('每个命令独占一行，且在任意宽度下都可见', () => {
    // 一行一个的理由：并排时窄卡片放不下，渲染器只能整条让位，于是终端上会
    // 「少了一条命令」。这里在**最窄**宽度下断言三条命令都在。
    const actions = [
      { icon: '👀', command: 'e2e_assistant log -f', hint: '实时查看服务日志' },
      { icon: '🔍', command: 'e2e_assistant status', hint: '查看服务运行状态' },
      { icon: '🛑', command: 'e2e_assistant stop', hint: '停止服务' },
    ]
    const lines = renderCardLines({ ...baseContent, actions }, CARD_MIN_COLUMNS)
    const body = lines.join('\n')

    for (const action of actions) {
      expect(body).toContain(action.command)
    }
    // 三条命令各自占一行（加上卡片本身的行），不会挤在同一行。
    const commandLines = lines.filter((line) => line.includes('e2e_assistant'))
    expect(commandLines).toHaveLength(3)
  })

  it('命令提示行仍与卡片等宽（不改动边框对齐）', () => {
    const lines = renderCardLines({
      ...baseContent,
      actions: [
        { icon: '👀', command: 'e2e_assistant log -f', hint: '实时查看服务日志' },
        { icon: '🔍', command: 'e2e_assistant status', hint: '查看服务运行状态' },
        { icon: '🛑', command: 'e2e_assistant stop', hint: '停止服务' },
      ],
    })

    expect(new Set(lines.map((line) => measureTextWidth(line))).size).toBe(1)
  })

  it('说明文字按最长命令对齐成一列', () => {
    const lines = renderCardLines({
      ...baseContent,
      actions: [
        { icon: '👀', command: 'e2e_assistant log -f', hint: '实时查看服务日志' },
        { icon: '🛑', command: 'e2e_assistant stop', hint: '停止服务' },
      ],
    })
    const hintColumns = lines
      .filter((line) => line.includes('实时查看') || line.includes('停止服务'))
      .map((line) =>
        line.indexOf(line.includes('实时查看') ? '实时查看' : '停止服务'),
      )

    // 命令长短不一（`log -f` 比 `stop` 长），说明起点必须被补齐到同一列。
    expect(new Set(hintColumns).size).toBe(1)
  })

  it('命令永不被截断，空间不足时让步的是说明', () => {
    const lines = renderCardLines(
      {
        ...baseContent,
        actions: [
          {
            icon: '👀',
            command: 'e2e_assistant log -f',
            hint: '这是一句很长的说明文字，长到在最窄的卡片里放不下',
          },
        ],
      },
      CARD_MIN_COLUMNS,
    )
    const body = lines.join('\n')

    expect(body).toContain('e2e_assistant log -f')
    expect(body).not.toMatch(/e2e_assistant…/)
  })

  it('无字段时也能渲染出对齐的卡片', () => {
    const lines = renderCardLines({ ...baseContent, fields: [] })

    expect(new Set(lines.map((line) => measureTextWidth(line))).size).toBe(1)
  })
})

describe('renderPanel（无边框层级）', () => {
  const flatOptions = {
    content: baseContent,
    mode: 'plain' as const,
    style: plainStyle,
  }

  it('不含任何边框字符', () => {
    const rendered = renderPanel(flatOptions)

    for (const glyph of ['╭', '╮', '╰', '╯', '│']) {
      expect(rendered).not.toContain(glyph)
    }
  })

  it('概述行原样出现，不被截断或折行加工', () => {
    expect(renderPanel(flatOptions)).toContain(
      'Authine E2E Agent Platform started in the background',
    )
  })

  it('字段、说明与命令都保留', () => {
    const rendered = renderPanel({
      ...flatOptions,
      content: {
        ...baseContent,
        notes: ['⚠️ 陈旧记录'],
        actions: [{ icon: '🛑', command: 'e2e_assistant stop', hint: '停止服务' }],
      },
    })

    expect(rendered).toContain('http://127.0.0.1:5826')
    expect(rendered).toContain('5826')
    expect(rendered).toContain('⚠️ 陈旧记录')
    expect(rendered).toContain('e2e_assistant stop')
  })

  it('窄终端层级同样不画边框', () => {
    const rendered = renderPanel({ ...flatOptions, mode: 'colored' })

    expect(rendered).not.toContain('╭')
    expect(rendered).toContain('started in the background')
  })
})

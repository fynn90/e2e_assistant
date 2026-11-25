/**
 * 启动面板内容装配的测试。
 *
 * 这里锁定两条对外契约：
 *   1. **e2e 断言短语逐字保留**（`started in the background` / `already running`）；
 *   2. **概述行在卡片最窄宽度下不折行**——`CARD_MIN_COLUMNS` 是按最长概述行
 *      倒推的，概述行一旦变长就必须同步抬高该常量，否则窄终端上短语会被切断。
 *
 * 版本行取 CLI 包版本（而非协议版本）：协议是服务间比对用的内部标识，用户
 * 需要的是「我装的是哪个版本」。
 */
import { describe, expect, it } from 'vitest'
import { measureTextWidth } from '../../src/presentation/console/text-width'
import { CARD_MIN_COLUMNS } from '../../src/presentation/console/terminal-output-mode'
import {
  buildStartPanelContent,
  type IStartPanelInput,
} from '../../src/presentation/console/start-panel'

const backgroundStart: IStartPanelInput = {
  outcome: 'started',
  mode: 'background',
  serverUrl: 'http://127.0.0.1:5826',
  port: 5826,
  pid: 12345,
  startedAt: '2026-10-13T06:32:08.000Z',
  logPath: 'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log',
  shellProbe: {
    outcome: 'found',
    path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  },
  cliVersion: '0.2.1',
}

/** 概述行在卡片内可用的最大宽度：总宽 - 边框 2 - 内边距 4。 */
const HEADLINE_BUDGET = CARD_MIN_COLUMNS - 2 - 4

/** 取指定标签的字段值；不存在返回 undefined。 */
function findFieldValue (
  content: ReturnType<typeof buildStartPanelContent>,
  label: string,
): string | undefined {
  return content.fields.find((field) => field.label === label)?.value
}

describe('buildStartPanelContent', () => {
  it('后台启动的概述行保留 e2e 断言短语', () => {
    expect(buildStartPanelContent(backgroundStart).headline).toContain(
      'started in the background',
    )
  })

  it('复用的概述行保留 e2e 断言短语', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      outcome: 'reused',
    })

    expect(content.headline).toContain('already running')
  })

  it('所有形态的概述行都能放进最窄卡片的同一行', () => {
    // 这是 CARD_MIN_COLUMNS 的推导依据：任一形态超宽都会让短语在窄终端折行。
    for (const outcome of [
      'started',
      'reused',
      'started-after-stale-record',
    ] as const) {
      for (const mode of ['background', 'foreground'] as const) {
        const { headline } = buildStartPanelContent({
          ...backgroundStart,
          outcome,
          mode,
        })

        expect(measureTextWidth(headline)).toBeLessThanOrEqual(HEADLINE_BUDGET)
      }
    }
  })

  it('展示状态、地址、端口、PID、启动时间与 CLI 版本', () => {
    const content = buildStartPanelContent(backgroundStart)
    const labels = content.fields.map((field) => field.label)

    expect(labels).toEqual([
      '状态',
      '地址',
      '端口',
      'PID',
      '启动时间',
      'cli',
      'bash',
      '日志',
    ])
  })

  it('CLI 版本行取自注入的包版本，带 v 前缀', () => {
    const versionField = buildStartPanelContent(backgroundStart).fields.find(
      (field) => field.label === 'cli',
    )

    expect(versionField?.value).toBe('v0.2.1')
  })

  it('CLI 版本不可得时不渲染该行，而不是补占位', () => {
    // 解析失败（包环境不完整）时给用户看 `vundefined` 比不显示更糟。
    const content = buildStartPanelContent({
      ...backgroundStart,
      cliVersion: null,
    })

    expect(content.fields.some((field) => field.label === 'cli')).toBe(false)
  })

  it('不再渲染协议版本行（协议是服务间比对用的内部标识）', () => {
    const labels = buildStartPanelContent(backgroundStart).fields.map(
      (field) => field.label,
    )

    expect(labels).not.toContain('协议')
  })

  it('bash 探测到时不显示路径（只报可用性，路径是噪声）', () => {
    expect(
      findFieldValue(buildStartPanelContent(backgroundStart), 'bash'),
    ).toBe('已就绪')
  })

  it('bash 未找到时标明不可用，并给出修复指引', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      shellProbe: { outcome: 'missing' },
    })

    expect(findFieldValue(content, 'bash')).toBe('未找到')
    // 修复指引必须出现在**启动它的那个终端**里：后台模式下若打印在子进程，
    // 只会落进日志文件，用户看不到。
    const notes = content.notes.join('')
    expect(notes).toContain('bash')
    expect(notes).toContain('git-scm.com')
    expect(notes).toContain('PATH')
  })

  it('bash 未找到的字段标为警告色', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      shellProbe: { outcome: 'missing' },
    })

    expect(content.fields.find((field) => field.label === 'bash')?.tone).toBe(
      'warn',
    )
  })

  it('非 Windows（not-applicable）不渲染 bash 行', () => {
    // 那里不缺 bash，显示只会增噪。
    const content = buildStartPanelContent({
      ...backgroundStart,
      shellProbe: { outcome: 'not-applicable' },
    })

    expect(content.fields.some((field) => field.label === 'bash')).toBe(false)
  })

  it('复用分支（不带探测结果）不渲染 bash 行', () => {
    // 复用时不重新探测：既不谎报可用，也不给无意义的占位。
    const content = buildStartPanelContent({
      ...backgroundStart,
      outcome: 'reused',
      shellProbe: undefined,
    })

    expect(content.fields.some((field) => field.label === 'bash')).toBe(false)
    expect(content.notes.join('')).not.toContain('bash')
  })

  it('后台模式展示日志路径与跟随命令', () => {
    const content = buildStartPanelContent(backgroundStart)

    expect(content.fields.some((field) => field.label === '日志')).toBe(true)
    expect(content.actions.map((action) => action.command)).toContain(
      'e2e_assistant log -f',
    )
  })

  it('前台模式不展示日志路径与跟随命令', () => {
    // 前台模式的日志刷在它自己的终端里，不落盘——给出路径是误导。
    const content = buildStartPanelContent({
      ...backgroundStart,
      mode: 'foreground',
    })

    expect(content.fields.some((field) => field.label === '日志')).toBe(false)
    expect(content.actions.map((action) => action.command)).not.toContain(
      'e2e_assistant log -f',
    )
  })

  it('停止命令在两种模式下都提供', () => {
    for (const mode of ['background', 'foreground'] as const) {
      const content = buildStartPanelContent({ ...backgroundStart, mode })

      expect(content.actions.map((action) => action.command)).toContain(
        'e2e_assistant stop',
      )
    }
  })

  it('status 命令在两种模式下都提供', () => {
    // 刚启动后最自然的疑问就是「它真的在跑吗」——status 正是回答这个的。
    for (const mode of ['background', 'foreground'] as const) {
      const content = buildStartPanelContent({ ...backgroundStart, mode })

      expect(content.actions.map((action) => action.command)).toContain(
        'e2e_assistant status',
      )
    }
  })

  it('每条命令都带一句作用说明', () => {
    // 一行一个命令之后，说明文字才有位置写——没有说明的提示行等于让用户猜。
    const content = buildStartPanelContent(backgroundStart)

    for (const action of content.actions) {
      expect(action.hint.length).toBeGreaterThan(0)
    }
  })

  it('命令按「看日志 → 查状态 → 停服务」排序', () => {
    const commands = buildStartPanelContent(backgroundStart).actions.map(
      (action) => action.command,
    )

    expect(commands).toEqual([
      'e2e_assistant log -f',
      'e2e_assistant status',
      'e2e_assistant stop',
    ])
  })

  it('PID 不可得时不渲染该字段，而不是补占位', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      pid: undefined,
    })

    expect(content.fields.some((field) => field.label === 'PID')).toBe(false)
  })

  it('启动时间不可解析时不渲染该字段', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      startedAt: 'not-a-timestamp',
    })

    expect(content.fields.some((field) => field.label === '启动时间')).toBe(
      false,
    )
  })

  it('陈旧记录启动时给出显式提示', () => {
    const content = buildStartPanelContent({
      ...backgroundStart,
      outcome: 'started-after-stale-record',
    })

    expect(content.notes.join('')).toContain('陈旧的运行态记录')
  })

  it('每种形态都有吉祥物台词', () => {
    for (const outcome of [
      'started',
      'reused',
      'started-after-stale-record',
    ] as const) {
      for (const mode of ['background', 'foreground'] as const) {
        const { mascot } = buildStartPanelContent({
          ...backgroundStart,
          outcome,
          mode,
        })

        expect(mascot.length).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * 状态面板内容装配的测试。
 *
 * 三条关键契约：
 *   1. **三态各自成形**——尤其 `unknown` 不得并入「未运行」，否则用户会以为
 *      可以安全启动，而端口实际被占；
 *   2. **unknown 不给任何动作提示**——此时没有安全的自动操作可推荐；
 *   3. **字段按可得性渲染**——缺失即不渲染，不补占位（与既有面板同约定）。
 */
import { describe, expect, it } from 'vitest'
import { measureTextWidth } from '../../src/presentation/console/text-width'
import { CARD_MIN_COLUMNS } from '../../src/presentation/console/terminal-output-mode'
import {
  buildStatusPanelContent,
  type TStatusPanelInput,
} from '../../src/presentation/console/status-panel'

const LOG_PATH = 'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log'

const running: TStatusPanelInput = {
  kind: 'running',
  serverUrl: 'http://127.0.0.1:5826',
  port: 5826,
  mode: 'background',
  pid: 32168,
  startedAt: '2026-10-13T06:32:08.000Z',
  version: 6,
  cliVersion: '0.2.1',
  logPath: LOG_PATH,
}

const stopped: TStatusPanelInput = {
  kind: 'stopped',
  reason: 'no-record',
  logPath: LOG_PATH,
}

const unconfirmable: TStatusPanelInput = {
  kind: 'unconfirmable',
  detail:
    '端口 5826 被占用，但该服务未在限时内响应健康探测，无法确认它是否仍是本平台 CLI。',
  port: 5826,
  pid: 32168,
}

/** 概述行在卡片内可用的最大宽度：总宽 - 边框 2 - 内边距 4。 */
const HEADLINE_BUDGET = CARD_MIN_COLUMNS - 2 - 4

describe('buildStatusPanelContent（运行中）', () => {
  it('概述行说明服务在运行', () => {
    expect(buildStatusPanelContent(running).headline).toContain('is running')
  })

  it('展示与 start 一致的字段，外加已运行时长', () => {
    const labels = buildStatusPanelContent(running).fields.map(
      (field) => field.label,
    )

    expect(labels).toEqual([
      '状态',
      '地址',
      '端口',
      'PID',
      '启动时间',
      '已运行',
      'cli',
      '协议',
      '日志',
    ])
  })

  it('协议版本取服务自报的版本，而非本地常量', () => {
    // 这是 status 相对 start 的价值：能发现「跑着的是旧版服务」。
    const content = buildStatusPanelContent({ ...running, version: 5 })
    const protocol = content.fields.find((field) => field.label === '协议')

    expect(protocol?.value).toBe('v5')
  })

  it('CLI 版本与服务自报的协议版本并存，且各取各的来源', () => {
    // 两行并存的意义：二者不一致正是「旧服务尚未重启」的信号，
    // 若合并成一行就丢掉这个信号了。
    const content = buildStatusPanelContent({ ...running, version: 5 })
    const cli = content.fields.find((field) => field.label === 'cli')
    const protocol = content.fields.find((field) => field.label === '协议')

    expect(cli?.value).toBe('v0.2.1')
    expect(protocol?.value).toBe('v5')
  })

  it('CLI 版本不可得时不渲染该行', () => {
    const content = buildStatusPanelContent({ ...running, cliVersion: null })

    expect(content.fields.some((field) => field.label === 'cli')).toBe(false)
  })

  it('提示可在浏览器打开地址', () => {
    const notes = buildStatusPanelContent(running).notes.join('')

    expect(notes).toContain('浏览器')
    expect(notes).toContain('工作台')
  })

  it('提供 log -f 与 stop 两条命令提示', () => {
    const commands = buildStatusPanelContent(running).actions.map(
      (action) => action.command,
    )

    expect(commands).toEqual(['e2e_assistant log -f', 'e2e_assistant stop'])
  })

  it('前台模式不展示日志路径（那份日志不落盘）', () => {
    const content = buildStatusPanelContent({
      ...running,
      mode: 'foreground',
      logPath: undefined,
    })

    expect(content.fields.some((field) => field.label === '日志')).toBe(false)
    expect(content.fields[0]?.value).toContain('前台')
  })

  it('后台模式的状态值标明后台', () => {
    const status = buildStatusPanelContent(running).fields[0]

    expect(status?.value).toContain('后台')
  })

  it('启动时间不可解析时不渲染该行', () => {
    const content = buildStatusPanelContent({
      ...running,
      startedAt: 'not-a-timestamp',
    })

    expect(content.fields.some((field) => field.label === '启动时间')).toBe(
      false,
    )
    expect(content.fields.some((field) => field.label === '已运行')).toBe(false)
  })

  it('概述行放得进最窄卡片的同一行', () => {
    expect(
      measureTextWidth(buildStatusPanelContent(running).headline),
    ).toBeLessThanOrEqual(HEADLINE_BUDGET)
  })
})

describe('buildStatusPanelContent（未运行）', () => {
  it('概述行说明服务未运行', () => {
    expect(buildStatusPanelContent(stopped).headline).toContain(
      'is not running',
    )
  })

  it('从未启动：状态说明在休息，且不给异常提示', () => {
    const content = buildStatusPanelContent(stopped)

    expect(content.fields[0]?.value).toContain('休息')
    expect(content.notes).toEqual([])
  })

  it('陈旧记录：提示残留记录会在下次启动时清理', () => {
    const content = buildStatusPanelContent({
      ...stopped,
      reason: 'service-gone',
    })

    expect(content.fields[0]?.value).toContain('已停止')
    expect(content.notes.join('')).toContain('残留记录')
  })

  it('记录损坏：提示记录异常', () => {
    const content = buildStatusPanelContent({
      ...stopped,
      reason: 'record-invalid',
    })

    expect(content.fields[0]?.value).toContain('记录异常')
    expect(content.notes.join('')).toContain('损坏')
  })

  it('提供启动命令提示', () => {
    const commands = buildStatusPanelContent(stopped).actions.map(
      (action) => action.command,
    )

    expect(commands).toEqual(['e2e_assistant start'])
  })

  it('仍展示日志路径（服务崩过之后最想看的就是它）', () => {
    const content = buildStatusPanelContent(stopped)

    expect(content.fields.some((field) => field.label === '日志')).toBe(true)
  })

  it('仅在「从未启动」时给吉祥物台词', () => {
    // 一边报告残留记录一边卖萌会显得轻佻。
    expect(buildStatusPanelContent(stopped).mascot).not.toBe('')
    expect(
      buildStatusPanelContent({ ...stopped, reason: 'service-gone' }).mascot,
    ).toBe('')
    expect(
      buildStatusPanelContent({ ...stopped, reason: 'record-invalid' }).mascot,
    ).toBe('')
  })

  it('概述行放得进最窄卡片的同一行', () => {
    expect(
      measureTextWidth(buildStatusPanelContent(stopped).headline),
    ).toBeLessThanOrEqual(HEADLINE_BUDGET)
  })
})

describe('buildStatusPanelContent（无法确认）', () => {
  it('概述行不把状态说成「未运行」', () => {
    // 说成未运行会诱导用户去 start，而端口实际被占——新实例会顺延端口
    // 并覆盖记录，让仍可能存活的旧服务失去可管理性。
    const headline = buildStatusPanelContent(unconfirmable).headline

    expect(headline).toContain('无法确认')
    expect(headline).not.toContain('is not running')
  })

  it('不给任何动作提示', () => {
    expect(buildStatusPanelContent(unconfirmable).actions).toEqual([])
  })

  it('给出状态判定的原始原因', () => {
    expect(buildStatusPanelContent(unconfirmable).notes.join('')).toContain(
      '未在限时内响应健康探测',
    )
  })

  it('声明未清理记录、未结束进程', () => {
    const notes = buildStatusPanelContent(unconfirmable).notes.join('')

    expect(notes).toContain('未清理')
    expect(notes).toContain('未结束')
  })

  it('展示记录中的端口与 PID，并标明出自记录', () => {
    const fields = buildStatusPanelContent(unconfirmable).fields

    expect(fields.find((field) => field.label === '端口')?.value).toBe('5826')
    expect(fields.find((field) => field.label === 'PID')?.value).toContain(
      '记录中的',
    )
  })

  it('状态值标为待确认', () => {
    expect(buildStatusPanelContent(unconfirmable).fields[0]?.value).toContain(
      '待确认',
    )
  })

  it('概述行放得进最窄卡片的同一行', () => {
    expect(
      measureTextWidth(buildStatusPanelContent(unconfirmable).headline),
    ).toBeLessThanOrEqual(HEADLINE_BUDGET)
  })
})

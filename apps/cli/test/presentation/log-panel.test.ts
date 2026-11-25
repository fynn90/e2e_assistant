/**
 * 日志提示面板内容装配的测试。
 *
 * 范围界定：面板只负责**提示类**输出。日志正文是原始文本，不经过面板——
 * 套边框会破坏可读性与可复制性，且 e2e 只要求 `log` 输出非空。
 */
import { describe, expect, it } from 'vitest'
import { buildLogPanelContent } from '../../src/presentation/console/log-panel'

const LOG_PATH = 'C:\\Users\\PC\\AppData\\Roaming\\e2e_assistant\\logs\\service.log'

describe('buildLogPanelContent', () => {
  it('前台运行中：说明日志在它自己的终端', () => {
    const content = buildLogPanelContent({
      notice: 'foreground-running',
      logPath: LOG_PATH,
    })

    expect(content.headline).toContain('前台模式')
    expect(content.notes.join('')).toContain('不写日志文件')
  })

  it('前台运行中：不给出日志路径字段（那份日志文件与本次无关）', () => {
    const content = buildLogPanelContent({
      notice: 'foreground-running',
      logPath: LOG_PATH,
    })

    expect(content.fields).toEqual([])
  })

  it('尚无日志文件：给出路径与两种启动方式', () => {
    const content = buildLogPanelContent({
      notice: 'no-log-file',
      logPath: LOG_PATH,
    })

    expect(content.fields.map((field) => field.label)).toContain('日志文件')
    expect(content.fields[0]?.value).toBe(LOG_PATH)

    const commands = content.actions.map((action) => action.command)
    expect(commands).toContain('e2e_assistant start')
    // 前台模式不落盘，这里必须一并告知，否则用户会以为「启动过就该有日志」。
    expect(commands).toContain('e2e_assistant start --foreground')
  })

  it('两种提示都带吉祥物台词', () => {
    for (const notice of ['foreground-running', 'no-log-file'] as const) {
      const content = buildLogPanelContent({ notice, logPath: LOG_PATH })

      expect(content.mascot.length).toBeGreaterThan(0)
    }
  })
})

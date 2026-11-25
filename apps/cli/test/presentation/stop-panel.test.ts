/**
 * 停止面板内容装配的测试。
 *
 * 关键契约：**结论文案原样呈现**。`已优雅停止` 等由应用层产出，既是 e2e 的
 * 断言目标，也是「回退原因」这类重要说明的载体——面板重新措辞会同时破坏两者。
 */
import { describe, expect, it } from 'vitest'
import { measureTextWidth } from '../../src/presentation/console/text-width'
import { CARD_MIN_COLUMNS } from '../../src/presentation/console/terminal-output-mode'
import {
  buildStopPanelContent,
  type IStopPanelInput,
} from '../../src/presentation/console/stop-panel'

const gracefulStop: IStopPanelInput = {
  stopped: true,
  alreadyStopped: false,
  message: 'Authine E2E Agent Platform 服务已优雅停止。',
  serverUrl: 'http://127.0.0.1:5826',
  port: 5826,
  pid: 12345,
  startedAt: '2026-10-13T06:32:08.000Z',
}

describe('buildStopPanelContent', () => {
  it('结论文案逐字保留（e2e 断言 `已优雅停止`）', () => {
    expect(buildStopPanelContent(gracefulStop).headline).toContain('已优雅停止')
  })

  it('回退原因等长文案也逐字保留', () => {
    // stop 的若干分支会把回退原因拼在结论前，面板不得省略或改写这一段。
    const message =
      '关闭端点无响应，已改用信号请求停止（服务会执行自身的收尾流程）。 Authine E2E Agent Platform 服务已停止。'
    const content = buildStopPanelContent({ ...gracefulStop, message })

    expect(content.headline).toContain('关闭端点无响应')
    expect(content.headline).toContain('服务已停止')
  })

  it('展示地址、端口、PID 与启动时间', () => {
    const labels = buildStopPanelContent(gracefulStop).fields.map(
      (field) => field.label,
    )

    expect(labels).toEqual(['地址', '端口', 'PID', '启动时间'])
  })

  it('没有运行态记录时字段为空，不渲染占位行', () => {
    // 记录缺失 / 损坏的分支拿不到任何信息，补 `undefined` 会让用户以为查到过记录。
    const content = buildStopPanelContent({
      stopped: false,
      alreadyStopped: true,
      message: '当前没有运行中的 Authine E2E Agent Platform 服务。',
    })

    expect(content.fields).toEqual([])
  })

  it('只有地址没有端口与 PID 时，仅渲染地址一行', () => {
    const content = buildStopPanelContent({
      stopped: false,
      alreadyStopped: true,
      message:
        '检测到陈旧的运行态记录，但该服务已不再运行，已自动清理，未结束任何进程。',
      serverUrl: 'http://127.0.0.1:5826',
    })

    expect(content.fields.map((field) => field.label)).toEqual(['地址'])
  })

  it('不提供命令提示（服务已停，提示启动命令属于越界建议）', () => {
    expect(buildStopPanelContent(gracefulStop).actions).toEqual([])
  })

  it('三种结果各自给出不同台词', () => {
    const stopped = buildStopPanelContent(gracefulStop).mascot
    const already = buildStopPanelContent({
      stopped: false,
      alreadyStopped: true,
      message: '当前没有运行中的服务。',
    }).mascot
    const failed = buildStopPanelContent({
      stopped: false,
      alreadyStopped: false,
      message: '停止服务超时，运行态记录已保留，请稍后重试或手动检查进程状态。',
    }).mascot

    expect(new Set([stopped, already, failed]).size).toBe(3)
  })

  it('概述行放得进最窄卡片的同一行', () => {
    // 停止文案通常比启动文案长；超宽会折行，但不影响 e2e 断言（子串仍在），
    // 因此这里只确保「优雅停止」这条最常见结论不折行。
    const { headline } = buildStopPanelContent(gracefulStop)

    expect(measureTextWidth(headline)).toBeLessThanOrEqual(CARD_MIN_COLUMNS - 6)
  })
})

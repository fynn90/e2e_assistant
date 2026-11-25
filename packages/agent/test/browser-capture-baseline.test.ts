/**
 * 验证 browser_capture_baseline 工具（v12）：归档语义与失败行为。
 *
 * 重点锁定一个**与 browser_screenshot 相反**的设计决定：
 * 截图归档是旁路能力（失败可降级为「界面不展示」），而**基线是正式产物**——
 * 未注入归档端口时必须明确失败，不能静默降级，否则执行期会因基线缺失而整体失败，
 * 且用户看不到根因。
 */

import { describe, expect, it, vi } from 'vitest'
import { createBrowserCaptureBaselineTool } from '../src/tools/browser/browser_capture_baseline'
import type {
  IBrowserSessionHost,
  IVisualBaselineArchive,
} from '../src/tools/browser/Browser_session'

/** 一张最小的 base64 PNG（内容不重要）。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

/** 构造一个只实现本工具所需能力的宿主替身。 */
function buildHost(options: {
  archive?: IVisualBaselineArchive
  width?: number
  height?: number
}): IBrowserSessionHost {
  return {
    baseUrl: 'https://example.test',
    headed: false,
    openPage: vi.fn(),
    snapshotPage: vi.fn(),
    queryElements: vi.fn(),
    clickElement: vi.fn(),
    selectElementOption: vi.fn(),
    waitForPage: vi.fn(),
    captureScreenshot: vi.fn(),
    captureFullContentScreenshot: vi.fn().mockResolvedValue({
      data: TINY_PNG_BASE64,
      mimeType: 'image/png',
      width: options.width ?? 600,
      height: options.height ?? 800,
    }),
    ...(options.archive ? { visualBaselineArchive: options.archive } : {}),
  } as unknown as IBrowserSessionHost
}

/** 直接调用工具的 execute（跳过运行器的参数校验，专注归档语义）。 */
async function runTool(
  host: IBrowserSessionHost,
  parameters: { selector: string; segments: string[]; fileName: string },
) {
  const tool = createBrowserCaptureBaselineTool(host)
  return tool.execute(
    'call-1',
    parameters,
    undefined as never,
    undefined as never,
  )
}

describe('browser_capture_baseline', () => {
  it('未注入基线归档端口时明确失败（不静默降级）', async () => {
    const host = buildHost({})

    await expect(
      runTool(host, {
        selector: '.canvas',
        segments: ['preview'],
        fileName: 'a.png',
      }),
    ).rejects.toThrow(/未启用视觉基线归档/)
  })

  it('归档成功时返回基线路径，并把图片交给模型', async () => {
    const archive = vi.fn().mockResolvedValue({
      relativePath: 'baselines/preview/a.png',
      width: 600,
      height: 800,
    })
    const host = buildHost({ archive: { archive } })

    const result = await runTool(host, {
      selector: '.canvas',
      segments: ['preview'],
      fileName: 'a.png',
    })

    expect(archive).toHaveBeenCalledOnce()
    // 分组分段与文件名原样透传给归档端口。
    expect(archive.mock.calls[0]?.[1]).toEqual({
      segments: ['preview'],
      fileName: 'a.png',
    })

    const details = result.details as {
      relativePath: string
      imageOmitted: boolean
      width: number
      height: number
    }
    expect(details.relativePath).toBe('baselines/preview/a.png')
    expect(details.imageOmitted).toBe(false)
    expect(details.width).toBe(600)
    expect(details.height).toBe(800)

    // 图片作为 image 内容回传，供模型确认基准画面。
    const contents = result.content as Array<{ type: string }>
    expect(contents.some((item) => item.type === 'image')).toBe(true)
  })

  it('同时使用完整内容截图（而非普通可视区截图）', async () => {
    const archive = vi.fn().mockResolvedValue({
      relativePath: 'baselines/p/a.png',
      width: 600,
      height: 800,
    })
    const host = buildHost({ archive: { archive } })

    await runTool(host, {
      selector: '.canvas',
      segments: ['p'],
      fileName: 'a.png',
    })

    // 必须走 fullContent 通道，否则滚动容器会截不全。
    expect(host.captureFullContentScreenshot).toHaveBeenCalledOnce()
    expect(host.captureScreenshot).not.toHaveBeenCalled()
  })

  it('归档失败时向上抛出（基线是正式产物，不降级）', async () => {
    const archive = vi.fn().mockRejectedValue(new Error('磁盘已满'))
    const host = buildHost({ archive: { archive } })

    // 关键：必须先落盘成功才回传图片——归档失败即整体失败，
    // 否则模型会误以为基线已保存。
    await expect(
      runTool(host, {
        selector: '.canvas',
        segments: ['p'],
        fileName: 'a.png',
      }),
    ).rejects.toThrow('磁盘已满')
  })
})

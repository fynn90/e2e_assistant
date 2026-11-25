/**
 * 验证「完整内容截图」能截到元素内部滚动区域（v12，技术方案 §8.1）。
 *
 * 本文件的断言针对两个**已实测的真实陷阱**，它们是 v12 方案的存在理由：
 *   1. Playwright 官方的元素截图只截可视区（200×200 容器内含 600×800 内容时只有 200×200）；
 *   2. CDP `captureBeyondViewport` 尺寸正确但内容**空白**（视口外未绘制）。
 * 因此这里不仅断言**尺寸**，还断言**四角像素颜色**——只断言尺寸无法区分手法 1/2 与正确实现。
 */

import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { createBrowserSessionFactory } from '../src/browser-session/browser-session-factory'
import type { IBrowserSession } from '../src/contracts/browser'

const hasChromium = existsSync(chromium.executablePath())

/** 每个用例真实启动一次 Chromium，统一放宽超时（与 browser-session.test.ts 同口径）。 */
const TEST_TIMEOUT_MS = 30_000

/**
 * fixture 页面：一个 200×200 的滚动容器，内含 600×800 的**四色**内容。
 *
 * 四色布局（各 300×400）是为了让「是否截到完整内容」可由四角像素直接判定：
 *   - 左上 #ff0000（红）  - 右上 #00ff00（绿）
 *   - 左下 #0000ff（蓝）  - 右下 #ffff00（黄）
 * 若实现退化为「只截可视区」，四角会全是红色；若退化为 CDP 手法，四角会出现白色。
 */
const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>FullContentFixture</title></head>
  <body style="margin:0">
    <div id="scroll-box" data-testid="scroll-box"
         style="width:200px;height:200px;overflow:auto">
      <div style="width:600px;height:800px;position:relative">
        <div style="position:absolute;left:0;top:0;width:300px;height:400px;background:#ff0000"></div>
        <div style="position:absolute;left:300px;top:0;width:300px;height:400px;background:#00ff00"></div>
        <div style="position:absolute;left:0;top:400px;width:300px;height:400px;background:#0000ff"></div>
        <div style="position:absolute;left:300px;top:400px;width:300px;height:400px;background:#ffff00"></div>
      </div>
    </div>
    <div id="plain" data-testid="plain"
         style="width:120px;height:45px;background:#123456"></div>
  </body>
</html>`

/**
 * 启动只用于本文件测试的 fixture HTTP 服务。
 *
 * @returns 服务实例与可访问 URL。
 * @throws 监听失败时抛出 Node HTTP 错误。
 */
async function startFixtureServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(FIXTURE_HTML)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fixture server 未返回 TCP 地址')
  }
  return { server, url: `http://127.0.0.1:${address.port}` }
}

/**
 * 关闭 fixture HTTP 服务。
 *
 * @param server - 待关闭的服务。
 * @returns 关闭完成。
 * @throws 关闭失败时抛出 Node HTTP 错误。
 */
async function closeFixtureServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * 从 PNG 字节读取指定坐标的 RGB。
 *
 * 不引入图像解码依赖：直接读 IHDR 取尺寸与颜色类型，inflate 后逐行反滤波。
 * Playwright 截图实测为 8-bit、**colorType 2（RGB，3 字节/像素）**、无交错；
 * 这里按 colorType 推导每像素字节数，避免把 RGB 当 RGBA 解析导致行偏移。
 *
 * @param pngBytes - PNG 文件字节。
 * @param x - 目标横坐标（0 起）。
 * @param y - 目标纵坐标（0 起）。
 * @returns 该坐标的 RGB 分量。
 * @throws {Error} 坐标越界或颜色类型不受支持时抛出。
 */
async function readPixelRgb(
  pngBytes: Buffer,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number }> {
  const zlib = await import('node:zlib')
  let offset = 8
  const idatChunks: Buffer[] = []
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0

  while (offset < pngBytes.length) {
    const length = pngBytes.readUInt32BE(offset)
    const type = pngBytes.toString('latin1', offset + 4, offset + 8)
    const data = pngBytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (bitDepth !== 8) {
    throw new Error(`本测试只支持 8-bit PNG，实际为 ${bitDepth}-bit`)
  }

  // colorType: 0=灰度(1) 2=RGB(3) 4=灰度+alpha(2) 6=RGBA(4)
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = channelsByColorType[colorType]
  if (channels === undefined) {
    throw new Error(`本测试不支持的颜色类型：colorType=${colorType}`)
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks))
  const stride = width * channels
  const previousRow = Buffer.alloc(stride)
  const currentRow = Buffer.alloc(stride)
  let rawOffset = 0

  for (let row = 0; row < height; row += 1) {
    const filterType = raw[rawOffset]
    rawOffset += 1
    raw.copy(currentRow, 0, rawOffset, rawOffset + stride)
    rawOffset += stride

    // PNG 逐行反滤波（类型 0–4）。
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? currentRow[i - channels] : 0
      const up = previousRow[i]
      const upLeft = i >= channels ? previousRow[i - channels] : 0

      if (filterType === 1) currentRow[i] = (currentRow[i] + left) & 0xff
      else if (filterType === 2) currentRow[i] = (currentRow[i] + up) & 0xff
      else if (filterType === 3)
        currentRow[i] = (currentRow[i] + ((left + up) >> 1)) & 0xff
      else if (filterType === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        currentRow[i] = (currentRow[i] + predictor) & 0xff
      }
    }

    if (row === y) {
      const pixelOffset = x * channels
      // 灰度图三个分量取同一个值，便于统一断言。
      const gray = currentRow[pixelOffset]
      return channels <= 2
        ? { r: gray, g: gray, b: gray }
        : {
            r: currentRow[pixelOffset],
            g: currentRow[pixelOffset + 1],
            b: currentRow[pixelOffset + 2],
          }
    }

    currentRow.copy(previousRow)
  }

  throw new Error(`目标坐标 (${x}, ${y}) 超出图片范围 ${width}×${height}`)
}

describe('captureLocatorFullContent', () => {
  it.skipIf(!hasChromium)(
    'captures the full scrollable content, not just the visible viewport',
    async () => {
      const fixture = await startFixtureServer()
      const factory = createBrowserSessionFactory()
      let session: IBrowserSession | undefined

      try {
        session = await factory.create({ baseUrl: fixture.url, headed: false })
        await session.navigate(fixture.url)

        const shot = await session.screenshotFullContent({
          selector: '#scroll-box',
        })

        // 断言 1：尺寸是**内容**尺寸（600×800），而不是容器包围盒（200×200）。
        // 这一条会同时挡住「直接截元素」与「CDP 空白截图」之外的退化实现。
        expect(shot.width).toBe(600)
        expect(shot.height).toBe(800)

        const buffer = Buffer.from(shot.data, 'base64')

        // 断言 2：四角像素分别为四色——证明截到的是**真实内容**而非空白/裁剪。
        // 只断言尺寸无法发现 CDP 手法（尺寸对但内容是白）。
        const topLeft = await readPixelRgb(buffer, 2, 2)
        const topRight = await readPixelRgb(buffer, 597, 2)
        const bottomLeft = await readPixelRgb(buffer, 2, 797)
        const bottomRight = await readPixelRgb(buffer, 597, 797)

        expect(topLeft).toEqual({ r: 0xff, g: 0x00, b: 0x00 })
        expect(topRight).toEqual({ r: 0x00, g: 0xff, b: 0x00 })
        expect(bottomLeft).toEqual({ r: 0x00, g: 0x00, b: 0xff })
        expect(bottomRight).toEqual({ r: 0xff, g: 0xff, b: 0x00 })
      } finally {
        await session?.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'restores the original inline style after capturing',
    async () => {
      const fixture = await startFixtureServer()
      const factory = createBrowserSessionFactory()
      let session: IBrowserSession | undefined

      try {
        session = await factory.create({ baseUrl: fixture.url, headed: false })
        await session.navigate(fixture.url)

        const styleBefore = await session.query('#scroll-box')
        await session.screenshotFullContent({ selector: '#scroll-box' })
        const styleAfter = await session.query('#scroll-box')

        // 样式必须逐字还原：展开样式只应是捕获期间的临时状态。
        expect(styleAfter[0]?.attributes?.style).toBe(
          styleBefore[0]?.attributes?.style,
        )

        // 还原后再次捕获应得到相同结果（证明元素仍可用，未被永久破坏）。
        const second = await session.screenshotFullContent({
          selector: '#scroll-box',
        })
        expect(second.width).toBe(600)
        expect(second.height).toBe(800)
      } finally {
        await session?.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'behaves like a plain element screenshot when there is no internal overflow',
    async () => {
      const fixture = await startFixtureServer()
      const factory = createBrowserSessionFactory()
      let session: IBrowserSession | undefined

      try {
        session = await factory.create({ baseUrl: fixture.url, headed: false })
        await session.navigate(fixture.url)

        const shot = await session.screenshotFullContent({ selector: '#plain' })

        // 无内部溢出时不应展开样式——尺寸就是元素包围盒，避免改变布局。
        expect(shot.width).toBe(120)
        expect(shot.height).toBe(45)
      } finally {
        await session?.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )

  it.skipIf(!hasChromium)(
    'rejects an empty selector',
    async () => {
      const fixture = await startFixtureServer()
      const factory = createBrowserSessionFactory()
      let session: IBrowserSession | undefined

      try {
        session = await factory.create({ baseUrl: fixture.url, headed: false })
        await session.navigate(fixture.url)

        await expect(
          session.screenshotFullContent({ selector: '   ' }),
        ).rejects.toMatchObject({ code: 'ENGINE_CONFIGURATION_INVALID' })
      } finally {
        await session?.close()
        await closeFixtureServer(fixture.server)
      }
    },
    TEST_TIMEOUT_MS,
  )
})

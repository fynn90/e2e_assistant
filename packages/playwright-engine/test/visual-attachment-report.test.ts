/**
 * 验证报告渲染对视觉比对附件的语义分类与展示（v12 §6）。
 *
 * 关键背景（实测，技术方案 §2.3）：Playwright 视觉断言失败时产出的附件名
 * **带路径段前缀**（形如 `preview\candidate-a-diff.png`），因此分类必须按**后缀**匹配。
 * 本测试用带前缀的真实形态做断言，防止实现退化为全名相等比较。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  classifyVisualAttachment,
  renderTestReportHtml,
  type ITestReportMetadata,
} from '../src/formatting/test-report-renderer'
import type { IPlaywrightJsonReport } from '../src/runner'

let workDir: string

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'visual-report-'))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
})

const metadata: ITestReportMetadata = {
  skillTitle: '登录验证',
  skillId: 'abc123def',
  runId: '20260922-120000',
  startedAt: '2026-09-22T12:00:00.000Z',
  baseUrl: 'https://example.test',
  headed: true,
}

/** 一张最小的真实 PNG（1×1 透明像素），供内嵌断言使用。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('classifyVisualAttachment', () => {
  it('按后缀识别三类视觉附件（含带路径段前缀的真实形态）', () => {
    // 实测形态：附件名带分组前缀。
    expect(classifyVisualAttachment('preview\\candidate-a-diff.png')).toBe(
      'diff',
    )
    expect(classifyVisualAttachment('candidate-a-expected.png')).toBe(
      'expected',
    )
    expect(classifyVisualAttachment('candidate-a-actual.png')).toBe('actual')
    expect(classifyVisualAttachment('failure-screenshot.png')).toBe(
      'screenshot',
    )
  })

  it('大小写不敏感', () => {
    expect(classifyVisualAttachment('A-DIFF.PNG')).toBe('diff')
  })
})

describe('renderTestReportHtml 视觉附件展示', () => {
  it('每张图独立成卡片：标题栏在上、图片在下，多图可分辨', async () => {
    const diffPath = path.join(workDir, 'a-diff.png')
    const expectedPath = path.join(workDir, 'a-expected.png')
    const actualPath = path.join(workDir, 'a-actual.png')
    const png = Buffer.from(TINY_PNG_BASE64, 'base64')
    await writeFile(diffPath, png)
    await writeFile(expectedPath, png)
    await writeFile(actualPath, png)

    const report: IPlaywrightJsonReport = {
      suites: [
        {
          specs: [
            {
              title: '预览画布与基线一致',
              ok: false,
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 800,
                      error: {
                        message: '视觉比对未通过，已尝试候选：candidate-a.png',
                      },
                      // 带路径段前缀的真实附件名。
                      attachments: [
                        {
                          name: 'preview\\candidate-a-expected.png',
                          contentType: 'image/png',
                          path: expectedPath,
                        },
                        {
                          name: 'preview\\candidate-a-actual.png',
                          contentType: 'image/png',
                          path: actualPath,
                        },
                        {
                          name: 'preview\\candidate-a-diff.png',
                          contentType: 'image/png',
                          path: diffPath,
                        },
                      ],
                      steps: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const html = await renderTestReportHtml(report, metadata)

    // 差异热点图有专属区块与高亮样式。
    expect(html).toContain('视觉比对未通过')
    expect(html).toContain('差异热点图')
    expect(html).toContain('visual-diff')
    // 基线与实际按角色区分。
    expect(html).toContain('期望基线')
    expect(html).toContain('实际画面')
    // 三张图都内嵌了。
    expect(html.match(/data:image\/png;base64,/g)?.length).toBe(3)

    // v13：每张图是独立卡片，标题栏内含角色名，且**位于图片之前**——
    // 这是「多张图时能否分辨哪张是基线」的关键。
    const cards = html.match(/<figure class="shot-card[^"]*">/g) ?? []
    expect(cards.length).toBe(3)
    for (const marker of [
      'shot-card diff',
      'shot-card expected',
      'shot-card actual',
    ]) {
      expect(html).toContain(marker)
    }

    // 标题栏必须在图片之前出现（标题在上、图片在下）。
    const expectedCardIndex = html.indexOf('shot-card expected')
    const expectedImgIndex = html.indexOf('candidate-a-expected.png" src=')
    expect(expectedCardIndex).toBeGreaterThan(-1)
    expect(expectedImgIndex).toBeGreaterThan(expectedCardIndex)

    // 文件名随角色名一并展示，便于定位到具体基线文件。
    const head = html.slice(
      expectedCardIndex,
      html.indexOf('</figcaption>', expectedCardIndex),
    )
    expect(head).toContain('期望基线')
    expect(head).toContain('candidate-a-expected.png')
  })

  it('多份基线并存时，每张卡片各自标明角色与文件名', async () => {
    // 用户反馈的场景：候选基线有多份（对应不同模板 id），
    // 此前所有图片下方都是同一种小字说明，无法分辨哪张是哪张。
    const png = Buffer.from(TINY_PNG_BASE64, 'base64')
    const names = [
      'preview\\candidate-a-expected.png',
      'preview\\candidate-a-actual.png',
      'preview\\candidate-b-expected.png',
      'preview\\candidate-b-actual.png',
    ]
    const attachments = await Promise.all(
      names.map(async (name, index) => {
        const filePath = path.join(workDir, `multi-${index}.png`)
        await writeFile(filePath, png)
        return { name, contentType: 'image/png', path: filePath }
      }),
    )

    const report: IPlaywrightJsonReport = {
      suites: [
        {
          specs: [
            {
              title: '多候选视觉比对',
              ok: false,
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 500,
                      error: { message: '视觉比对未通过' },
                      attachments,
                      steps: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const html = await renderTestReportHtml(report, metadata)

    // 四张图 → 四张卡片，且每个文件名都出现在各自的标题栏中。
    expect((html.match(/<figure class="shot-card/g) ?? []).length).toBe(4)
    for (const name of [
      'candidate-a-expected',
      'candidate-a-actual',
      'candidate-b-expected',
      'candidate-b-actual',
    ]) {
      expect(html).toContain(name)
    }

    // 每张卡片的标题栏（figcaption）里都有角色名与对应文件名——
    // 逐张校验，防止出现「标题栏与图片错配」。
    const captions =
      html.match(/<figcaption class="shot-card-head">.*?<\/figcaption>/g) ?? []
    expect(captions.length).toBe(4)
    expect(captions.filter((c) => c.includes('期望基线')).length).toBe(2)
    expect(captions.filter((c) => c.includes('实际画面')).length).toBe(2)
    // 角色与文件名在同一标题栏内成对出现。
    expect(
      captions.some(
        (c) => c.includes('期望基线') && c.includes('candidate-a-expected.png'),
      ),
    ).toBe(true)
    expect(
      captions.some(
        (c) => c.includes('实际画面') && c.includes('candidate-b-actual.png'),
      ),
    ).toBe(true)
  })

  it('非视觉附件仍按普通截图平铺（回归保护）', async () => {
    const shotPath = path.join(workDir, 'failure-screenshot.png')
    await writeFile(shotPath, Buffer.from(TINY_PNG_BASE64, 'base64'))

    const report: IPlaywrightJsonReport = {
      suites: [
        {
          specs: [
            {
              title: '普通失败',
              ok: false,
              tests: [
                {
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 100,
                      error: { message: '断言失败' },
                      attachments: [
                        {
                          name: 'failure-screenshot.png',
                          contentType: 'image/png',
                          path: shotPath,
                        },
                      ],
                      steps: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const html = await renderTestReportHtml(report, metadata)

    // 不应误判为视觉比对。
    expect(html).not.toContain('视觉比对未通过')
    expect(html).toContain('data:image/png;base64,')
  })

  it('报告仍为自包含单文件（零脚本、零外链）', async () => {
    const report: IPlaywrightJsonReport = { suites: [] }
    const html = await renderTestReportHtml(report, metadata)

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/<link[^>]+href="http/)
  })
})

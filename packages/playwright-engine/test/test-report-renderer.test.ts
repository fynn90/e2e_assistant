/** 验证测试报告渲染：统计映射、截图内嵌降级与自包含 HTML 结构（v11 P6–P8）。 */

import { describe, expect, it } from 'vitest'
import {
  parseTestReportData,
  renderTestReportHtml,
} from '../src/formatting/test-report-renderer'
import type { IPlaywrightJsonReport } from '../src/runner'

const sampleReport: IPlaywrightJsonReport = {
  stats: { expected: 1, unexpected: 1, skipped: 1, flaky: 0, duration: 5200 },
  suites: [
    {
      title: 'chromium',
      specs: [
        {
          title: '登录成功',
          ok: true,
          tests: [
            {
              status: 'expected',
              results: [
                {
                  status: 'passed',
                  duration: 1200,
                  steps: [
                    // 实测（playwright 1.62 JSON 报告）：步骤节点不携带 category。
                    { title: 'step_login', steps: [] },
                    { title: 'beforeEach 钩子', category: 'hook', steps: [] },
                  ],
                },
              ],
            },
          ],
        },
        {
          title: '登录失败提示',
          ok: false,
          tests: [
            {
              status: 'unexpected',
              results: [
                {
                  status: 'failed',
                  duration: 3000,
                  error: { message: '期望包含 "工作台"，实际为 "登录页"' },
                  steps: [
                    {
                      title: 'step_login',
                      category: 'test.step',
                      error: { message: '点击失败' },
                      steps: [],
                    },
                  ],
                  attachments: [
                    {
                      name: 'failure-screenshot',
                      contentType: 'image/png',
                      path: 'nonexistent/test-results/a.png',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          title: '跳过的用例',
          ok: true,
          tests: [
            {
              status: 'skipped',
              results: [{ status: 'skipped', duration: 0, steps: [] }],
            },
          ],
        },
      ],
    },
  ],
}

const metadata = {
  skillTitle: '登录验证',
  skillId: 'abc123456',
  runId: '20260918-153045',
  startedAt: '2026-09-18T15:30:45+08:00',
  baseUrl: 'https://example.test',
  headed: true,
  stepTitles: { step_login: '填写用户名和密码并登录' },
}

describe('parseTestReportData', () => {
  it('摊平 suites 树并正确映射统计', () => {
    const data = parseTestReportData(sampleReport)
    expect(data.entries).toHaveLength(3)
    expect(data.stats).toMatchObject({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      durationMs: 5200,
    })
  })

  it('失败条目携带错误信息与失败步骤 id', () => {
    const data = parseTestReportData(sampleReport)
    const failed = data.entries[1]
    expect(failed.result.status).toBe('failed')
    expect(failed.result.errorMessage).toContain('工作台')
    expect(failed.result.failedStepId).toBe('step_login')
  })

  it('步骤收集业务步骤并排除 hook（文档顺序）', () => {
    const data = parseTestReportData(sampleReport)
    expect(data.entries[0].steps).toEqual([
      { stepId: 'step_login', ok: true, depth: 0 },
    ])
  })

  it('空报告（运行被硬终止）不抛出且零条目', () => {
    const data = parseTestReportData({})
    expect(data.entries).toHaveLength(0)
    expect(data.stats.total).toBe(0)
  })
})

describe('renderTestReportHtml', () => {
  it('渲染自包含 HTML：零脚本、零外链、汇总与明细齐全', async () => {
    const html = await renderTestReportHtml(sampleReport, metadata)

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/<link[^>]+href="http/)
    expect(html).toContain('登录验证')
    expect(html).toContain('20260918-153045')
    expect(html).toContain('有头（headed）')
    expect(html).toContain('登录成功')
    // 步骤展示名优先使用用例描述（X8 同源）。
    expect(html).toContain('填写用户名和密码并登录')
    // 平台元数据不含 env 值：HTML 内不出现 env.json 字样。
    expect(html).not.toContain('env.json')
  })

  it('HTML 转义标题中的危险字符', async () => {
    const malicious: IPlaywrightJsonReport = {
      suites: [
        {
          specs: [
            {
              title: '<script>alert(1)</script>',
              tests: [
                {
                  status: 'expected',
                  results: [{ status: 'passed', duration: 1, steps: [] }],
                },
              ],
            },
          ],
        },
      ],
    }
    const html = await renderTestReportHtml(malicious, metadata)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('附件读取失败时降级为占位文案而不是抛出', async () => {
    const html = await renderTestReportHtml(sampleReport, metadata)
    expect(html).not.toContain('data:image/png;base64')
    // 附件名占位：读取失败不产生内嵌图片，也不抛异常。
    expect(html).toContain('登录失败提示')
  })
})

/**
 * 验证执行配置生成器（v12 §5.1，v14 字段更名 snapshotRoot）：
 *   - `updateSnapshots: 'none'` 恒写入（执行期绝不写基线目录）；
 *   - `snapshotPathTemplate` 仅在宿主提供快照根时写入，且路径归一为 POSIX 分隔符；
 *   - 未提供快照根时**不写入**该字段（脚本会明确失败，而不是静默写错位置）。
 */

import { describe, expect, it } from 'vitest'
import { buildConfigContent } from '../src/runner-config-builder'
import type { ITestRunRequest } from '../src/runner'

/** 构造一份最小可用的执行请求。 */
function buildRequest(
  overrides: Partial<ITestRunRequest> = {},
): ITestRunRequest {
  return {
    runId: '20260922-120000',
    skillRoot: 'D:/skills/demo',
    specRelativePath: 'test.spec.ts',
    baseUrl: 'https://example.test',
    env: {},
    timeouts: { testMs: 120_000, overallMs: 600_000 },
    ...overrides,
  }
}

describe('buildConfigContent', () => {
  it('恒写入 updateSnapshots: none —— 执行期绝不写入基线目录', () => {
    const content = buildConfigContent(buildRequest())

    expect(content).toContain("updateSnapshots: 'none'")
  })

  it('宿主提供快照根时写入 snapshotPathTemplate 并归一为 POSIX 分隔符', () => {
    const content = buildConfigContent(
      buildRequest({ snapshotRoot: 'D:\\skills\\demo\\userWorkSpace' }),
    )

    // Windows 反斜杠在模板里不安全，必须已转换为 '/'。
    expect(content).toContain('"D:/skills/demo/userWorkSpace/{arg}{ext}"')
    expect(content).not.toContain('D:\\\\skills')
  })

  it('未提供快照根时不写入 snapshotPathTemplate', () => {
    const content = buildConfigContent(buildRequest())

    // 缺省不写入：脚本会因找不到基线而明确失败，
    // 而不是静默写到工作区默认目录造成「比对的是错文件」。
    expect(content).not.toContain('snapshotPathTemplate')
  })

  it('快照根为空字符串时同样不写入（按未提供处理）', () => {
    const content = buildConfigContent(buildRequest({ snapshotRoot: '   ' }))

    expect(content).not.toContain('snapshotPathTemplate')
  })

  it('snapshotPathTemplate 位于配置顶层而非 use 内', () => {
    const content = buildConfigContent(
      buildRequest({ snapshotRoot: 'D:/skills/demo/userWorkSpace' }),
    )

    const pathTemplateIndex = content.indexOf('snapshotPathTemplate')
    const useIndex = content.indexOf('use: {')

    // 实测：写进 use 内会静默回落默认目录，因此必须位于 use 之前。
    expect(pathTemplateIndex).toBeGreaterThan(-1)
    expect(pathTemplateIndex).toBeLessThan(useIndex)
  })

  it('保留既有的 locale 与有头模式配置（回归保护）', () => {
    const content = buildConfigContent(buildRequest())

    expect(content).toContain('locale: "zh-CN"')
    expect(content).toContain('headless: false')
    expect(content).toContain("testMatch: 'test.spec.ts'")
  })
})

/**
 * 报告摘要读写（v17 §4.4）的单元测试。
 *
 * 摘要与报告**同生共死**：同目录、同删除路径。因此本组同时锁定
 * 「删除报告目录时摘要一并消失」这条边界（R1 的对策①）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IExecutionRunSummary } from '@charlie_deng/e2e-assistant-types'
import {
  deleteTestReportRun,
  listTestReportRuns,
  readTestReportSummary,
  writeTestReportSummary,
} from '../src/test-report'

/** 造一份合法摘要。 */
function createSummary (
  overrides: Partial<IExecutionRunSummary> = {},
): IExecutionRunSummary {
  return {
    schemaVersion: 1,
    skillId: 'abc123456',
    skillTitle: '云7登录',
    runId: '20261009-120000',
    startedAt: '2026-10-09T12:00:00.000Z',
    baseUrl: 'http://localhost:5173',
    stats: {
      total: 3,
      passed: 2,
      failed: 1,
      timedOut: 0,
      interrupted: 0,
      skipped: 0,
      durationMs: 12_000,
    },
    outcome: 'failed',
    failures: [
      {
        title: '登录流程',
        stepId: 's3',
        errorMessage: '未跳转到 /dashboard',
        hasScreenshot: true,
      },
    ],
    reportFile: true,
    ...overrides,
  }
}

describe('writeTestReportSummary / readTestReportSummary 往返', () => {
  it('写入后可原样读回（含 failures 与 stats）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const summary = createSummary()

    const relativePath = await writeTestReportSummary(
      skillRoot,
      summary.runId,
      summary,
    )
    expect(relativePath).toBe('test_report/20261009-120000/summary.json')

    const read = await readTestReportSummary(skillRoot, summary.runId)
    expect(read).toEqual(summary)
  })

  it('runId 非法时写入抛出（与报告同一道闸）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    await expect(
      writeTestReportSummary(skillRoot, '../../etc', createSummary()),
    ).rejects.toThrow()
  })

  it('runId 非法时读取返回 undefined（不越出报告目录）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    await expect(
      readTestReportSummary(skillRoot, '../../secret'),
    ).resolves.toBeUndefined()
  })
})

describe('readTestReportSummary 的坏文件归一', () => {
  it('文件缺失 → undefined（调用方按「该次不可用」处理）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    await expect(
      readTestReportSummary(skillRoot, '20261009-120000'),
    ).resolves.toBeUndefined()
  })

  it('JSON 非法 → undefined（历史卡不该被单份坏摘要打断）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const runDir = join(skillRoot, 'test_report', '20261009-120000')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'summary.json'), '{not json', 'utf8')

    await expect(
      readTestReportSummary(skillRoot, '20261009-120000'),
    ).resolves.toBeUndefined()
  })

  it('schemaVersion 不符 → undefined（版本升级的显式失效，不猜测）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const runDir = join(skillRoot, 'test_report', '20261009-120000')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'summary.json'),
      JSON.stringify({ ...createSummary(), schemaVersion: 2 }),
      'utf8',
    )

    await expect(
      readTestReportSummary(skillRoot, '20261009-120000'),
    ).resolves.toBeUndefined()
  })

  it('必需字段缺失 → undefined（结构校验而非强制断言）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const runDir = join(skillRoot, 'test_report', '20261009-120000')
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'summary.json'),
      JSON.stringify({
        schemaVersion: 1,
        runId: '20261009-120000',
        startedAt: '2026-10-09T12:00:00.000Z',
        // 缺 stats。
      }),
      'utf8',
    )

    await expect(
      readTestReportSummary(skillRoot, '20261009-120000'),
    ).resolves.toBeUndefined()
  })
})

describe('摘要与报告同生共死（R1 的对策①）', () => {
  it('删除报告目录时摘要一并被清理（无需额外逻辑）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const summary = createSummary()
    await writeTestReportSummary(skillRoot, summary.runId, summary)

    // 与报告并列：写入报告文件本身（证明目录结构符合预期）。
    await writeFile(
      join(skillRoot, 'test_report', summary.runId, 'report.html'),
      '<html></html>',
      'utf8',
    )

    expect(await listTestReportRuns(skillRoot)).toEqual([summary.runId])

    await deleteTestReportRun(skillRoot, summary.runId)

    // 摘要随目录一起消失——不会出现「报告已删、历史还在」的假数据。
    await expect(
      readTestReportSummary(skillRoot, summary.runId),
    ).resolves.toBeUndefined()
    expect(await listTestReportRuns(skillRoot)).toEqual([])
  })

  it('listTestReportRuns 与摘要读取的组合：按名升序 = 时间升序', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    for (const runId of ['20261009-100000', '20261009-120000']) {
      await writeTestReportSummary(
        skillRoot,
        runId,
        createSummary({ runId }),
      )
    }

    const runs = await listTestReportRuns(skillRoot)
    expect(runs).toEqual(['20261009-100000', '20261009-120000'])

    // 最新一次 = 末位（历史卡取最新的判据）。
    const latest = runs[runs.length - 1]!
    const summary = await readTestReportSummary(skillRoot, latest)
    expect(summary?.runId).toBe('20261009-120000')
  })

  it('写入是原子替换（不留半份 JSON）', async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), 'summary-'))
    const summary = createSummary()
    await writeTestReportSummary(skillRoot, summary.runId, summary)
    // 再写一次（模拟重跑同名 runId 的极端情形）：内容完整可读。
    await writeTestReportSummary(skillRoot, summary.runId, {
      ...summary,
      stats: { ...summary.stats, passed: 3, failed: 0 },
      outcome: 'passed',
    })

    const read = await readTestReportSummary(skillRoot, summary.runId)
    expect(read?.outcome).toBe('passed')
    expect(read?.stats.passed).toBe(3)

    // 目录里的临时文件已被重命名消费掉。
    const entries = await readFile(
      join(skillRoot, 'test_report', summary.runId, 'summary.json'),
      'utf8',
    )
    expect(() => JSON.parse(entries)).not.toThrow()
  })
})

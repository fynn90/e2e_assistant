/**
 * 检索扩展（v17 §6.1）的单元测试。
 *
 * 覆盖技术方案 §9 与 §6.1 点名的几条：
 *   ① `readTestCase` 的 env key 提取与缺失判定（**用例侧**，与 J4 不同源）；
 *   ② `readRunHistory` 的 truncatedAt 与「缺摘要的降级」（不解析 HTML 兜底）；
 *   ③ `listFiltered` 的筛选语义（含「先筛后补 latestRun」的成本控制）；
 *   ④ 体检**不产生副作用**——调用后 `test_report/` 目录**未**被创建（F9 拆分）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill } from '@fynn90-e2e_assistant/skill-manager'
import type { IExecutionRunSummary } from '@fynn90-e2e_assistant/types'
import { createSkillCatalog } from '../../src/application/agent-workbench/skill-catalog'
import { createReadinessService } from '../../src/application/agent-workbench/execution-readiness'
import { createGenerationTaskRegistry } from '../../src/generation-runtime/generation-task-registry'
import { writeTestReportSummary } from '@fynn90-e2e_assistant/skill-manager'

/**
 * 造一个用例目录（可选带 env.json 值、文档、脚本）。
 */
async function createCaseFixture (
  rootDir: string,
  input: {
    title: string
    description?: string
    baseUrl?: string
    tags?: string[]
    steps?: Array<{
      id: string
      order: number
      description: string
      action: string
      expectedResult: string
      enabled?: boolean
    }>
    envValues?: Record<string, string>
    withDocument?: boolean
    withScript?: boolean
  },
): Promise<{ skillId: string; skillRoot: string }> {
  const created = await createSkill({
    rootDir,
    title: input.title,
    description: input.description ?? '描述',
  })
  const skillId = created.skillManifest.id
  const skillRoot = join(rootDir, created.skillManifest.directoryName!)

  await writeFile(
    join(skillRoot, 'e2e_schema.json'),
    JSON.stringify({
      $schema: './e2e_schema.schema.json',
      schemaVersion: '1.0',
      id: `tc_${skillId}`,
      title: input.title,
      description: input.description ?? '描述',
      baseUrl: input.baseUrl ?? 'http://localhost:5173',
      tags: input.tags ?? [],
      preconditions: [],
      steps: input.steps ?? [
        {
          id: 's1',
          order: 1,
          description: '打开页面',
          action: '导航',
          expectedResult: '可见',
          enabled: true,
        },
      ],
    }),
    'utf8',
  )

  if (input.envValues) {
    await writeFile(
      join(skillRoot, 'env.json'),
      JSON.stringify(input.envValues),
      'utf8',
    )
  }
  if (input.withDocument) {
    await writeFile(join(skillRoot, 'SKILL.md'), '# 文档', 'utf8')
  }
  if (input.withScript) {
    await writeFile(
      join(skillRoot, 'test.spec.ts'),
      "import { test } from '@playwright/test';\ntest('x', async () => {});",
      'utf8',
    )
  }

  return { skillId, skillRoot }
}

/** 写一份报告摘要（含 report.html 占位）。 */
async function writeSummary (
  skillRoot: string,
  summary: IExecutionRunSummary,
): Promise<void> {
  await mkdir(join(skillRoot, 'test_report', summary.runId), {
    recursive: true,
  })
  await writeFile(
    join(skillRoot, 'test_report', summary.runId, 'report.html'),
    '<html></html>',
    'utf8',
  )
  await writeTestReportSummary(skillRoot, summary.runId, summary)
}

/** 造一份摘要。 */
function createSummary (input: {
  skillId: string
  runId: string
  failed?: number
  passed?: number
}): IExecutionRunSummary {
  return {
    schemaVersion: 1,
    skillId: input.skillId,
    skillTitle: '用例',
    runId: input.runId,
    startedAt: '2026-10-09T12:00:00.000Z',
    baseUrl: 'http://localhost:5173',
    stats: {
      total: (input.failed ?? 0) + (input.passed ?? 1),
      passed: input.passed ?? 1,
      failed: input.failed ?? 0,
      timedOut: 0,
      interrupted: 0,
      skipped: 0,
      durationMs: 1000,
    },
    outcome: (input.failed ?? 0) > 0 ? 'failed' : 'passed',
    reportFile: true,
  }
}

describe('readTestCase（Q4）', () => {
  it('env key 清单来自用例声明，缺失判定与用例侧同源', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId } = await createCaseFixture(rootDir, {
      title: '结算',
      withDocument: true,
      withScript: true,
      envValues: { E2E_USER: 'x' },
      steps: [
        {
          id: 's1',
          order: 1,
          description: '用 ${ENV:E2E_USER} 登录',
          action: '输入 ${ENV:E2E_USER}',
          expectedResult: '看到 ${ENV:MISSING_KEY}',
        },
      ],
    })

    const catalog = createSkillCatalog()
    const result = await catalog.readTestCase(rootDir, skillId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 用例声明的引用（含禁用步骤之外的全部启用步骤）。
    expect(result.detail.envKeys).toEqual(['E2E_USER', 'MISSING_KEY'])
    // 缺失判定：E2E_USER 有、MISSING_KEY 没有。
    expect(result.detail.missingEnvKeys).toEqual(['MISSING_KEY'])
    expect(result.detail.hasSkillDocument).toBe(true)
    expect(result.detail.hasPlaywrightScript).toBe(true)
  })

  it('目标不存在 → not-found（不抛异常）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const catalog = createSkillCatalog()

    const result = await catalog.readTestCase(rootDir, 'zzzzzzzzz')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('not-found')
  })

  it('不默认带文档原文（Q5：折叠展示，正文可选）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId } = await createCaseFixture(rootDir, {
      title: '纯用例',
      withDocument: false,
    })
    const catalog = createSkillCatalog()

    const result = await catalog.readTestCase(rootDir, skillId)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail.documentContent).toBeUndefined()
  })
})

describe('readRunHistory（Q7）', () => {
  it('truncatedAt 是报告总数，runs 按最近在前', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir, {
      title: '历史',
    })
    for (const runId of [
      '20261009-100000',
      '20261009-110000',
      '20261009-120000',
    ]) {
      await writeSummary(skillRoot, createSummary({ skillId, runId }))
    }

    const catalog = createSkillCatalog()
    const result = await catalog.readRunHistory(rootDir, skillId, 2)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.history.runs.map((run) => run.runId)).toEqual([
      '20261009-120000',
      '20261009-110000',
    ])
    // 总数为 3（更早的那份如实说明未列出）。
    expect(result.history.truncatedAt).toBe(3)
    expect(result.history.neverExecuted).toBe(false)
  })

  it('从未执行过 → neverExecuted 为 true（如实说明）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId } = await createCaseFixture(rootDir, { title: '没跑过' })
    const catalog = createSkillCatalog()

    const result = await catalog.readRunHistory(rootDir, skillId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.history.neverExecuted).toBe(true)
      expect(result.history.runs).toEqual([])
    }
  })

  it('缺摘要的降级：只有 report.html 的那次被跳过（不解析 HTML 兜底）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir, {
      title: '降级',
    })

    // 一次有摘要。
    await writeSummary(
      skillRoot,
      createSummary({ skillId, runId: '20261009-100000' }),
    )
    // 一次只有报告 HTML（模拟 v17 之前生成的报告）。
    await mkdir(join(skillRoot, 'test_report', '20261009-110000'), {
      recursive: true,
    })
    await writeFile(
      join(skillRoot, 'test_report', '20261009-110000', 'report.html'),
      '<html><body>通过 3 条</body></html>',
      'utf8',
    )

    const catalog = createSkillCatalog()
    const result = await catalog.readRunHistory(rootDir, skillId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 只有带摘要的那次进历史——**不解析 HTML 兜底**（会随改版静默失真）。
    expect(result.history.runs.map((run) => run.runId)).toEqual([
      '20261009-100000',
    ])
    // 但总数如实反映磁盘上的两份报告。
    expect(result.history.truncatedAt).toBe(2)
  })
})

describe('listFiltered（Q1/Q3）', () => {
  it('按状态筛选：缺脚本 / 未执行过 / 最近失败', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const missing = await createCaseFixture(rootDir, {
      title: '缺脚本',
      withDocument: true,
    })
    const ran = await createCaseFixture(rootDir, {
      title: '跑过',
      withDocument: true,
      withScript: true,
    })
    await writeSummary(
      ran.skillRoot,
      createSummary({ skillId: ran.skillId, runId: '20261009-120000', failed: 1 }),
    )

    const catalog = createSkillCatalog()

    const missingScript = await catalog.listFiltered(rootDir, {
      status: 'missing-script',
    })
    expect(missingScript.total).toBe(1)
    expect(missingScript.rows[0]?.skillId).toBe(missing.skillId)

    const lastFailed = await catalog.listFiltered(rootDir, {
      status: 'last-failed',
    })
    expect(lastFailed.total).toBe(1)
    expect(lastFailed.rows[0]?.skillId).toBe(ran.skillId)
    expect(lastFailed.rows[0]?.latestRun?.failed).toBe(1)

    const neverExecuted = await catalog.listFiltered(rootDir, {
      status: 'never-executed',
    })
    // 两个都没跑过——但「跑过」那个有报告，所以只有「缺脚本」命中。
    expect(neverExecuted.total).toBe(1)
    expect(neverExecuted.rows[0]?.skillId).toBe(missing.skillId)
  })

  it('按关键词筛选（匹配标题与步骤内容）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    await createCaseFixture(rootDir, {
      title: '云7登录',
      steps: [
        {
          id: 's1',
          order: 1,
          description: '输入用户名',
          action: '点击登录按钮',
          expectedResult: '进入首页',
        },
      ],
    })
    await createCaseFixture(rootDir, { title: '结算流程' })

    const catalog = createSkillCatalog()

    const byTitle = await catalog.listFiltered(rootDir, { keyword: '登录' })
    expect(byTitle.total).toBe(1)

    // 步骤内容也算（Q3 明确要求：标题 / 描述 / 步骤内容）。
    const byStep = await catalog.listFiltered(rootDir, { keyword: '用户名' })
    expect(byStep.total).toBe(1)
    expect(byStep.rows[0]?.title).toBe('云7登录')

    const none = await catalog.listFiltered(rootDir, { keyword: '不存在的东西' })
    expect(none.total).toBe(0)
  })

  it('清单行带 latestRun（供 Q1 展示「最近一次执行」）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir, {
      title: '有报告',
      withDocument: true,
      withScript: true,
    })
    await writeSummary(
      skillRoot,
      createSummary({ skillId, runId: '20261009-120000', passed: 3 }),
    )

    const catalog = createSkillCatalog()
    const { rows } = await catalog.listFiltered(rootDir, {})

    const row = rows.find((item) => item.skillId === skillId)
    expect(row?.latestRun?.runId).toBe('20261009-120000')
    expect(row?.latestRun?.passed).toBe(3)
    // 时间由 runId 推导（ISO），供前端本地化展示。
    expect(row?.latestRun?.at).toMatch(/^2026-10-09T/)
  })

  it('未筛选时也返回全部行与总数（Q1 的默认形态）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    await createCaseFixture(rootDir, { title: 'A' })
    await createCaseFixture(rootDir, { title: 'B' })

    const catalog = createSkillCatalog()
    const result = await catalog.listFiltered(rootDir, {})
    expect(result.total).toBe(2)
    expect(result.rows).toHaveLength(2)
  })
})

describe('体检不产生副作用（F9 拆分 / R6）', () => {
  it('调用体检后 test_report 目录**未**被创建', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir, {
      title: '体检',
      withDocument: true,
      withScript: true,
    })

    const readiness = createReadinessService({
      taskRegistry: createGenerationTaskRegistry(),
    })

    const result = await readiness.check(rootDir, skillId)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // 「报告目录可写」这一项应通过（目录不存在 = 可建，不算问题）。
      const reportCheck = result.readiness.checks.find(
        (check) => check.code === 'EXECUTION_REPORT_DIR_BLOCKED',
      )
      expect(reportCheck?.ok).toBe(true)
    }

    // **关键断言**：不为「可能根本不执行」的用例创建目录。
    await expect(access(join(skillRoot, 'test_report'))).rejects.toThrow()
  })

  it('体检逐项列出检查结果，且 ok 反映整体', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const { skillId } = await createCaseFixture(rootDir, {
      title: '缺产物',
      // 既不写文档也不写脚本 → 多项不通过。
    })

    const readiness = createReadinessService({
      taskRegistry: createGenerationTaskRegistry(),
    })

    const result = await readiness.check(rootDir, skillId)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.readiness.ok).toBe(false)
    const scriptCheck = result.readiness.checks.find(
      (check) => check.code === 'EXECUTION_SPEC_MISSING',
    )
    expect(scriptCheck?.ok).toBe(false)
    expect(scriptCheck?.message).toBeTruthy()
    // 缺脚本要给出修复入口（生成脚本）。
    expect(scriptCheck?.fixAction).toBe('generate-playwright-script')
  })

  it('体检目标不存在 → 归一化失败（不抛异常）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'catalog-'))
    const readiness = createReadinessService({
      taskRegistry: createGenerationTaskRegistry(),
    })

    const result = await readiness.check(rootDir, 'zzzzzzzzz')
    expect(result.ok).toBe(false)
  })
})

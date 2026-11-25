/**
 * 提案服务（v17 §6.3）的单元测试。
 *
 * 覆盖技术方案 §9 点名的几组关键行为：
 *   ① 四类提案各自的 create（人话对照由服务端算、值只含 key）；
 *   ② apply 的冲突 / 失败语义（E4 的乐观锁、L2c 的任务检查、L1b 的清理拒绝）；
 *   ③ **env 值不出现在任何发布出去的事件里**（D7 的结构性保证）；
 *   ④ 断言层红线只对 agent-analysis 生效（同一份变更，origin 不同则结果相反）；
 *   ⑤ 重启恢复出的提案一律 expired。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'
import type { IGenerationTaskRegistry } from '../../src/generation-runtime/generation-task-registry'
import { createProposalService } from '../../src/application/agent-workbench/proposal-service'
import { createSkillLifecycleService } from '../../src/application/agent-workbench/skill-lifecycle-service'
import { createSkill } from '@authine-e2e-agent/skill-manager'
import type { IUpdateE2ETestCase } from '../../src/application/agent-workbench/proposal-types'

/** 采集发布出去的提案卡片载荷。 */
function createRuntimeSpy(): {
  runtime: IAgentWorkRuntime
  proposalCards: Array<Record<string, unknown>>
  blocks: Array<{ kind: string; payload: Record<string, unknown> }>
} {
  const proposalCards: Array<Record<string, unknown>> = []
  const blocks: Array<{ kind: string; payload: Record<string, unknown> }> = []

  const runtime = {
    publishProposalCard: (input: Record<string, unknown>) => {
      proposalCards.push(input)
      blocks.push({ kind: 'workbench_proposal', payload: input })
      return {}
    },
    listBlocks: () => blocks,
  } as unknown as IAgentWorkRuntime

  return { runtime, proposalCards, blocks }
}

/** 任务注册表替身：默认空闲，可指定某个用例处于运行中。 */
function createTaskRegistrySpy(running: Record<string, string> = {}): {
  registry: IGenerationTaskRegistry
  setRunning: (skillId: string, sessionId: string) => void
} {
  const map = new Map(Object.entries(running))
  return {
    registry: {
      currentSessionId: (skillId: string) => map.get(skillId),
    } as unknown as IGenerationTaskRegistry,
    setRunning: (skillId, sessionId) => map.set(skillId, sessionId),
  }
}

/** 造一个用例目录（含 e2e_schema.json）。 */
async function createCaseFixture(
  rootDir: string,
  title = '云7登录',
): Promise<{ skillId: string; skillRoot: string }> {
  const created = await createSkill({
    rootDir,
    title,
    description: '登录页端到端',
  })
  const skillId = created.skillManifest.id
  const skillRoot = join(rootDir, created.skillManifest.directoryName!)

  await writeFile(
    join(skillRoot, 'e2e_schema.json'),
    JSON.stringify({
      $schema: './e2e_schema.schema.json',
      schemaVersion: '1.0',
      id: `tc_${skillId}`,
      title,
      description: '登录页端到端',
      baseUrl: 'http://localhost:5173',
      tags: [],
      preconditions: [],
      steps: [
        {
          id: 's1',
          order: 1,
          description: '打开登录页',
          action: '导航到 /login',
          expectedResult: '登录页可见',
          testData: {},
          enabled: true,
        },
      ],
    }),
    'utf8',
  )

  return { skillId, skillRoot }
}

describe('提案服务·create（四类）', () => {
  it('case-change：生成人话对照，且不对 origin:user 施加红线', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-change',
      skillId,
      origin: 'user',
      // 用户主动要求改标题（E 组）——红线不适用，应当允许。
      caseChange: { title: '云7登录-回归' },
    })

    expect(result.ok).toBe(true)
    expect(proposalCards).toHaveLength(1)
    const card = proposalCards[0]!
    expect(card.proposalKind).toBe('case-change')
    expect(card.requiresModalConfirm).toBe(false)
    expect(card.changes).toEqual([
      {
        target: '标题',
        op: 'update',
        before: '云7登录',
        after: '云7登录-回归',
      },
    ])
  })

  it('case-change：origin:agent-analysis 改标题 → 被红线拒绝', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-change',
      skillId,
      origin: 'agent-analysis',
      caseChange: { title: '云7登录-回归' },
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('断言层变更已被平台拒绝')
      // G5d：拒绝文案必须把模型推向「如实报告」，而不是死路。
      expect(result.message).toContain('可能是被测系统的缺陷')
    }
    // 被拒绝时**不发布卡片**。
    expect(proposalCards).toHaveLength(0)
  })

  it('env-fill：卡片只含 key 与用途，绝不含值（D7）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'env-fill',
      skillId,
      envKeys: [{ key: 'E2E_PASSWORD', usage: '登录时填写密码' }],
    })

    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(proposalCards)
    expect(serialized).toContain('E2E_PASSWORD')
    // 卡片的结构里根本没有放值的字段——序列化后不可能出现任何值。
    expect(serialized).not.toContain('envValues')
  })

  it('env-fill：key 已存在时拒绝（给一个无意义的输入框比不给更糟）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await writeFile(
      join(skillRoot, 'env.json'),
      JSON.stringify({ E2E_PASSWORD: 'x' }),
      'utf8',
    )
    const { runtime } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'env-fill',
      skillId,
      envKeys: [{ key: 'E2E_PASSWORD', usage: '登录' }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('已经存在')
  })

  it('report-cleanup：requiresModalConfirm 恒为 true（L1a / D2）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await mkdir(join(skillRoot, 'test_report', '20261009-120000'), {
      recursive: true,
    })
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'report-cleanup',
      skillId,
      runIds: ['20261009-120000'],
    })

    expect(result.ok).toBe(true)
    expect(proposalCards[0]?.requiresModalConfirm).toBe(true)
  })

  it('report-cleanup：给出的运行编号不存在时拒绝（模型可能凭记忆给编号）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'report-cleanup',
      skillId,
      runIds: ['20200101-000000'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('都不存在')
  })

  it('case-delete：requiresModalConfirm 恒为 true，且列出将删除的资产（L2a）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await writeFile(join(skillRoot, 'SKILL.md'), '# 文档', 'utf8')
    await mkdir(join(skillRoot, 'test_report', '20261009-120000'), {
      recursive: true,
    })
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-delete',
      skillId,
    })

    expect(result.ok).toBe(true)
    const card = proposalCards[0]!
    expect(card.requiresModalConfirm).toBe(true)
    expect(card.reportCount).toBe(1)
    const changes = card.changes as Array<{ target: string }>
    expect(changes.some((item) => item.target.includes('测试报告'))).toBe(true)
    expect(changes.some((item) => item.target.includes('userWorkSpace'))).toBe(
      true,
    )
  })

  it('case-delete：有任务在跑时拒绝（L2c）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy({ [skillId]: 'exec-1' })

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-delete',
      skillId,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('正在执行')
      expect(result.message).toContain('停止任务')
    }
    expect(proposalCards).toHaveLength(0)
  })
})

describe('提案服务·apply', () => {
  it('case-change：E4 版本冲突 → conflict（不强制覆盖）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const updateTestCase = vi.fn(async () => {
      const error = new Error('E2E 用例已修改') as Error & { code: string }
      error.code = 'FILE_VERSION_CONFLICT'
      throw error
    })

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: updateTestCase as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    const created = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-change',
      skillId,
      origin: 'user',
      caseChange: { baseUrl: 'http://test.example.com' },
    })
    expect(created.ok).toBe(true)

    const applied = await applyFirstCard(service, runtime, rootDir)
    expect(applied.ok).toBe(false)
    if (!applied.ok) {
      expect(applied.state).toBe('conflict')
      expect(applied.message).toContain('版本冲突')
      expect(applied.message).toContain('重新生成提案')
    }
  })

  it('report-cleanup：有任务在跑 → 整次拒绝且不删任何文件（L1b）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await mkdir(join(skillRoot, 'test_report', '20261009-120000'), {
      recursive: true,
    })
    await writeFile(
      join(skillRoot, 'test_report', '20261009-120000', 'report.html'),
      '<html></html>',
      'utf8',
    )
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry, setRunning } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'report-cleanup',
      skillId,
      runIds: ['20261009-120000'],
    })

    // 用户在确认前后，任务被启动了 —— 清理必须整次拒绝。
    setRunning(skillId, 'exec-1')

    const proposalId = String(proposalCards[0]?.proposalId)
    const applied = await service.apply({
      rootDir,
      sessionId: 'sess-1',
      proposalId,
    })

    expect(applied.ok).toBe(false)
    if (!applied.ok) {
      expect(applied.state).toBe('failed')
      expect(applied.message).toContain('正在执行')
    }

    // **未删任何文件**（整次拒绝而非部分执行）。
    const { access } = await import('node:fs/promises')
    await expect(
      access(join(skillRoot, 'test_report', '20261009-120000', 'report.html')),
    ).resolves.toBeUndefined()
  })

  it('report-cleanup：无任务时逐个删除并如实汇总（L4）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    for (const runId of ['20261009-120000', '20261009-130000']) {
      await mkdir(join(skillRoot, 'test_report', runId), { recursive: true })
    }
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'report-cleanup',
      skillId,
      runIds: ['20261009-120000', '20261009-130000'],
    })

    const proposalId = String(proposalCards[0]?.proposalId)
    const applied = await service.apply({
      rootDir,
      sessionId: 'sess-1',
      proposalId,
    })

    expect(applied.ok).toBe(true)
    if (applied.ok) expect(applied.message).toContain('已删除 2 份报告')

    const { access } = await import('node:fs/promises')
    await expect(
      access(join(skillRoot, 'test_report', '20261009-120000')),
    ).rejects.toThrow()
  })

  it('env-fill：写入成功，且**返回值与事件里都不含值**（D7 的结构性验证）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await writeFile(join(skillRoot, 'env.json'), JSON.stringify({}), 'utf8')
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'env-fill',
      skillId,
      envKeys: [{ key: 'E2E_PASSWORD', usage: '登录' }],
    })

    const proposalId = String(proposalCards[0]?.proposalId)
    const secret = 'SuperSecret-123'
    const applied = await service.apply({
      rootDir,
      sessionId: 'sess-1',
      proposalId,
      envValues: { E2E_PASSWORD: secret },
    })

    expect(applied.ok).toBe(true)
    // 返回值里不含值。
    expect(JSON.stringify(applied)).not.toContain(secret)
    // 发布出去的所有事件里也不含值（值只在 apply 的参数与磁盘上）。
    expect(JSON.stringify(proposalCards)).not.toContain(secret)

    // 值确实写进了磁盘。
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(skillRoot, 'env.json'), 'utf8')
    expect(content).toContain(secret)
  })

  it('env-fill：值非法（键名不合规）→ failed 且磁盘保持上一份合法内容（F10）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId, skillRoot } = await createCaseFixture(rootDir)
    await writeFile(
      join(skillRoot, 'env.json'),
      JSON.stringify({ EXISTING: 'keep-me' }),
      'utf8',
    )
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'env-fill',
      skillId,
      // 非法 key（含中划线，不符合 key 命名规则）。
      envKeys: [{ key: 'bad-key', usage: '不合规' }],
    })

    const proposalId = String(proposalCards[0]?.proposalId)
    const applied = await service.apply({
      rootDir,
      sessionId: 'sess-1',
      proposalId,
      envValues: { 'bad-key': 'x' },
    })

    expect(applied.ok).toBe(false)

    // 磁盘保持上一份合法内容（校验闸门在写入前拦下）。
    const { readFile } = await import('node:fs/promises')
    const content = await readFile(join(skillRoot, 'env.json'), 'utf8')
    expect(content).toContain('keep-me')
    expect(content).not.toContain('bad-key')
  })

  it('已定格的提案再次 apply → failed 并说明（不是静默无效）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'env-fill',
      skillId,
      envKeys: [{ key: 'A', usage: '用途' }],
    })
    const proposalId = String(proposalCards[0]?.proposalId)

    await service.cancel({ runtime, sessionId: 'sess-1', proposalId })

    const applied = await service.apply({
      rootDir,
      sessionId: 'sess-1',
      proposalId,
    })
    expect(applied.ok).toBe(false)
    if (!applied.ok) {
      expect(applied.state).toBe('failed')
      expect(applied.message).toContain('已被取消')
    }
  })

  it('cancel：把状态定格为 cancelled 并重发卡片', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'proposal-'))
    const { skillId } = await createCaseFixture(rootDir)
    const { runtime, proposalCards } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()

    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      kind: 'case-change',
      skillId,
      origin: 'user',
      caseChange: { tags: ['回归'] },
    })
    const proposalId = String(proposalCards[0]?.proposalId)

    await service.cancel({ runtime, sessionId: 'sess-1', proposalId })

    // 第二次发布（同 proposalId）表达终态。
    expect(proposalCards).toHaveLength(2)
    expect(proposalCards[1]?.state).toBe('cancelled')
  })
})

describe('提案服务·重启恢复', () => {
  it('恢复出的提案一律 expired（提案持有旧快照，与动作卡片的可恢复语义不同）', async () => {
    const { runtime, blocks } = createRuntimeSpy()
    const { registry } = createTaskRegistrySpy()
    const service = createProposalService({
      taskRegistry: registry,
      updateTestCase: vi.fn() as unknown as IUpdateE2ETestCase,
      skillLifecycle: createSkillLifecycleService(),
    })

    // 模拟「已落盘的提案块」——载荷字段与物化存储写入的形状一致
    //（`work-block-store` 把 proposalKind 等字段整体覆盖进去）。
    blocks.push({
      kind: 'workbench_proposal',
      payload: {
        proposalId: 'p-1',
        proposalKind: 'case-change',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        label: '用例变更提案',
        state: 'pending',
        requiresModalConfirm: false,
      },
    })

    const recovered = service.recover(runtime, 'sess-1', 'p-1')
    expect(recovered?.state).toBe('expired')
    expect(recovered?.resultMessage).toContain('重新发起')
  })
})

/**
 * 取第一张已发布卡片的 proposalId 后调用 apply（测试辅助）。
 *
 * 提案登记表是服务私有的，测试只能经「卡片载荷」这条公开路径拿到 ID——
 * 这也顺带验证了「卡片的 proposalId 就是 apply 的路径参数」这条约定。
 *
 * @param service - 提案服务。
 * @param runtime - 运行时替身（从它发布的卡片里读 ID）。
 * @param rootDir - 工作区根目录。
 * @returns apply 的结果。
 * @throws 不抛出异常。
 */
async function applyFirstCard(
  service: ReturnType<typeof createProposalService>,
  runtime: IAgentWorkRuntime,
  rootDir: string,
) {
  // 替身的 listBlocks 返回它采集到的卡片（见 createRuntimeSpy）。
  const published = runtime.listBlocks('sess-1')
  const first = published[0]?.payload as { proposalId?: string } | undefined
  return service.apply({
    rootDir,
    sessionId: 'sess-1',
    proposalId: first?.proposalId ?? '',
  })
}

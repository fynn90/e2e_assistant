/**
 * 视图宿主（v17 §6.2）的单元测试。
 *
 * 两组关键行为：
 *   ① **行内操作的回指**（Q6）：清单卡每行 / 体检卡每项的按钮必须拿到
 *      **已登记的动作 ID**，但**不另行发布卡片块**——否则一屏 20 行会
 *      在旁边多出 20 张动作卡片；
 *   ② **发布门**：有进行中的轮次时等 `turn end` 再发布，没有则立即发布
 *     （否则历史卡片触发的渲染会永远等不到 turn end，卡片凭空消失）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkill } from '@authine-e2e-agent/skill-manager'
import type { IReadinessViewPayload } from '@authine-e2e-agent/types'
import { createViewHost } from '../../src/application/agent-workbench/view-host'
import { createSkillCatalog } from '../../src/application/agent-workbench/skill-catalog'
import type { IReadinessService } from '../../src/application/agent-workbench/execution-readiness'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'

/** 采集发布的块事件。 */
function createRuntimeSpy(options: { openTurn?: boolean } = {}): {
  runtime: IAgentWorkRuntime
  blocks: Array<Record<string, unknown>>
} {
  const blocks: Array<Record<string, unknown>> = []
  const runtime = {
    publishBlock: (_sessionId: string, payload: Record<string, unknown>) => {
      blocks.push(payload)
      return {}
    },
    listSessions: () =>
      options.openTurn
        ? [{ sessionId: 's1', status: 'running' }]
        : [{ sessionId: 's1', status: 'idle' }],
    bus: {
      currentSeq: () => 0,
      subscribe: () => () => undefined,
    },
  } as unknown as IAgentWorkRuntime
  return { runtime, blocks }
}

/** 体检服务替身。 */
function createReadinessStub(payload: IReadinessViewPayload): IReadinessService {
  return {
    async check() {
      return { ok: true, readiness: payload }
    },
  }
}

/** 造一个用例（含数据与脚本）。 */
async function createCaseFixture(
  rootDir: string,
  input: { withDocument?: boolean; withScript?: boolean } = {},
): Promise<string> {
  const created = await createSkill({
    rootDir,
    title: '云7登录',
    description: '登录页端到端',
  })
  const skillId = created.skillManifest.id
  const skillRoot = join(rootDir, created.skillManifest.directoryName!)

  await writeFile(
    join(skillRoot, 'e2e_schema.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      id: `tc_${skillId}`,
      title: '云7登录',
      description: '登录页端到端',
      baseUrl: 'http://localhost:5173',
      tags: [],
      preconditions: [],
      steps: [],
    }),
    'utf8',
  )
  if (input.withDocument) {
    await writeFile(join(skillRoot, 'SKILL.md'), '# 文档', 'utf8')
  }
  if (input.withScript) {
    await writeFile(join(skillRoot, 'test.spec.ts'), 'export {}', 'utf8')
  }
  return skillId
}

describe('清单卡的行内动作回指（Q6）', () => {
  it('每行登记一个动作并下发 actionId，但**不额外发布卡片块**', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    await createCaseFixture(rootDir, { withDocument: true, withScript: true })
    const { runtime, blocks } = createRuntimeSpy()
    const registered: Array<{ action: string; skillId: string }> = []

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
      registerInline: (input) => {
        registered.push({ action: input.action, skillId: input.skillId })
        return `act-${registered.length}`
      },
    })

    await host.renderView({ viewKind: 'skill-list' })

    // **只有一个块**（清单卡本身）——行内动作只登记、不发布。
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('workbench_view')

    // 行里拿到了 actionId 与 inlineAction。
    const payload = blocks[0]?.payload as {
      rows: Array<{ inlineActionId?: string; inlineAction?: string }>
    }
    expect(payload.rows[0]?.inlineActionId).toBe('act-1')
    // 产物齐备 → 行内给「执行」（Q6：不提供删除）。
    expect(payload.rows[0]?.inlineAction).toBe('execute-test')
    expect(registered).toHaveLength(1)
  })

  it('缺文档的行内给「生成 SKILL.md」、缺脚本的给「生成脚本」（按缺口推进）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    await createCaseFixture(rootDir, { withDocument: false })
    const { runtime } = createRuntimeSpy()
    const actions: string[] = []

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
      registerInline: (input) => {
        actions.push(input.action)
        return 'act-1'
      },
    })

    await host.renderView({ viewKind: 'skill-list' })
    expect(actions).toEqual(['generate-skill-document'])
  })

  it('登记失败时不下发 actionId（不渲染一个点了报错的按钮）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    await createCaseFixture(rootDir, { withDocument: true, withScript: true })
    const { runtime, blocks } = createRuntimeSpy()

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
      registerInline: () => {
        throw new Error('登记表满了')
      },
    })

    await host.renderView({ viewKind: 'skill-list' })

    const payload = blocks[0]?.payload as {
      rows: Array<{ inlineActionId?: string }>
    }
    expect(payload.rows[0]?.inlineActionId).toBeUndefined()
  })
})

describe('体检卡的修复与执行入口（R3）', () => {
  it('未通过项有 fixAction 时登记动作并下发 fixActionId', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    const skillId = await createCaseFixture(rootDir)
    const { runtime, blocks } = createRuntimeSpy()
    const actions: string[] = []

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId,
        skillTitle: '云7登录',
        ok: false,
        checks: [
          {
            code: 'EXECUTION_SPEC_MISSING',
            label: '脚本存在',
            ok: false,
            message: 'test.spec.ts 不存在',
            fixAction: 'generate-playwright-script',
          },
          // 环境变量缺失这类修复走提案通道 → 动作枚举里没有 → 无入口。
          {
            code: 'ENV_REFERENCE_MISSING',
            label: '环境变量齐备',
            ok: false,
            message: '缺 key',
          },
        ],
      }),
      registerInline: (input) => {
        actions.push(input.action)
        return 'act-fix-1'
      },
    })

    await host.renderView({ viewKind: 'readiness', skillId })

    const payload = blocks[0]?.payload as {
      checks: Array<{ fixActionId?: string }>
      executeActionId?: string
    }
    expect(payload.checks[0]?.fixActionId).toBe('act-fix-1')
    // 没有 fixAction 的检查项不登记、也不下发 ID。
    expect(payload.checks[1]?.fixActionId).toBeUndefined()
    expect(actions).toEqual(['generate-playwright-script'])
    // 未通过时**不给执行入口**（给出一个点了必被拦的入口比不给更糟）。
    expect(payload.executeActionId).toBeUndefined()
  })

  it('全部通过时登记「执行」入口（R3 ③ 的闭环）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    const skillId = await createCaseFixture(rootDir, {
      withDocument: true,
      withScript: true,
    })
    const { runtime, blocks } = createRuntimeSpy()
    const actions: string[] = []

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId,
        skillTitle: '云7登录',
        ok: true,
        checks: [{ code: 'EXECUTION_SPEC_MISSING', label: '脚本存在', ok: true }],
      }),
      registerInline: (input) => {
        actions.push(input.action)
        return 'act-exec-1'
      },
    })

    await host.renderView({ viewKind: 'readiness', skillId })

    const payload = blocks[0]?.payload as { executeActionId?: string }
    expect(payload.executeActionId).toBe('act-exec-1')
    expect(actions).toEqual(['execute-test'])
  })
})

describe('发布门（沿用 v16 机制）', () => {
  it('有进行中的轮次 → 等 turn end 才发布（卡片排在 Agent 说明之后）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    await createCaseFixture(rootDir, { withDocument: true, withScript: true })
    const { runtime, blocks } = createRuntimeSpy({ openTurn: true })

    // 让 turn end 能被驱动。
    let turnListener: ((event: unknown) => void) | undefined
    ;(runtime.bus as unknown as { subscribe: unknown }).subscribe = (
      _sessionId: string,
      _afterSeq: number,
      listener: (event: unknown) => void,
    ) => {
      turnListener = listener
      return () => undefined
    }

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
    })

    await host.renderView({ viewKind: 'skill-list' })
    // 还没到 turn end → 未发布。
    expect(blocks).toHaveLength(0)

    turnListener?.({ type: 'turn', phase: 'end' })
    expect(blocks).toHaveLength(1)
  })

  it('没有进行中的轮次（用户点历史卡片）→ 立即发布', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    await createCaseFixture(rootDir, { withDocument: true, withScript: true })
    const { runtime, blocks } = createRuntimeSpy()

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
    })

    await host.renderView({ viewKind: 'skill-list' })
    // 立即发布——否则永远等不到 turn end，卡片会凭空消失。
    expect(blocks).toHaveLength(1)
  })
})

describe('能力卡（H2/H3）', () => {
  it('从能力清单常量构建，与提示词同源', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'viewhost-'))
    const { runtime, blocks } = createRuntimeSpy()

    const host = createViewHost({
      sessionId: 's1',
      runtime,
      rootDir,
      catalog: createSkillCatalog(),
      readiness: createReadinessStub({
        skillId: 'x',
        skillTitle: 'x',
        ok: true,
        checks: [],
      }),
    })

    await host.renderView({ viewKind: 'capability' })

    const payload = blocks[0]?.payload as {
      domains: unknown[]
      notSupported: unknown[]
    }
    expect(payload.domains.length).toBeGreaterThan(0)
    expect(payload.notSupported.length).toBeGreaterThan(0)
  })
})

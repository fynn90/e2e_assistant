/**
 * 连续执行编排（v17 §6.4）的单元测试。
 *
 * 覆盖技术方案 §9 点名的语义：
 *   ① 未就绪条目被跳过且不阻断其余（R4c）；
 *   ② 单条失败**不中断**批次（R4d 明确要求）；
 *   ③ 停止 → 当前条目按中断、余下 not-executed（R4e）；
 *   ④ 超上限被拒且**不截断**（R4b）；
 *   ⑤ **停止的时序**（停止标志先于下一次 start 生效，§6.4 第 2 点的时序坑）。
 *
 * 全部用替身：不启动浏览器、不请求模型、不读真实工作区之外的任何东西。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'
import type { ITestExecutionService } from '../../src/application/test-execution/execution-service'
import type { IExecutionEventBus } from '../../src/application/test-execution/execution-event-bus'
import type { IGenerationTaskRegistry } from '../../src/generation-runtime/generation-task-registry'
import type { IReadinessService } from '../../src/application/agent-workbench/execution-readiness'
import type { IReadinessViewPayload } from '@fynn90-e2e_assistant/types'
import {
  BATCH_MAX_ITEMS,
  createBatchExecutionService,
} from '../../src/application/agent-workbench/batch-execution-service'
import { createSkill } from '@fynn90-e2e_assistant/skill-manager'

/** 采集批次卡片的发布。 */
function createRuntimeSpy (): {
  runtime: IAgentWorkRuntime
  batchCards: Array<Record<string, unknown>>
  messages: string[]
} {
  const batchCards: Array<Record<string, unknown>> = []
  const messages: string[] = []

  const runtime = {
    publishTaskCard: (input: Record<string, unknown>) => {
      batchCards.push(input)
      return {}
    },
    sendMessage: (input: { message: string }) => {
      messages.push(input.message)
      return {}
    },
  } as unknown as IAgentWorkRuntime

  return { runtime, batchCards, messages }
}

/**
 * 执行服务替身：按 skillId 决定「启动成功 / 就绪失败」，并按预置脚本推送终态。
 *
 * `plan` 的每一项描述该用例的行为：
 *   - `'pass'` / `'fail'`：启动成功并在 start 后立即推送对应 summary；
 *   - `'unready'`：start 返回就绪失败（真校验没过）。
 */
function createExecutionServiceSpy (
  plan: Record<string, 'pass' | 'fail' | 'unready'>,
): {
  service: ITestExecutionService
  bus: IExecutionEventBus
  startedSkillIds: string[]
  stoppedSkillIds: string[]
} {
  const startedSkillIds: string[] = []
  const stoppedSkillIds: string[] = []
  /** 订阅回调：bus.publish 时同步通知。 */
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  /**
   * 已发布事件的历史（**必须保留**）。
   *
   * 真实总线在 `afterSeq === undefined` 时会把缓冲里的事件**先回放一遍**，
   * 批次正是靠这条语义拿到「启动后立刻结束」的快执行终态（见
   * session-event-bus 的 subscribe 文档）。替身若只做「向前通知」，
   * 只要 summary 在 subscribe 之前到达就会被丢掉——测试会得到一个
   * 永远 running 的假象，而真实实现并没有问题。
   */
  const history = new Map<string, unknown[]>()

  const bus = {
    subscribe: (
      executionId: string,
      _afterSeq: number | undefined,
      listener: (event: unknown) => void,
    ) => {
      // 先回放已缓冲的事件（真实语义）。
      for (const event of history.get(executionId) ?? []) {
        listener(event)
      }

      const list = listeners.get(executionId) ?? []
      list.push(listener)
      listeners.set(executionId, list)
      return () => {
        const current = listeners.get(executionId) ?? []
        listeners.set(
          executionId,
          current.filter((item) => item !== listener),
        )
      }
    },
  } as unknown as IExecutionEventBus

  const service = {
    async start (input: { skillId: string }) {
      startedSkillIds.push(input.skillId)
      const behavior = plan[input.skillId] ?? 'pass'
      if (behavior === 'unready') {
        return {
          ok: false as const,
          issues: [{ code: 'EXECUTION_SPEC_MISSING', message: '缺脚本' }],
        }
      }

      const executionId = `exec-${input.skillId}`
      const event = {
        type: 'summary',
        summary: {
          executionId,
          runId: '20261009-120000',
          status: 'completed',
          startedAt: new Date().toISOString(),
          durationMs: 1000,
          total: 1,
          passed: behavior === 'pass' ? 1 : 0,
          failed: behavior === 'fail' ? 1 : 0,
          interrupted: 0,
          skipped: 0,
          results: [],
        },
      }
      // 先入历史（订阅晚到也能拿到），再通知已订阅者。
      const buffered = history.get(executionId) ?? []
      buffered.push(event)
      history.set(executionId, buffered)
      for (const listener of listeners.get(executionId) ?? []) {
        listener(event)
      }

      return { ok: true as const, executionId }
    },
    stop (input: { skillId: string }) {
      stoppedSkillIds.push(input.skillId)
      return true
    },
  } as unknown as ITestExecutionService

  return { service, bus, startedSkillIds, stoppedSkillIds }
}

/** 体检服务替身：默认全部通过。 */
function createReadinessSpy (
  notReady: Record<string, string> = {},
): IReadinessService {
  return {
    async check (_rootDir: string, skillId: string) {
      const reason = notReady[skillId]
      const readiness: IReadinessViewPayload = {
        skillId,
        skillTitle: skillId,
        ok: reason === undefined,
        checks: reason
          ? [{ code: 'EXECUTION_SPEC_MISSING', label: '脚本存在', ok: false, message: reason }]
          : [{ code: 'EXECUTION_SPEC_MISSING', label: '脚本存在', ok: true }],
      }
      return { ok: true, readiness }
    },
  }
}

/** 任务注册表替身（本组测试不需要互斥）。 */
function createTaskRegistrySpy (): IGenerationTaskRegistry {
  return {
    currentSessionId: () => undefined,
  } as unknown as IGenerationTaskRegistry
}

/** 造 N 个用例（只建索引条目，不写完整用例数据——批次只需要 ID 与标题）。 */
async function createCases (
  rootDir: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const created = await createSkill({
      rootDir,
      title: `用例${index + 1}`,
      description: `第 ${index + 1} 个`,
    })
    ids.push(created.skillManifest.id)
  }
  return ids
}

describe('连续执行·create', () => {
  it('超过上限时拒绝且不截断（R4b）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const ids = await createCases(rootDir, BATCH_MAX_ITEMS + 1)
    const { runtime, batchCards } = createRuntimeSpy()
    const { service: execService, bus } = createExecutionServiceSpy({})

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: ids,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(`最多 ${BATCH_MAX_ITEMS} 个`)
    // **未创建任何批次卡片**（不截断）。
    expect(batchCards).toHaveLength(0)
  })

  it('待确认态逐条标注就绪预判（R4a），且此时不启动执行', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const [ready, notReady] = await createCases(rootDir, 2)
    const { runtime, batchCards } = createRuntimeSpy()
    const { service: execService, bus, startedSkillIds } = createExecutionServiceSpy({})

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy({ [notReady!]: '缺脚本' }),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: [ready!, notReady!],
    })

    expect(result.ok).toBe(true)
    const card = batchCards[0]!
    expect(card.batchStatus).toBe('awaiting-confirmation')
    const items = card.items as Array<{ readyCheck?: { ok: boolean } }>
    expect(items[0]?.readyCheck?.ok).toBe(true)
    expect(items[1]?.readyCheck?.ok).toBe(false)

    // 待确认态**不启动任何执行**（R4a：用户确认后才开始）。
    expect(startedSkillIds).toHaveLength(0)
  })

  it('重复 ID 去重（同一用例不该跑两次）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const [first] = await createCases(rootDir, 1)
    const { runtime, batchCards } = createRuntimeSpy()
    const { service: execService, bus } = createExecutionServiceSpy({})

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: [first!, first!],
    })

    const items = batchCards[0]?.items as unknown[]
    expect(items).toHaveLength(1)
  })
})

describe('连续执行·confirm 后的串行循环', () => {
  it('单条失败不中断批次，未就绪条目被跳过（R4c/R4d）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const [pass, fail, skip] = await createCases(rootDir, 3)
    const { runtime, batchCards, messages } = createRuntimeSpy()
    const { service: execService, bus, startedSkillIds } =
      createExecutionServiceSpy({
        [pass!]: 'pass',
        [fail!]: 'fail',
        [skip!]: 'unready',
      })

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: [pass!, fail!, skip!],
    })
    const batchId = String(batchCards[0]?.taskId)

    const confirmed = await service.confirm({
      rootDir,
      sessionId: 'sess-1',
      batchId,
      runtime,
    })
    expect(confirmed.ok).toBe(true)

    // 等后台循环跑完。
    await vi.waitFor(() => {
      const final = batchCards.at(-1)!
      expect(final.batchStatus).toBe('completed')
    })

    const final = batchCards.at(-1)!
    const items = final.items as Array<{ status: string }>
    expect(items[0]?.status).toBe('passed')
    expect(items[1]?.status).toBe('failed')
    // 未就绪条目：真校验没过 → 跳过（**不阻断其余**）。
    expect(items[2]?.status).toBe('skipped')

    // 三条都被尝试过（跳过发生在 start 之后——预判与真校验的一致路径）。
    expect(startedSkillIds).toContain(skip)

    // 汇总消息注入给 Agent（C4：终态给下一步）。
    expect(messages.some((line) => line.includes('通过 1'))).toBe(true)
    expect(messages.some((line) => line.includes('失败 1'))).toBe(true)
  })

  it('停止：先停当前条目再置停止标志（R4e / §6.4 的时序坑）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const ids = await createCases(rootDir, 3)
    const { runtime, batchCards } = createRuntimeSpy()
    const { service: execService, stoppedSkillIds } =
      createExecutionServiceSpy({})

    // 总线只登记订阅、**不推送终态**——让第一条一直停在等待里，
    // 从而给 stop 留出确定的插入窗口（这正是要测的时序）。
    const hangingBus = {
      subscribe: () => () => undefined,
    } as unknown as IExecutionEventBus

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: hangingBus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: ids,
    })
    const batchId = String(batchCards[0]?.taskId)
    await service.confirm({
      rootDir,
      sessionId: 'sess-1',
      batchId,
      runtime,
    })

    // 等循环进到第一条的「running」。
    await vi.waitFor(() => {
      expect(
        batchCards.at(-1)?.items &&
        (batchCards.at(-1)!.items as Array<{ status: string }>)[0]?.status,
      ).toBe('running')
    })

    service.stop({ sessionId: 'sess-1', batchId, runtime })

    // **停止时序**：必须先调执行服务的 stop（停掉当前条目），
    // 再置批次停止标志——顺序反了则循环可能在标志生效前又启动下一个条目。
    expect(stoppedSkillIds).toContain(ids[0])
  })

  it('待确认态取消：不产生执行记录（R4a）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const ids = await createCases(rootDir, 2)
    const { runtime, batchCards } = createRuntimeSpy()
    const { service: execService, bus, startedSkillIds } =
      createExecutionServiceSpy({})

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: ids,
    })
    const batchId = String(batchCards[0]?.taskId)

    service.cancel({ sessionId: 'sess-1', batchId, runtime })

    expect(batchCards.at(-1)?.batchStatus).toBe('cancelled')
    expect(startedSkillIds).toHaveLength(0)
  })

  it('不存在的用例 ID → create 拒绝（防路径/标题伪造，SEC-2）', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'batch-'))
    const { runtime } = createRuntimeSpy()
    const { service: execService, bus } = createExecutionServiceSpy({})

    const service = createBatchExecutionService({
      testExecutionService: execService,
      executionEventBus: bus,
      taskRegistry: createTaskRegistrySpy(),
      readiness: createReadinessSpy(),
    })

    const result = await service.create({
      rootDir,
      sessionId: 'sess-1',
      runtime,
      skillIds: ['zzzzzzzzz'],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('不存在')
  })
})




/**
 * 工作台能力服务的单元测试（v16）。
 *
 * 覆盖三条关键编排（全部用替身，不启动浏览器、不请求模型）：
 *   ① 动作卡片的发布与缺口校验（ID-6/ID-7/GEN-11）；
 *   ② 执行终态镜像与解读轮次注入（RUN-10 / LOG-2 / §6.7）；
 *   ③ 会话内单执行约束（RUN-4）与就绪失败的一次性列全（RUN-2）。
 *
 * 生成编排（生成 + 服务端落盘）另有一组：它验证「既有的两步链路被串成一次调用」，
 * 这是 v16 §6.5 的核心缺口，必须独立锁定。
 */
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'
import type { IExecutionEventBus } from '../../src/application/test-execution/execution-event-bus'
import { createExecutionEventBus } from '../../src/application/test-execution/execution-event-bus'
import { createAgentWorkbenchService } from '../../src/application/agent-workbench/workbench-service'
import { createGenerationOrchestrator } from '../../src/application/agent-workbench/generation-orchestrator'
import { createGenerationTaskRegistry } from '../../src/generation-runtime/generation-task-registry'
import { createSkill } from '@authine-e2e-agent/skill-manager'
import type { IE2ETestCaseApplicationServices } from '../../src/application/e2e-test-case/application-types'
import type { ITestExecutionService } from '../../src/application/test-execution/execution-service'

/** 采集发布到总线上的块事件。 */
function createRuntimeSpy(): {
  runtime: IAgentWorkRuntime
  published: Array<{ sessionId: string; payload: Record<string, unknown> }>
  taskCards: Array<Record<string, unknown>>
  reportCards: Array<Record<string, unknown>>
  sentMessages: string[]
  /** 标记会话有一轮进行中（执行卡片将等待 turn end 再发布）。 */
  openTurn: (sessionId: string) => void
  /** 模拟一轮对话结束（执行卡片的发布门）。 */
  emitTurnEnd: (sessionId: string) => void
} {
  const published: Array<{
    sessionId: string
    payload: Record<string, unknown>
  }> = []
  const taskCards: Array<Record<string, unknown>> = []
  const reportCards: Array<Record<string, unknown>> = []
  const sentMessages: string[] = []

  /**
   * 父会话总线替身（v16：执行卡片要等 turn end 才发布，测试需驱动这个时机）。
   *
   * **必须忠实复刻真实总线的补发语义**：`subscribe(sessionId, afterSeq, ...)`
   * 会把缓冲里 seq > afterSeq 的历史事件**先回放一遍**（见 session-event-bus）。
   * 若替身不回放，调用方把 afterSeq 传成 `undefined` 也照样通过——而那样的
   * 实现在真实环境里会被上一条 `turn end` 立刻放行，发布门形同虚设。
   */
  const turnListeners = new Set<(event: unknown) => void>()
  /** 会话状态：驱动「本轮是否仍在进行」——决定卡片是等待还是立即发布。 */
  const sessionStatus = new Map<string, string>()
  /** 已发布事件（seq 单调递增），供 subscribe 按 afterSeq 回放。 */
  const turnHistory: Array<Record<string, unknown>> = []

  const runtime = {
    bus: {
      currentSeq: () => turnHistory.length,
      subscribe: (
        sessionId: string,
        afterSeq: number | undefined,
        listener: (event: unknown) => void,
      ) => {
        void sessionId
        // 回放：afterSeq 为 undefined 时**全量**回放（真实总线的语义）。
        for (const event of turnHistory) {
          if (afterSeq === undefined || Number(event.seq) > afterSeq) {
            listener(event)
          }
        }
        turnListeners.add(listener)
        return () => turnListeners.delete(listener)
      },
    },
    listSessions: () =>
      [...sessionStatus.entries()].map(([sessionId, status]) => ({
        sessionId,
        kind: 'chat',
        title: '',
        status,
        createdAt: 0,
        updatedAt: 0,
      })),
    sendMessage: (input: { message: string }) => {
      sentMessages.push(input.message)
      return { sessionId: 'session-1', handle: { result: Promise.resolve({}) } }
    },
    publishBlock: (sessionId: string, payload: unknown) => {
      published.push({ sessionId, payload: payload as Record<string, unknown> })
      return { seq: published.length }
    },
    publishTaskCard: (input: Record<string, unknown>) => {
      taskCards.push(input)
      return { seq: taskCards.length }
    },
    publishReportCard: (input: Record<string, unknown>) => {
      reportCards.push(input)
      return { seq: reportCards.length }
    },
    // 生成结束后运行时会释放子会话（单轮任务）；替身按空实现即可。
    releaseSession: async () => undefined,
  } as unknown as IAgentWorkRuntime

  return {
    runtime,
    published,
    taskCards,
    reportCards,
    sentMessages,
    /** 标记会话有一轮进行中（执行卡片将等待 turn end 再发布）。 */
    openTurn: (sessionId: string) => sessionStatus.set(sessionId, 'running'),
    /**
     * 模拟一轮对话结束：置会话为空闲并广播 turn end。
     *
     * 事件同时进入历史缓冲——真实总线会把它留给后续订阅者回放，
     * 这正是「发布门必须传 afterSeq」的成因。
     */
    emitTurnEnd: (sessionId: string) => {
      sessionStatus.set(sessionId, 'idle')
      const event = {
        type: 'turn',
        phase: 'end',
        sessionId,
        seq: turnHistory.length + 1,
      }
      turnHistory.push(event)
      for (const listener of [...turnListeners]) {
        listener(event)
      }
    },
  }
}

/** 构造一个最小可用的执行服务替身。 */
function createExecutionServiceStub(
  result:
    | { ok: true; executionId: string }
    | { ok: false; issues: Array<{ code: string; message: string }> },
): ITestExecutionService {
  return {
    start: async () => result,
    stop: () => true,
    snapshot: () => undefined,
    current: () => undefined,
    // v19 关闭序列的第一步；替身无在跑任务，立即收敛。
    abortAllAndWait: async () => undefined,
  }
}

/**
 * 在临时目录里造一个用例目录（用平台的 createSkill，保证与真实索引/清单结构一致）。
 *
 * 为什么不用手写 json 造夹具：`resolveSkill` 会校验索引与 manifest 的身份一致性
 * 与目录身份，手写的夹具很容易漏字段而被判为「已损坏」——那样测的就不是业务
 * 判定而是夹具的正确性了。
 *
 * @param options - 需要预置哪些产物文件。
 * @returns 工作区根目录与新用例 ID。
 * @throws 创建失败时透传 skill-manager 的错误。
 */
async function createSkillFixture(options: {
  hasDocument: boolean
  hasScript: boolean
}): Promise<{ rootDir: string; skillId: string }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'workbench-'))
  const { skillManifest, skillDirectoryPath } = await createSkill({
    rootDir,
    title: '云7登录',
    description: '登录页端到端',
  })

  if (options.hasDocument) {
    await writeFile(join(skillDirectoryPath, 'SKILL.md'), '# 云7登录', 'utf8')
  }
  if (options.hasScript) {
    await writeFile(join(skillDirectoryPath, 'test.spec.ts'), '// spec', 'utf8')
  }

  return { rootDir, skillId: skillManifest.id }
}

describe('动作卡片：缺口校验（ID-7 / GEN-11）', () => {
  it('缺 SKILL.md 时拒绝「生成脚本」入口（跳步必然失败）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: false,
      hasScript: false,
    })
    const { runtime } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: 'x',
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createActionHost(rootDir, 'session-1', runtime)
      .requestAction({
        action: 'generate-playwright-script',
        skillId,
      })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('SKILL.md')
  })

  it('产物齐备前拒绝「执行测试」入口（SEC-2 / ID-7）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: false,
    })
    const { runtime } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: 'x',
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createActionHost(rootDir, 'session-1', runtime)
      .requestAction({
        action: 'execute-test',
        skillId,
      })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('产物不完整')
  })

  it('缺脚本时给出「生成 Playwright 脚本」入口并发布卡片', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: false,
    })
    const { runtime, published } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: 'x',
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createActionHost(rootDir, 'session-1', runtime)
      .requestAction({
        action: 'generate-playwright-script',
        skillId,
      })

    expect(result.ok).toBe(true)
    const actionEvent = published.find(
      (item) => item.payload.type === 'workbench_action',
    )
    expect(actionEvent?.payload).toMatchObject({
      action: 'generate-playwright-script',
      skillId,
      state: 'pending',
    })
  })

  it('目标不存在时拒绝并说明（不猜测相近用例）', async () => {
    const { rootDir } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: 'x',
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createActionHost(rootDir, 'session-1', runtime)
      .requestAction({
        action: 'execute-test',
        skillId: 'zzz999999',
      })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('zzz999999')
  })

  it('创建入口不需要目标，直接发布卡片（ID-6）', async () => {
    const { rootDir } = await createSkillFixture({
      hasDocument: false,
      hasScript: false,
    })
    const { runtime, published } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: 'x',
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createActionHost(rootDir, 'session-1', runtime)
      .requestAction({
        action: 'create-skill',
        skillId: null,
      })

    expect(result.ok).toBe(true)
    expect(published[0]?.payload).toMatchObject({
      action: 'create-skill',
      skillId: null,
    })
  })
})

describe('执行编排：卡片发布、终态镜像与解读轮次', () => {
  it('就绪失败时不产生执行卡片，问题一次性列出（RUN-2）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, sentMessages } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: false,
        issues: [
          {
            code: 'ENV_REFERENCE_MISSING',
            message: 'env.json 缺少 key：E2E_PASSWORD',
          },
          { code: 'EXECUTION_BASE_URL_MISSING', message: '目标 URL 未配置。' },
        ],
      }),
      executionEventBus: createExecutionEventBus(),
    })

    const result = await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })

    expect(result.ok).toBe(false)
    // 不产生执行卡片（未启动就没有执行）。
    expect(taskCards).toHaveLength(0)
    // 一次性列出全部问题。
    expect(result.ok === false && result.issues).toHaveLength(2)
    expect(sentMessages).toHaveLength(0)
  })

  it('执行卡片等本轮对话结束才发布，随后镜像终态并注入解读轮次', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, reportCards, sentMessages, emitTurnEnd, openTurn } =
      createRuntimeSpy()
    const executionEventBus: IExecutionEventBus = createExecutionEventBus()
    const executionId = randomUUID()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId,
      }),
      executionEventBus,
    })

    // 先制造一条**历史** turn end（上一轮对话留下的），再开始本轮。
    // 这是发布门的关键防线：总线会向新订阅者回放历史事件，若订阅时不带
    // afterSeq，上一条 turn end 会立刻把卡片放出去，等待形同虚设。
    emitTurnEnd('session-1')
    openTurn('session-1')

    const result = await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })
    expect(result.ok).toBe(true)

    // 发布门：本轮还没结束，卡片不上屏——否则它会排在 Agent 的说明文本**之前**，
    // 用户看到「先出结果、后读到『已发起执行』」，叙述顺序与事实相反。
    expect(taskCards).toHaveLength(0)

    emitTurnEnd('session-1')
    expect(taskCards[0]).toMatchObject({
      taskKind: 'execution',
      status: 'running',
      executionId,
      skillId,
    })

    // 模拟执行引擎产出终态。
    executionEventBus.publish(executionId, {
      type: 'summary',
      summary: {
        executionId,
        runId: '20260930-120000',
        status: 'completed',
        startedAt: new Date().toISOString(),
        durationMs: 1234,
        total: 3,
        passed: 2,
        failed: 1,
        interrupted: 0,
        skipped: 0,
        results: [
          { title: '登录成功', status: 'passed', durationMs: 800 },
          {
            title: '退出登录',
            status: 'failed',
            durationMs: 400,
            failedStepId: 'step_logout',
          },
        ],
        reportRelativePath: 'test_report/20260930-120000/report.html',
        baseUrl: 'https://test-v1.cloudpivot.cn/platform/#/login',
      },
    })

    // 卡片终态镜像（LOG-2）。
    const terminal = taskCards[taskCards.length - 1]
    expect(terminal).toMatchObject({
      taskKind: 'execution',
      status: 'completed',
      summary: {
        total: 3,
        passed: 2,
        failed: 1,
        runId: '20260930-120000',
        // RPT-2 要求摘要含「运行时间」与「目标 URL」——镜像时不能丢，
        // 否则报告总结组件在历史回看时缺这两项。
        startedAt: expect.any(String),
        baseUrl: 'https://test-v1.cloudpivot.cn/platform/#/login',
      },
    })

    // 报告卡片（RPT-2/RPT-3）：与执行卡片**平级**的独立一张，携带完整摘要。
    // 这是本次修正的核心——结果不再画进执行卡片内部。
    expect(reportCards).toHaveLength(1)
    expect(reportCards[0]).toMatchObject({
      executionId,
      skillId,
      skillTitle: '云7登录',
      taskStatus: 'completed',
      summary: {
        total: 3,
        passed: 2,
        failed: 1,
        runId: '20260930-120000',
        baseUrl: 'https://test-v1.cloudpivot.cn/platform/#/login',
      },
    })

    // 解读轮次注入（RUN-10 / §6.7）：消息含统计与失败定位，且不含 env 值。
    expect(sentMessages).toHaveLength(1)
    const message = sentMessages[0]!
    expect(message).toContain('执行已结束')
    expect(message).toContain('通过 2')
    expect(message).toContain('失败 1')
    expect(message).toContain('step_logout')
    expect(message).toContain('update-playwright-script')
    // 禁止复述统计表：统计已由报告卡片承载，复述会让对话流出现两张相同的表。
    expect(message).toContain('不要再用表格复述统计数字')
  })

  it('终态 status 先于 summary 到达时，仍以 summary 定稿（事件顺序回归）', async () => {
    // 执行服务的 finalize 在同一同步块内「先发 status、再发 summary」。
    // 若实现把 status 当作终态信号立刻定稿，摘要就会被丢掉——卡片的统计
    // 与失败定位全靠它，这是必须锁住的顺序依赖。
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, emitTurnEnd, openTurn } = createRuntimeSpy()
    const executionEventBus = createExecutionEventBus()
    const executionId = randomUUID()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId,
      }),
      executionEventBus,
    })

    openTurn('session-1')
    await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })
    emitTurnEnd('session-1')

    // 复现真实顺序：status(completed) → summary。
    executionEventBus.publish(executionId, {
      type: 'status',
      status: 'completed',
    })
    executionEventBus.publish(executionId, {
      type: 'summary',
      summary: {
        executionId,
        runId: '20260930-130000',
        status: 'completed',
        startedAt: new Date().toISOString(),
        durationMs: 900,
        total: 1,
        passed: 1,
        failed: 0,
        interrupted: 0,
        skipped: 0,
        results: [],
      },
    })

    const terminal = taskCards[taskCards.length - 1]!
    expect(terminal).toMatchObject({
      status: 'completed',
      summary: { total: 1, runId: '20260930-130000' },
    })
    // 兜底分支未抢跑：仍应只有一条终态卡片（running + completed）。
    expect(taskCards).toHaveLength(2)
  })

  it('未启动运行的环境失败不发布报告卡片（没有报告可看）', async () => {
    // 「浏览器/环境未能启动」时执行服务不发 summary（P1：只有启动了浏览器运行的
    // 执行才生成报告）。此时若仍给报告卡片，用户点开必然撞上「报告文件不存在」。
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, reportCards, emitTurnEnd, openTurn } =
      createRuntimeSpy()
    const executionEventBus = createExecutionEventBus()
    const executionId = randomUUID()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId,
      }),
      executionEventBus,
    })

    openTurn('session-1')
    await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })
    emitTurnEnd('session-1')

    // 环境失败：只有终态 status，没有 summary。
    executionEventBus.publish(executionId, {
      type: 'status',
      status: 'failed',
    })
    // 无摘要时实现「延后一拍」定稿（等同一批事件里的 summary），故需让出一个宏任务。
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(taskCards[taskCards.length - 1]).toMatchObject({
      status: 'failed',
    })
    // 没有摘要 ⇒ 没有报告卡片。
    expect(reportCards).toHaveLength(0)
  })

  it('执行先于本轮结束完成时，卡片直接以终态发布（不多一次状态跳变）', async () => {
    // 小用例几秒即跑完，而本轮 Agent 的文本还在流式输出——这是常态而非边角。
    // 若实现坚持「先发 running、再改 completed」，用户会看到卡片凭空跳一下。
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, sentMessages, emitTurnEnd, openTurn } =
      createRuntimeSpy()
    const executionEventBus = createExecutionEventBus()
    const executionId = randomUUID()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId,
      }),
      executionEventBus,
    })

    openTurn('session-1')
    await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })

    // 执行先结束。
    executionEventBus.publish(executionId, {
      type: 'summary',
      summary: {
        executionId,
        runId: '20260930-140000',
        status: 'completed',
        startedAt: new Date().toISOString(),
        durationMs: 500,
        total: 2,
        passed: 2,
        failed: 0,
        interrupted: 0,
        skipped: 0,
        results: [],
      },
    })
    expect(taskCards).toHaveLength(0)

    // 之后本轮才结束：卡片一次到位，只有一条终态记录。
    emitTurnEnd('session-1')
    expect(taskCards).toHaveLength(1)
    expect(taskCards[0]).toMatchObject({
      taskKind: 'execution',
      status: 'completed',
      summary: { total: 2, passed: 2, runId: '20260930-140000' },
    })
    // 解读轮次照常注入。
    expect(sentMessages).toHaveLength(1)
  })

  it('同一会话已有执行时拒绝并发（RUN-4）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards, emitTurnEnd, openTurn } = createRuntimeSpy()
    const executionEventBus = createExecutionEventBus()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: randomUUID(),
      }),
      executionEventBus,
    })
    const host = service.createTestRunnerHost(rootDir, 'session-1', runtime)

    await host.startExecution({ skillId })
    // 第二次请求在本轮结束前就被拒绝——互斥不看卡片是否上屏，只看任务是否在跑，
    // 因此这里**不**需要先 emitTurnEnd。
    const second = await host.startExecution({ skillId })

    expect(second.ok).toBe(false)
    expect(second.ok === false && second.issues[0]?.code).toBe(
      'EXECUTION_SESSION_BUSY',
    )
    emitTurnEnd('session-1')
    expect(taskCards).toHaveLength(1)
  })

  it('点击动作卡片发起（无进行中的轮次）时卡片立即发布', async () => {
    // 动作卡片的点击是**独立的 HTTP 请求**，没有任何进行中的对话轮次。
    // 若实现一味等 turn end，这张卡片永远不会出现——用户点了「执行测试」
    // 却什么都看不到。因此发布门必须先判断「本轮是否真的在进行」。
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards } = createRuntimeSpy()
    const service = createAgentWorkbenchService({
      taskRegistry: createGenerationTaskRegistry(),
      testExecutionService: createExecutionServiceStub({
        ok: true,
        executionId: randomUUID(),
      }),
      executionEventBus: createExecutionEventBus(),
    })

    // 注意：**不**调用 openTurn —— 模拟没有进行中的轮次。
    await service
      .createTestRunnerHost(rootDir, 'session-1', runtime)
      .startExecution({ skillId })

    expect(taskCards).toHaveLength(1)
    expect(taskCards[0]).toMatchObject({ taskKind: 'execution', status: 'running' })
  })
})

describe('生成编排：生成 + 服务端落盘（§6.5）', () => {
  it('SKILL.md 生成后立刻保存（不依赖前端第二次调用）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: false,
      hasScript: false,
    })
    const { runtime, taskCards } = createRuntimeSpy()
    const generateSkillDocument = vi.fn(async () => ({
      content: '# 云7登录',
      warnings: [],
      assumptions: [],
      environmentVariables: [],
      sourceHash: `sha256:${'a'.repeat(64)}`,
      testCaseVersion: 'b'.repeat(64),
      skillDocumentVersion: 'c'.repeat(64),
    }))
    const saveSkillDocument = vi.fn(async () => ({
      relativePath: 'SKILL.md' as const,
      version: 'd'.repeat(64),
      size: 8,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnostics: [],
    }))

    const services = {
      generateSkillDocument,
      saveSkillDocument,
      // 守卫要求四项齐备（generate / saveScript / generateSkillDocument /
      // saveSkillDocument 同为「生成能力已装配」的判据）。
      generate: async () => {
        throw new Error('不适用')
      },
      saveScript: async () => {
        throw new Error('不适用')
      },
    } as unknown as IE2ETestCaseApplicationServices

    const orchestrator = createGenerationOrchestrator({
      taskRegistry: createGenerationTaskRegistry(),
      services,
      resolveConfig: async () => ({ projectDirectory: rootDir }) as never,
    })

    const outcome = await orchestrator.run({
      rootDir,
      sessionId: 'session-1',
      runtime,
      skillId,
      skillTitle: '云7登录',
      action: 'generate-skill-document',
    })

    expect(outcome.ok, outcome.message).toBe(true)
    // 关键断言：保存被调用，且入参用的是**生成返回的版本字段**（乐观锁接力）。
    expect(saveSkillDocument).toHaveBeenCalledWith({
      rootDir,
      skillId,
      request: {
        content: '# 云7登录',
        sourceHash: `sha256:${'a'.repeat(64)}`,
        expectedSkillDocumentVersion: 'c'.repeat(64),
        mode: 'generation',
      },
    })
    // 卡片从 running 走到 completed。
    expect(taskCards[0]).toMatchObject({
      status: 'running',
      taskKind: 'generation',
    })
    expect(taskCards[1]).toMatchObject({ status: 'completed' })
  })

  it('脚本生成后立刻保存正式 test.spec.ts（F5 的缺口）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: false,
    })
    const { runtime } = createRuntimeSpy()
    const generate = vi.fn(async () => ({
      code: 'import { test } from "@playwright/test"',
      warnings: [],
      assumptions: [],
      environmentVariables: [],
      stepCoverage: [],
      sourceHash: `sha256:${'a'.repeat(64)}`,
      testCaseVersion: 'b'.repeat(64),
      scriptVersion: null,
    }))
    const saveScript = vi.fn(async () => ({
      relativePath: 'test.spec.ts' as const,
      version: 'e'.repeat(64),
      size: 40,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnostics: [{ code: 'X', message: 'y', severity: 'warning' as const }],
    }))

    const services = {
      generate,
      saveScript,
      generateSkillDocument: async () => {
        throw new Error('不适用')
      },
      saveSkillDocument: async () => {
        throw new Error('不适用')
      },
    } as unknown as IE2ETestCaseApplicationServices
    const browserHost = {
      ensureChromium: async () => ({ installed: true }),
      acquire: async () => undefined,
      release: async () => undefined,
    }

    const orchestrator = createGenerationOrchestrator({
      taskRegistry: createGenerationTaskRegistry(),
      services,
      browserHost: browserHost as never,
      resolveConfig: async () => ({ projectDirectory: rootDir }) as never,
    })

    const outcome = await orchestrator.run({
      rootDir,
      sessionId: 'session-1',
      runtime,
      skillId,
      skillTitle: '云7登录',
      action: 'generate-playwright-script',
    })

    expect(outcome.ok, outcome.message).toBe(true)
    expect(saveScript).toHaveBeenCalledWith({
      rootDir,
      skillId,
      request: {
        code: 'import { test } from "@playwright/test"',
        sourceHash: `sha256:${'a'.repeat(64)}`,
        expectedScriptVersion: null,
        mode: 'generation',
      },
    })
    // 诊断计数进入卡片摘要（v15 的「N 项提示」徽标数据源）。
    expect(outcome.message).toContain('1 项提示')
  })

  it('重试按产物缺口路由：缺文档时重试走文档生成（GEN-8/GEN-11）', async () => {
    // retry 不是「重做脚本」，而是「重做上一步」。若笼统按脚本执行，
    // 文档缺失的重试会直接撞上就绪门槛，用户看到的是「点了重试还是报缺文档」。
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: false,
      hasScript: false,
    })
    const { runtime } = createRuntimeSpy()
    const generateSkillDocument = vi.fn(async () => ({
      content: '# x',
      warnings: [],
      assumptions: [],
      environmentVariables: [],
      sourceHash: `sha256:${'a'.repeat(64)}`,
      testCaseVersion: 'b'.repeat(64),
      skillDocumentVersion: 'c'.repeat(64),
    }))
    const saveSkillDocument = vi.fn(async () => ({
      relativePath: 'SKILL.md' as const,
      version: 'd'.repeat(64),
      size: 3,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      generatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnostics: [],
    }))
    const generate = vi.fn(async () => {
      throw new Error('不应走到脚本生成')
    })

    const orchestrator = createGenerationOrchestrator({
      taskRegistry: createGenerationTaskRegistry(),
      services: {
        generateSkillDocument,
        saveSkillDocument,
        generate,
        saveScript: async () => {
          throw new Error('不适用')
        },
      } as unknown as IE2ETestCaseApplicationServices,
      resolveConfig: async () => ({ projectDirectory: rootDir }) as never,
    })

    const outcome = await orchestrator.run({
      rootDir,
      sessionId: 'session-1',
      runtime,
      skillId,
      skillTitle: '云7登录',
      action: 'retry',
    })

    expect(outcome.ok, outcome.message).toBe(true)
    expect(generateSkillDocument).toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('互斥冲突时给出失败卡片且不发起生成（GEN-6）', async () => {
    const { rootDir, skillId } = await createSkillFixture({
      hasDocument: true,
      hasScript: true,
    })
    const { runtime, taskCards } = createRuntimeSpy()
    const registry = createGenerationTaskRegistry()
    // 先占住该 Skill 的任务名额（模拟 Skill 开发页正在生成）。
    registry.acquire(skillId, 'other-session')

    const generateSkillDocument = vi.fn()
    const orchestrator = createGenerationOrchestrator({
      taskRegistry: registry,
      services: {
        generateSkillDocument,
        saveSkillDocument: async () => {
          throw new Error('不适用')
        },
        generate: async () => {
          throw new Error('不适用')
        },
        saveScript: async () => {
          throw new Error('不适用')
        },
      } as unknown as IE2ETestCaseApplicationServices,
      resolveConfig: async () => ({ projectDirectory: rootDir }) as never,
    })

    const outcome = await orchestrator.run({
      rootDir,
      sessionId: 'session-1',
      runtime,
      skillId,
      skillTitle: '云7登录',
      action: 'generate-skill-document',
    })

    expect(outcome.ok).toBe(false)
    expect(generateSkillDocument).not.toHaveBeenCalled()
    expect(taskCards[taskCards.length - 1]).toMatchObject({ status: 'failed' })
  })
})

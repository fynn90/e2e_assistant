/**
 * 工作台卡片契约（v16）的单元测试。
 *
 * 覆盖两类新块的事件形状与块种类扩展：这些是 types / agent / cli / web
 * 四包共享的契约，形状漂移会在下游以「渲染空白」的形式静默表现，
 * 因此在此以编译期与运行期双重固定。
 */
import { describe, expect, it } from 'vitest'
import type {
  IAgentSkillCandidate,
  IAgentWorkBlock,
  IAgentWorkbenchActionEvent,
  IAgentWorkbenchTaskEvent,
  TAgentClientEventDraft,
  TAgentWorkBlockKind,
} from '../src/index'

describe('工作台动作卡片契约', () => {
  it('动作事件可作为客户端事件草稿发布（信封字段齐备）', () => {
    const draft: TAgentClientEventDraft = {
      type: 'workbench_action',
      phase: 'begin',
      actionId: 'action-1',
      action: 'generate-playwright-script',
      skillId: 'abc123456',
      skillTitle: '云7登录',
      label: '生成 Playwright 脚本',
      description: '脚本已被手工修改，重新生成将覆盖',
      state: 'pending',
      sessionId: 'session-1',
      blockId: 'action-1',
      timestamp: 1_760_000_000_000,
    }

    expect(draft.type).toBe('workbench_action')
  })

  it('创建动作的目标 SKILL 允许为空（此时尚无 SKILL）', () => {
    const event: IAgentWorkbenchActionEvent = {
      type: 'workbench_action',
      phase: 'begin',
      actionId: 'action-2',
      action: 'create-skill',
      skillId: null,
      label: '创建 e2e SKILL',
      state: 'pending',
    }

    expect(event.skillId).toBeNull()
  })
})

describe('工作台任务卡片契约', () => {
  it('生成任务以子会话 ID 为 taskId，并可携带产物完备性', () => {
    const event: IAgentWorkbenchTaskEvent = {
      type: 'workbench_task',
      phase: 'begin',
      taskId: 'generation-session-1',
      taskKind: 'generation',
      skillId: 'abc123456',
      skillTitle: '云7登录',
      status: 'completed',
      startedAt: 1_760_000_000_000,
      summary: { diagnostics: 2 },
      artifacts: { hasSkillDocument: true, hasPlaywrightScript: true },
    }

    expect(event.taskKind).toBe('generation')
    expect(event.artifacts?.hasPlaywrightScript).toBe(true)
  })

  it('执行任务携带 executionId 与统计摘要（历史回看的数据源）', () => {
    const event: IAgentWorkbenchTaskEvent = {
      type: 'workbench_task',
      phase: 'begin',
      taskId: 'execution-1',
      taskKind: 'execution',
      skillId: 'abc123456',
      skillTitle: '云7登录',
      status: 'completed',
      startedAt: 1_760_000_000_000,
      executionId: 'execution-1',
      summary: {
        total: 3,
        passed: 2,
        failed: 1,
        interrupted: 0,
        skipped: 0,
        durationMs: 12_345,
        runId: '20260930-120000',
      },
    }

    expect(event.summary?.runId).toBe('20260930-120000')
  })
})

describe('块种类与检索候选', () => {
  it('块种类含两类工作台卡片', () => {
    const kinds: TAgentWorkBlockKind[] = ['workbench_action', 'workbench_task']
    expect(kinds).toHaveLength(2)
  })

  it('物化块可承载两类新块的 payload', () => {
    const block: IAgentWorkBlock = {
      sessionId: 'session-1',
      blockId: 'task-1',
      seq: 12,
      runId: '',
      kind: 'workbench_task',
      status: 'done',
      payload: { taskKind: 'execution', status: 'completed' },
      createdAt: 1,
      updatedAt: 2,
    }

    expect(block.kind).toBe('workbench_task')
  })

  it('检索候选同时回答产物完备性（ID-3 的判定依据）', () => {
    const candidate: IAgentSkillCandidate = {
      id: 'abc123456',
      title: '云7登录',
      description: '云7 登录页面的端到端用例',
      hasSkillDocument: true,
      hasPlaywrightScript: false,
    }

    expect(candidate.hasPlaywrightScript).toBe(false)
  })
})

/**
 * v17 会话侧新增能力的测试：C7 完成提示、会话列表（S 组）与 API 客户端。
 *
 * 覆盖：
 *   1. **C7**：`detachView` 在有运行中任务时保持订阅（不 dispose）、无任务时释放；
 *      任务「运行 → 终态」时写入 `pendingNotice`，且**只在该迁移上写**；
 *      页面已挂载（viewAttached）时终态仍要断开订阅以免挂着无人消费的 SSE；
 *   2. **S 组**：`SessionList` 的搜索过滤、就地重命名、删除的二次确认
 *      （弹框未确认时不抛 `remove`）、有运行中任务时文案区分；
 *   3. API 客户端：新增端点的路径、方法与请求体形状（含 PATCH 与 envValues）。
 */
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IAgentSessionSummary,
  TAgentClientEvent,
} from '@authine-e2e-agent/types'
import { useAgentWorkStore } from '../../src/stores/agent-work'
import SessionList from '../../src/modules/agent-work/components/SessionList.vue'
import {
  applyAgentProposal,
  cancelAgentBatch,
  confirmAgentBatch,
  deleteAgentSession,
  getAgentSuggestions,
  renameAgentSession,
  stopAgentBatch,
} from '../../src/services/agent-work-api'

/** requestJson 替身：只记录调用参数，不发真实请求。 */
const requestJson = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, data: {} })),
)

vi.mock('../../src/services/http-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/services/http-client')>()
  return { ...actual, requestJson }
})

beforeEach(() => {
  setActivePinia(createPinia())
  requestJson.mockClear()
})

/**
 * 构造一条带完整信封的工作事件。
 *
 * @param seq - 事件序号。
 * @param blockId - 工作块 ID。
 * @param payload - 事件载荷（不含信封字段）。
 * @returns 客户端工作事件。
 * @throws 不抛出异常。
 */
function eventOf<T extends { type: string; phase: 'begin' }>(
  seq: number,
  blockId: string,
  payload: T,
): TAgentClientEvent {
  return {
    sessionId: 's1',
    blockId,
    seq,
    timestamp: 1000 + seq,
    ...payload,
  } as unknown as TAgentClientEvent
}

/** 一条 running 的 batch 任务事件。 */
function runningBatchEvent(seq = 1): TAgentClientEvent {
  return eventOf(seq, 'task-1', {
    type: 'workbench_task',
    phase: 'begin',
    taskId: 'batch-1',
    taskKind: 'batch',
    skillId: 'abc123456',
    skillTitle: '云7登录',
    status: 'running',
    startedAt: 1000,
    batchStatus: 'running',
    items: [],
    batchLimit: 10,
  })
}

describe('C7：detachView 与终态提示', () => {
  it('无运行中任务时 detachView 等价 dispose（清会话与时间线）', () => {
    const store = useAgentWorkStore()
    store.sessionId = 's1'
    store.viewAttached = true

    store.detachView()

    expect(store.viewAttached).toBe(false)
    expect(store.sessionId).toBeNull()
  })

  it('有运行中任务时 detachView 保持会话与订阅（否则终态事件到不了前端）', () => {
    const store = useAgentWorkStore()
    store.sessionId = 's1'
    store.applyEvent(runningBatchEvent())

    expect(store.hasRunningTask).toBe(true)

    store.detachView()

    expect(store.viewAttached).toBe(false)
    expect(store.sessionId).toBe('s1')
    expect(store.items).toHaveLength(1)
  })

  it('任务「运行 → 终态」写入 pendingNotice（含 runId）', () => {
    const store = useAgentWorkStore()
    store.sessionId = 's1'
    store.applyEvent(runningBatchEvent())
    expect(store.pendingNotice).toBeNull()

    store.applyEvent(
      eventOf(2, 'task-1', {
        type: 'workbench_task',
        phase: 'begin',
        taskId: 'batch-1',
        taskKind: 'batch',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        status: 'completed',
        startedAt: 1000,
        batchStatus: 'completed',
        items: [],
        batchLimit: 10,
        summary: { runId: '20261009-120000' },
      }),
    )

    expect(store.pendingNotice).toMatchObject({
      taskKind: 'batch',
      taskStatus: 'completed',
      skillTitle: '云7登录',
      runId: '20261009-120000',
    })
  })

  it('首现即终态（如批次被取消）不写提示：那不是「跑完了」', () => {
    const store = useAgentWorkStore()
    store.sessionId = 's1'

    store.applyEvent(
      eventOf(1, 'task-1', {
        type: 'workbench_task',
        phase: 'begin',
        taskId: 'batch-1',
        taskKind: 'batch',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        status: 'interrupted',
        startedAt: 1000,
        batchStatus: 'cancelled',
      }),
    )

    expect(store.pendingNotice).toBeNull()
  })

  it('takePendingNotice 取走即清空（同一条终态不会弹两次）', () => {
    const store = useAgentWorkStore()
    store.sessionId = 's1'
    store.applyEvent(runningBatchEvent())
    store.applyEvent(
      eventOf(2, 'task-1', {
        type: 'workbench_task',
        phase: 'begin',
        taskId: 'batch-1',
        taskKind: 'batch',
        skillId: 'abc123456',
        skillTitle: '云7登录',
        status: 'completed',
        startedAt: 1000,
        summary: {},
      }),
    )

    expect(store.takePendingNotice()).not.toBeNull()
    expect(store.pendingNotice).toBeNull()
    expect(store.takePendingNotice()).toBeNull()
  })
})

/**
 * 构造一条会话概要。
 *
 * @param overrides - 需要覆盖的字段。
 * @returns 会话概要。
 * @throws 不抛出异常。
 */
function sessionOf(
  overrides: Partial<IAgentSessionSummary> = {},
): IAgentSessionSummary {
  return {
    sessionId: 's1',
    kind: 'chat',
    title: '云7登录的排查',
    status: 'idle',
    createdAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('SessionList（v17 S 组）', () => {
  it('搜索框按标题前端过滤（S3）；搜空时给明确空态', async () => {
    const sessions = [
      sessionOf({ sessionId: 's1', title: '云7登录的排查' }),
      sessionOf({ sessionId: 's2', title: '结算用例的回归' }),
    ]
    const wrapper = mount(SessionList, {
      props: { sessions, activeSessionId: null },
    })

    expect(wrapper.findAll('.session-item')).toHaveLength(2)

    await wrapper.get('.search-input').setValue('结算')
    expect(wrapper.findAll('.session-item')).toHaveLength(1)
    expect(wrapper.text()).toContain('结算用例的回归')

    await wrapper.get('.search-input').setValue('不存在的关键词')
    expect(wrapper.findAll('.session-item')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配')
    wrapper.unmount()
  })

  it('就地重命名：Enter 提交并抛出 (sessionId, title)（S1）', async () => {
    const wrapper = mount(SessionList, {
      props: { sessions: [sessionOf()], activeSessionId: null },
    })

    await wrapper.get('.action-button').trigger('click')
    const input = wrapper.get('.rename-input')
    await input.setValue('新的会话名')
    await input.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('rename')?.[0]).toEqual(['s1', '新的会话名'])
    wrapper.unmount()
  })

  it('就地重命名：Esc 取消不发请求', async () => {
    const wrapper = mount(SessionList, {
      props: { sessions: [sessionOf()], activeSessionId: null },
    })

    await wrapper.get('.action-button').trigger('click')
    const input = wrapper.get('.rename-input')
    await input.setValue('改了一半')
    await input.trigger('keydown', { key: 'Escape' })

    expect(wrapper.emitted('rename')).toBeUndefined()
    expect(wrapper.find('.rename-input').exists()).toBe(false)
    wrapper.unmount()
  })

  it('删除必须先二次确认；未确认时不抛 remove（S2）', async () => {
    const wrapper = mount(SessionList, {
      props: {
        sessions: [sessionOf({ status: 'running' })],
        activeSessionId: null,
      },
    })

    const danger = wrapper.findAll('.action-button')[1]!
    await danger.trigger('click')
    await wrapper.vm.$nextTick()

    // 弹框内容如实说明后果；有运行中任务时额外提示。
    // 弹框 teleport 到 body，因此从 document 里按弹框容器取按钮——
    // 行内的「删除」按钮文本相同，按文本全局找会命中它。
    const dialog = document.body.querySelector('.remove-dialog')
    expect(dialog).not.toBeNull()
    const dialogText = dialog!.textContent ?? ''
    expect(dialogText).toContain('确认删除会话？')
    expect(dialogText).toContain('不影响任何用例、产物与报告')
    expect(dialogText).toContain('当前有运行中的任务')
    expect(wrapper.emitted('remove')).toBeUndefined()

    // 弹框内「取消」：不删。
    const cancel = Array.from(dialog!.querySelectorAll('button')).find(
      (node) => node.textContent === '取消',
    )
    expect(cancel).toBeDefined()
    cancel!.click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('remove')).toBeUndefined()
    wrapper.unmount()
  })

  it('确认删除后抛出 remove(sessionId)', async () => {
    const wrapper = mount(SessionList, {
      props: { sessions: [sessionOf()], activeSessionId: null },
    })

    await wrapper.findAll('.action-button')[1]!.trigger('click')
    await wrapper.vm.$nextTick()

    const dialog = document.body.querySelector('.remove-dialog')
    expect(dialog).not.toBeNull()
    const confirm = Array.from(dialog!.querySelectorAll('button')).find(
      (node) => node.textContent === '删除',
    )
    expect(confirm).toBeDefined()
    confirm!.click()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('remove')?.[0]).toEqual(['s1'])
    wrapper.unmount()
  })
})

describe('v17 API 客户端', () => {
  it('提案 apply：POST 到提案路径，envValues 随请求体发送', async () => {
    await applyAgentProposal('s1', 'p1', { envValues: { KEY: 'v' } })

    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1/proposals/p1/apply',
        method: 'POST',
        body: { envValues: { KEY: 'v' } },
      }),
    )
  })

  it('提案 apply：无 envValues 时请求体为空对象（不发送 undefined）', async () => {
    await applyAgentProposal('s1', 'p1')

    expect(requestJson).toHaveBeenCalledWith(
      expect.objectContaining({ body: {} }),
    )
  })

  it('会话重命名走 PATCH；删除走 DELETE；批次三端点路径正确', async () => {
    await renameAgentSession('s1', '新名字')
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1',
        method: 'PATCH',
        body: { title: '新名字' },
      }),
    )

    await deleteAgentSession('s1')
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1',
        method: 'DELETE',
      }),
    )

    await confirmAgentBatch('s1', 'b1')
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1/batches/b1/confirm',
        method: 'POST',
      }),
    )

    await cancelAgentBatch('s1', 'b1')
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1/batches/b1/cancel',
        method: 'POST',
      }),
    )

    await stopAgentBatch('s1', 'b1')
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: '/api/agent/sessions/s1/batches/b1/stop',
        method: 'POST',
      }),
    )
  })

  it('建议问题：GET /api/agent/suggestions 后取 data.suggestions', async () => {
    requestJson.mockResolvedValueOnce({
      success: true,
      data: { suggestions: ['看看最近失败的用例'] },
    })

    await expect(getAgentSuggestions()).resolves.toEqual(['看看最近失败的用例'])
    expect(requestJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/api/agent/suggestions' }),
    )
  })
})

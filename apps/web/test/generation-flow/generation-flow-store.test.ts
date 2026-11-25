/**
 * 生成流程 store 的单元测试（PRD 4.4 / 5.2 / 5.4 / 6.6 / AC-11、AC-15）。
 *
 * 覆盖：副标题派生、空态、启动 SKILL 阶段时立即展开侧边栏、
 * 就绪校验失败时不展开侧边栏、关闭时清空全部状态。
 */
import { computed, ref, shallowRef } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  streamSkillDocumentGeneration: vi.fn(),
  saveSkillDocument: vi.fn(),
  streamPlaywrightGeneration: vi.fn(),
  savePlaywrightScript: vi.fn(),
  fetchSkillFile: vi.fn(),
  abortAgentSession: vi.fn(),
  answerAgentInteraction: vi.fn(),
  useAgentWorkTimeline: vi.fn(),
}))

vi.mock('../../src/modules/e2e-test-case/services/skill-document-api', () => ({
  streamSkillDocumentGeneration: apiMocks.streamSkillDocumentGeneration,
  saveSkillDocument: apiMocks.saveSkillDocument,
}))
vi.mock('../../src/modules/e2e-test-case/services/e2e-test-case-api', () => ({
  streamPlaywrightGeneration: apiMocks.streamPlaywrightGeneration,
  savePlaywrightScript: apiMocks.savePlaywrightScript,
}))
vi.mock('../../src/services/skill-api', () => ({
  fetchSkillFile: apiMocks.fetchSkillFile,
}))
vi.mock('../../src/services/agent-work-api', () => ({
  abortAgentSession: apiMocks.abortAgentSession,
  answerAgentInteraction: apiMocks.answerAgentInteraction,
  getAgentWorkBlocks: vi.fn(async () => ({ blocks: [], currentSeq: 0 })),
  subscribeAgentWorkStream: vi.fn(() => ({ close: vi.fn() })),
}))

import { useGenerationFlowStore } from '../../src/stores/generation-flow'
import { useGlobalChatStore } from '../../src/stores/global-chat'

/** 构造最小用例。 */
const testCase = {
  schemaVersion: '1.0' as const,
  id: 'case_login',
  title: '用户登录',
  description: '验证登录。',
  baseUrl: 'https://example.test',
  tags: [],
  preconditions: [],
  steps: [],
}

/** 构造 SKILL 生成结果。 */
function skillResult() {
  return {
    content:
      '---\nname: 用户登录\ndescription: 验证登录。\n---\n\n# 测试目标\n\n验证登录。\n',
    warnings: [],
    assumptions: [],
    environmentVariables: [],
    sourceHash: `sha256:${'a'.repeat(64)}`,
    testCaseVersion: 'b'.repeat(64),
    skillDocumentVersion: 'c'.repeat(64),
  }
}

/**
 * 装配 store 依赖。
 * @param overrides 需要覆盖的依赖片段。
 * @returns store 实例。
 * @throws 不抛出异常。
 */
function setupStore(overrides: { canGenerate?: boolean } = {}) {
  const store = useGenerationFlowStore()
  const dirty = ref(false)
  const canGenerate = ref(overrides.canGenerate ?? true)

  store.setDependencies(
    {
      skill: {
        skillId: ref('abc123def'),
        draft: ref(testCase),
        version: ref('v1'),
        sourceHash: ref(`sha256:${'a'.repeat(64)}`),
        skillDocument: ref(null),
        dirty: computed(() => dirty.value),
        canGenerate: computed(() => canGenerate.value),
        saveTestCase: vi.fn(async () => true),
      },
      script: {
        skillId: ref('abc123def'),
        draft: ref(testCase),
        version: ref('v1'),
        sourceHash: ref(`sha256:${'a'.repeat(64)}`),
        script: ref(null),
        dirty: computed(() => dirty.value),
        canGenerate: computed(() => canGenerate.value),
        saveTestCase: vi.fn(async () => true),
      },
    },
    `sha256:${'a'.repeat(64)}`,
  )

  return { store, dirty, canGenerate }
}

beforeEach(() => {
  setActivePinia(createPinia())
  apiMocks.streamSkillDocumentGeneration.mockReset()
  apiMocks.saveSkillDocument.mockReset()
  apiMocks.saveSkillDocument.mockResolvedValue({
    success: true,
    data: {
      relativePath: 'SKILL.md',
      version: 'd'.repeat(64),
      size: 100,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      generatedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      diagnostics: [],
    },
  })
})

describe('generation-flow store 空态（PRD 5.5）', () => {
  it('初始无流程数据，副标题为空（不展示）', () => {
    const { store } = setupStore()

    expect(store.hasFlowData).toBe(false)
    expect(store.sidebarItems).toEqual([])
    expect(store.subtitle).toBe('')
    expect(store.isRunning).toBe(false)
    expect(store.latestCardKey).toBeNull()
  })
})

describe('generation-flow store 启动 SKILL 阶段（PRD 4.4）', () => {
  it('立即展开侧边栏，不等 sessionId 到达', async () => {
    const { store } = setupStore()
    const globalChat = useGlobalChatStore()
    // 生成流挂起：验证展开发生在事件到达之前。
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        void signal
      },
    )

    const pending = store.startSkillGeneration()

    expect(globalChat.visible).toBe(true)
    await pending
  })

  it('新一轮生成完成后，内容必须留在工作台（v13 C-2 回归：清空不得发生在启动之后）', async () => {
    const { store } = setupStore()
    const globalChat = useGlobalChatStore()
    // 第一轮：产出一张 SKILL.md 卡片（终态）。这是缺陷的触发前提——
    // 初版的清空写在 `await` 之后，只有当「已有内容」时才真的执行 reset()。
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'complete', data: skillResult() })
      },
    )
    await store.startSkillGeneration()
    expect(
      store.sidebarItems.filter((item) => item.kind === 'card'),
    ).toHaveLength(1)

    // 第二轮：生成流挂起，模拟「生成需要数十秒」的真实情形。
    // 用对象持住 resolve：直接声明 `let release: (() => void) | null` 会被
    // TS 的闭包分析收窄成 `never`（它看不到异步回调里的赋值）。
    const gate: { release?: () => void } = {}
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'start', requestId: 'r2', sessionId: 'generation:s2' })
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
        onEvent({ type: 'complete', data: skillResult() })
      },
    )

    const pending = store.startSkillGeneration()

    // 挂起期间：主体已指向本工作项，旧卡片已清空，阶段记录已建立。
    expect(globalChat.subject).toEqual({
      kind: 'generation',
      skillId: 'abc123def',
    })
    expect(store.hasFlowData).toBe(true)
    expect(store.isRunning).toBe(true)

    gate.release?.()
    await pending

    // **关键断言**：完成后内容仍在。
    // 初版把「清空旧内容」放在 await 之后，会把刚完成（甚至仍在运行）的阶段
    // 一并 reset 掉——生成明明成功了，工作台却是空的。
    expect(store.hasFlowData).toBe(true)
    expect(
      store.sidebarItems.filter((item) => item.kind === 'card'),
    ).toHaveLength(1)
  })

  it('上一轮已终态时先清空旧内容再承载新工作项（v13 C-2/C-6）', async () => {
    const { store } = setupStore()
    const globalChat = useGlobalChatStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'complete', data: skillResult() })
      },
    )

    // 第一轮：产出一张 SKILL.md 卡片（终态）。
    await store.startSkillGeneration()
    expect(store.hasFlowData).toBe(true)

    // 第二轮：旧内容被清空，只剩新工作项的阶段记录。
    await store.startSkillGeneration()

    // 阶段记录只有一条（skill），不会叠加成两条。
    expect(
      store.sidebarItems.filter((item) => item.kind === 'stage'),
    ).toHaveLength(1)
    expect(globalChat.subject?.kind).toBe('generation')
  })

  it('生成完成即即时保存并产出 SKILL.md 卡片（AC-08）', async () => {
    const { store } = setupStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'start', requestId: 'r1', sessionId: 'generation:s1' })
        onEvent({ type: 'complete', data: skillResult() })
      },
    )

    const completed = await store.startSkillGeneration()

    expect(completed).toBe(true)
    // 生成完成即落盘：以 generation 模式调用保存。
    expect(apiMocks.saveSkillDocument).toHaveBeenCalledTimes(1)
    expect(apiMocks.saveSkillDocument.mock.calls[0]![1]).toMatchObject({
      mode: 'generation',
    })
    // 副标题切换为「SKILL.md 完成」（AC-03）。
    expect(store.subtitle).toBe('SKILL.md 完成')
    // 阶段区块与产物卡片平级排列（AC-04）。
    expect(store.sidebarItems.map((item) => item.kind)).toEqual([
      'stage',
      'card',
    ])
    // SKILL.md 卡片为最新卡片，唯一承载关闭按钮（AC-06）。
    expect(store.latestCardKey).not.toBeNull()
  })

  it('首次落盘的质量诊断随卡片呈现，且不阻断完成（v15）', async () => {
    const { store } = setupStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'start', requestId: 'r1', sessionId: 'generation:s1' })
        onEvent({ type: 'complete', data: skillResult() })
      },
    )
    // 服务端在落盘成功的同时回传诊断：章节缺失属质量族，不阻断写入。
    apiMocks.saveSkillDocument.mockResolvedValue({
      success: true,
      data: {
        relativePath: 'SKILL.md',
        version: 'd'.repeat(64),
        size: 100,
        sourceHash: `sha256:${'a'.repeat(64)}`,
        generatedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        diagnostics: [
          {
            code: 'SKILL_DOCUMENT_SECTION_MISSING',
            message: 'SKILL.md 缺少“前置条件”章节。',
            severity: 'warning',
          },
        ],
      },
    })

    const completed = await store.startSkillGeneration()

    // 落盘成功、流程照常推进到完成——诊断不阻断。
    expect(completed).toBe(true)
    expect(store.subtitle).toBe('SKILL.md 完成')

    // 诊断必须进入产物卡片，否则用户看不到「已完成但有话要说」。
    const card = store.sidebarItems.find((item) => item.kind === 'card')
    expect(card?.kind === 'card' && card.card.diagnostics).toEqual([
      expect.objectContaining({ code: 'SKILL_DOCUMENT_SECTION_MISSING' }),
    ])
  })

  it('就绪校验失败时不展开侧边栏、不创建阶段记录（PRD 4.4 规则 3 / AC-15）', async () => {
    const { store } = setupStore({ canGenerate: false })
    const globalChat = useGlobalChatStore()

    const completed = await store.startSkillGeneration()

    expect(completed).toBe(false)
    expect(globalChat.visible).toBe(false)
    expect(store.hasFlowData).toBe(false)
    expect(apiMocks.streamSkillDocumentGeneration).not.toHaveBeenCalled()
  })

  it('草稿未保存时仍允许启动：先自动保存再生成（PRD 4.4 规则 1）', async () => {
    // 回归用例：编辑后草稿必然 dirty，而「保存并生成」正是要处理这种情况。
    // 若把 dirty 算作阻塞，用户点按钮会毫无反应，只能先手动点「保存用例」。
    const { store, dirty } = setupStore()
    dirty.value = true
    const globalChat = useGlobalChatStore()
    const saveTestCase = vi.fn(async () => true)
    store.setDependencies(
      {
        skill: {
          skillId: ref('abc123def'),
          draft: ref(testCase),
          version: ref('v1'),
          sourceHash: ref(`sha256:${'a'.repeat(64)}`),
          skillDocument: ref(null),
          dirty: computed(() => dirty.value),
          canGenerate: computed(() => true),
          saveTestCase,
        },
        script: {
          skillId: ref('abc123def'),
          draft: ref(testCase),
          version: ref('v1'),
          sourceHash: ref(`sha256:${'a'.repeat(64)}`),
          script: ref(null),
          dirty: computed(() => dirty.value),
          canGenerate: computed(() => true),
          saveTestCase,
        },
      },
      `sha256:${'a'.repeat(64)}`,
    )
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'complete', data: skillResult() })
      },
    )

    const completed = await store.startSkillGeneration()

    // 侧边栏立即展开，且顺序为「先保存用例、再启动生成流」。
    expect(globalChat.visible).toBe(true)
    expect(saveTestCase).toHaveBeenCalledTimes(1)
    expect(saveTestCase.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.streamSkillDocumentGeneration.mock.invocationCallOrder[0]!,
    )
    expect(completed).toBe(true)
  })

  it('生成失败时产出终止卡片且不出现产物卡片（AC-07）', async () => {
    const { store } = setupStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({
          type: 'error',
          code: 'INTERNAL_ERROR',
          message: 'Agent 生成失败。',
        })
      },
    )

    const completed = await store.startSkillGeneration()

    expect(completed).toBe(false)
    expect(store.subtitle).toBe('SKILL.md 生成失败')
    expect(store.sidebarItems.map((item) => item.kind)).toEqual([
      'stage',
      'failure',
    ])
    // 副标题反映失败，但关闭按钮仍可用（流程已到终态）。
    expect(store.latestCardKey).not.toBeNull()
  })

  it('即时保存失败时产出终止卡片，并说明磁盘可能仍是旧版本（PRD 10.3）', async () => {
    const { store } = setupStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'complete', data: skillResult() })
      },
    )
    apiMocks.saveSkillDocument.mockRejectedValue(new Error('磁盘写入失败。'))

    const completed = await store.startSkillGeneration()

    expect(completed).toBe(false)
    const failure = store.sidebarItems.find((item) => item.kind === 'failure')
    expect(failure).toBeDefined()
    expect(
      failure!.kind === 'failure' && failure!.card.partialWriteHint,
    ).toContain('旧版本')
  })
})

describe('generation-flow store 实时编辑（PRD 7.2–7.4 / AC-09）', () => {
  it('编辑卡片内容后防抖自动保存，并同步卡片保存状态与内容', async () => {
    vi.useFakeTimers()
    try {
      const { store } = setupStore()
      apiMocks.streamSkillDocumentGeneration.mockImplementation(
        async ({ onEvent }) => {
          onEvent({ type: 'complete', data: skillResult() })
        },
      )
      await store.startSkillGeneration()

      const card = store.sidebarItems.find((item) => item.kind === 'card')!.card
      expect(card.saveState).toBe('saved')

      // 用户输入：同步更新内容与「有未保存改动」状态，不等待任何请求。
      store.updateCardContent(
        card.key,
        `${card.content}\n\n## 用户补充\n\n手改内容。\n`,
      )
      expect(store.saveStateFor(card.key)).toBe('pending')
      expect(apiMocks.saveSkillDocument).toHaveBeenCalledTimes(1)

      // 防抖窗口结束后自动保存：edit 模式（不阻断、仅产出诊断）。
      await vi.advanceTimersByTimeAsync(800)

      expect(apiMocks.saveSkillDocument).toHaveBeenCalledTimes(2)
      expect(apiMocks.saveSkillDocument.mock.calls[1]![1]).toMatchObject({
        mode: 'edit',
      })
      expect(apiMocks.saveSkillDocument.mock.calls[1]![1].content).toContain(
        '用户补充',
      )
      expect(store.saveStateFor(card.key)).toBe('saved')
      // 卡片内容同步更新（编辑器绑定的是卡片模型）。
      const updated = store.sidebarItems.find(
        (item) => item.kind === 'card',
      )!.card
      expect(updated.content).toContain('用户补充')
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存失败时卡片状态转为 failed，本地内容不回滚（AC-10）', async () => {
    vi.useFakeTimers()
    try {
      const { store } = setupStore()
      apiMocks.streamSkillDocumentGeneration.mockImplementation(
        async ({ onEvent }) => {
          onEvent({ type: 'complete', data: skillResult() })
        },
      )
      await store.startSkillGeneration()

      const card = store.sidebarItems.find((item) => item.kind === 'card')!.card
      apiMocks.saveSkillDocument.mockRejectedValue(new Error('网络错误。'))

      store.updateCardContent(card.key, `${card.content}\n编辑中。\n`)
      // 首次 + 三次退避重试（1s / 2s / 4s）。
      await vi.advanceTimersByTimeAsync(800)
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(4000)

      expect(store.saveStateFor(card.key)).toBe('failed')
      // 本地内容保留在屏幕上，不被回滚。
      const current = store.sidebarItems.find(
        (item) => item.kind === 'card',
      )!.card
      expect(current.content).toContain('编辑中。')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('generation-flow store 清空与关闭（v13 PRD B-6 / 第 12 章）', () => {
  /**
   * 起一次成功的生成，返回处于「有内容」状态的 store。
   *
   * @returns store 与其 globalChat 实例。
   * @throws 不抛出异常。
   */
  async function generateOnce() {
    const { store } = setupStore()
    const globalChat = useGlobalChatStore()
    apiMocks.streamSkillDocumentGeneration.mockImplementation(
      async ({ onEvent }) => {
        onEvent({ type: 'complete', data: skillResult() })
      },
    )
    await store.startSkillGeneration()
    expect(store.hasFlowData).toBe(true)
    return { store, globalChat }
  }

  it('reset：清空全部内容，但**不收起**工作台（v13 B-6）', async () => {
    const { store, globalChat } = await generateOnce()
    expect(globalChat.visible).toBe(true)

    store.reset()

    expect(store.hasFlowData).toBe(false)
    expect(store.sidebarItems).toEqual([])
    expect(store.subtitle).toBe('')
    // 清空与收起是两件事：清空只销毁内容，界面状态不变（PRD B-4/B-6）。
    expect(globalChat.visible).toBe(true)
  })

  it('close：清空内容**并**收起（v9 旧语义的组合动作）', async () => {
    const { store, globalChat } = await generateOnce()

    store.close()

    expect(store.hasFlowData).toBe(false)
    expect(globalChat.visible).toBe(false)
  })

  it('收起保留状态，仅隐藏工作台（v9 PRD 4.3 / AC-11）', async () => {
    const { store, globalChat } = await generateOnce()

    store.collapse()

    expect(globalChat.visible).toBe(false)
    // 卡片与工作记录保留在内存中，重新展开即恢复。
    expect(store.hasFlowData).toBe(true)
  })
})

/**
 * 可复用工作时间线 composable 的回归测试。
 *
 * 本文件锁定的是一个**曾经真实发生、且极具迷惑性**的渲染缺陷：
 * 生成侧边栏的流式文本只显示最先到达的几个字，光标一直闪烁，后续内容
 * 再也不出现；直到阶段结束、用户手动折叠再展开，完整文本才显示出来。
 *
 * 根因不在 SSE 接收，也不在归约器：归约器是**就地修改**已有项的
 * （`item.text += event.text`），项的对象引用始终不变。当时 composable 用
 * 普通对象承载归约状态，项内部的改动没有任何响应式系统能看见；
 * 而 Vue 更新子组件前做的是 **props 浅比较**（判 `nextProp !== prevProp`
 * 的引用相等），父级换数组引用重新渲染后，传给子组件的 `item` 引用没变，
 * 于是子组件被直接跳过——文本冻结。数据在内存里始终是完整的，
 * 所以折叠再展开（重新挂载）后又显示正常，这就是它难以定位的原因。
 *
 * 修复方式：归约状态承载在 `reactive` 上，项被读取时包成代理，
 * 归约器的就地写入经代理触发子组件自身的重渲染依赖。
 *
 * 因此本文件同时锁定三条契约，缺一不可：
 *   1. 已存在块的内容增长要能渲染（深层响应式在起作用）；
 *   2. 新到达的块要能渲染（syncRefs 的浅拷贝在起作用）；
 *   3. 块的终态变化要能渲染（光标随 `status` 收尾而消失）。
 * 只满足其中一条的「修复」都是不完整的。
 */
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TAgentClientEvent } from '@fynn90-e2e_assistant/types'

/** 捕获被订阅方注册的事件回调，测试中据此注入事件。 */
interface IStreamHandlers {
  onEvent (event: TAgentClientEvent): void
  onConnectionChange?(state: string): void
}

const captured: { handlers: IStreamHandlers | null } = { handlers: null }

// 订阅与历史加载在测试中替换为可控桩：本文件关注的是**渲染**，
// 不是 SSE 传输（传输层另有 agent-work-api-reconnect.test.ts 覆盖）。
vi.mock('../../src/services/agent-work-api', () => ({
  getAgentWorkBlocks: vi.fn(async () => ({ blocks: [], currentSeq: 0 })),
  subscribeAgentWorkStream: vi.fn(
    (
      _sessionId: string,
      _getAfterSeq: () => number | undefined,
      handlers: IStreamHandlers,
    ) => {
      captured.handlers = handlers
      handlers.onConnectionChange?.('live')
      return { close: (): void => undefined }
    },
  ),
}))

// 必须在 mock 之后导入，否则拿到的是真实模块（会真的发 fetch）。
const { useAgentWorkTimeline } =
  await import('../../src/modules/agent-work/timeline/useAgentWorkTimeline')
const WorkTimeline = (
  await import('../../src/modules/agent-work/components/WorkTimeline.vue')
).default

/**
 * 构造一条内容块事件（信封字段齐全）。
 *
 * @param seq - 事件序号（必须严格递增，否则被归约器幂等丢弃）。
 * @param blockId - 工作块 ID。
 * @param payload - 内容块载荷。
 * @returns 可直接投递给事件回调的客户端事件。
 * @throws 不抛出异常。
 */
function contentEvent (
  seq: number,
  blockId: string,
  payload:
    | { type: 'content'; phase: 'begin'; contentType: 'markdown' }
    | { type: 'content'; phase: 'append'; text: string }
    | { type: 'content'; phase: 'end' },
): TAgentClientEvent {
  return {
    sessionId: 's1',
    blockId,
    seq,
    timestamp: 1000 + seq,
    ...payload,
  } as TAgentClientEvent
}

/**
 * 挂载一个使用真实 composable 的最小宿主，并把时间线渲染成真实 DOM。
 *
 * @returns 挂载好的组件包装器与向该会话投递事件的方法。
 * @throws 不抛出异常。
 */
async function mountTimeline (): Promise<{
  wrapper: ReturnType<typeof mount>
  emitEvent: (event: TAgentClientEvent) => Promise<void>
}> {
  const Host = defineComponent({
    setup () {
      const sessionId = ref<string | null>('s1')
      const timeline = useAgentWorkTimeline({ sessionId })
      return () => h(WorkTimeline, { items: timeline.items.value })
    },
  })

  const wrapper = mount(Host)
  // 历史的异步加载（getAgentWorkBlocks）走完后订阅才建立。
  await flushPromises()
  await nextTick()

  return {
    wrapper,
    emitEvent: async (event: TAgentClientEvent): Promise<void> => {
      captured.handlers?.onEvent(event)
      await nextTick()
    },
  }
}

beforeEach(() => {
  captured.handlers = null
})

describe('useAgentWorkTimeline 流式渲染', () => {
  it('已存在块的内容增长会实时渲染（回归：文本冻结在前几个字）', async () => {
    const { wrapper, emitEvent } = await mountTimeline()

    await emitEvent(
      contentEvent(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    await emitEvent(
      contentEvent(2, 'c1', {
        type: 'content',
        phase: 'append',
        text: '好的，',
      }),
    )

    expect(wrapper.text()).toContain('好的，')

    // 关键：后续 append 是**就地追加到同一个项对象**上的。
    // 修复前这些文本永远不会进入 DOM（子组件因 props 引用未变被跳过）。
    for (const [seq, text] of [
      [3, '我根据最新'],
      [4, ' test_case 数据'],
      [5, '生成 SKILL.md'],
    ] as const) {
      await emitEvent(
        contentEvent(seq, 'c1', { type: 'content', phase: 'append', text }),
      )
      expect(wrapper.text(), `第 ${seq} 条 append 后`).toContain(text)
    }

    expect(wrapper.text()).toContain(
      '好的，我根据最新 test_case 数据生成 SKILL.md',
    )
    wrapper.unmount()
  })

  it('块结束时流式光标随之消失（回归：光标一直闪烁）', async () => {
    const { wrapper, emitEvent } = await mountTimeline()

    await emitEvent(
      contentEvent(1, 'c1', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    await emitEvent(
      contentEvent(2, 'c1', { type: 'content', phase: 'append', text: '文本' }),
    )

    // 运行中：内容块带 streaming 类，伪元素光标挂在其内层元素上。
    expect(wrapper.find('.content-block').classes()).toContain('streaming')

    await emitEvent(contentEvent(3, 'c1', { type: 'content', phase: 'end' }))

    // 修复前 `status` 的改动同样被浅比较挡掉，光标会一路闪到阶段结束。
    expect(wrapper.find('.content-block').classes()).not.toContain('streaming')
    wrapper.unmount()
  })

  it('后续新到达的块会追加渲染（syncRefs 浅拷贝的职责）', async () => {
    const { wrapper, emitEvent } = await mountTimeline()

    await emitEvent(
      contentEvent(1, 'a', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    await emitEvent(
      contentEvent(2, 'a', {
        type: 'content',
        phase: 'append',
        text: '第一段',
      }),
    )
    expect(wrapper.findAll('.content-block')).toHaveLength(1)

    // 第二个块：插入新的项对象，依赖 items 浅层引用的变化触发渲染。
    await emitEvent(
      contentEvent(3, 'b', {
        type: 'content',
        phase: 'begin',
        contentType: 'markdown',
      }),
    )
    await emitEvent(
      contentEvent(4, 'b', {
        type: 'content',
        phase: 'append',
        text: '第二段',
      }),
    )

    expect(wrapper.findAll('.content-block')).toHaveLength(2)
    expect(wrapper.text()).toContain('第一段')
    expect(wrapper.text()).toContain('第二段')
    wrapper.unmount()
  })

  it('思考块与工具块的流式文本同样实时渲染（同一条渲染链路）', async () => {
    const { wrapper, emitEvent } = await mountTimeline()

    await emitEvent({
      sessionId: 's1',
      blockId: 't1',
      seq: 1,
      timestamp: 1,
      type: 'thinking',
      phase: 'begin',
    } as TAgentClientEvent)
    await emitEvent({
      sessionId: 's1',
      blockId: 't1',
      seq: 2,
      timestamp: 2,
      type: 'thinking',
      phase: 'append',
      text: '先看用例',
    } as TAgentClientEvent)

    // 折叠态展示最新一句思考，文本增长必须实时反映在头部。
    expect(wrapper.text()).toContain('先看用例')

    await emitEvent({
      sessionId: 's1',
      blockId: 't1',
      seq: 3,
      timestamp: 3,
      type: 'thinking',
      phase: 'append',
      text: '，再写文档',
    } as TAgentClientEvent)

    expect(wrapper.text()).toContain('先看用例，再写文档')
    wrapper.unmount()
  })
})

/**
 * 可复用 Agent 工作时间线 composable。
 *
 * 与 stores/agent-work.ts 的区别：本 composable 不持有全局单例状态，
 * 一个实例绑定一个会话，可被生成弹窗、工作台面板等多处并行使用
 * （单例 store 的 sessionId 是单值，两处同时用会互相清空时间线）。
 *
 * 职责：订阅指定会话的 SSE 事件流，用归约器把事件累积为时间线状态，
 * 并在会话切换 / 组件卸载时正确断开订阅。
 */
import {
  getCurrentInstance,
  onBeforeUnmount,
  reactive,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import type { TAgentActivity } from '@authine-e2e-agent/types'
import {
  getAgentWorkBlocks,
  subscribeAgentWorkStream,
  type IAgentWorkStreamSubscription,
} from '../../../services/agent-work-api'
import {
  applyEventToTimeline,
  clearTimeline,
  createTimelineState,
  resetWithBlocks,
} from './reducer'
import type { TWorkConnection, TWorkTimelineItem } from './types'

/** 事件流连接状态（本地维护，避免依赖 store 类型）。 */
export type { TWorkConnection } from './types'

/** useAgentWorkTimeline 的入参。 */
export interface IUseAgentWorkTimelineOptions {
  /** 响应式会话 ID；为空时不订阅，变化时自动重订阅。 */
  sessionId: Ref<string | null>
  /** 历史加载失败时的回调（订阅失败不回调，由连接状态体现）。 */
  onError?: (error: unknown) => void
}

/** useAgentWorkTimeline 的返回值。 */
export interface IUseAgentWorkTimeline {
  /** 时间线项（按 seq 升序）。 */
  items: Ref<readonly TWorkTimelineItem[]>
  /** 状态条：当前活动。 */
  activity: Ref<TAgentActivity>
  /** 状态条：活动文案。 */
  activityLabel: Ref<string | undefined>
  /** 事件流连接状态。 */
  connection: Ref<TWorkConnection>
  /** 手动断开订阅（组件卸载时自动调用）。 */
  dispose: () => void
}

/**
 * 订阅会话工作事件流并归约为时间线。
 *
 * @param options - 会话 ID 与错误回调。
 * @returns 只读时间线状态与释放方法。
 * @throws 不抛出异常；历史加载失败通过 onError 回调上报。
 */
export function useAgentWorkTimeline(
  options: IUseAgentWorkTimelineOptions,
): IUseAgentWorkTimeline {
  // 归约状态**必须**是深层响应式：归约器是**就地修改**已有项的
  // （`item.text += event.text`），项的对象引用始终不变。若用普通对象承载，
  // 项内部的改动不会被任何响应式系统看见，渲染层只能靠「数组引用变化」
  // 这一条线索决定是否重渲染。
  //
  // 而 Vue 更新子组件前做的是 **props 浅比较**（`hasPropValueChanged` 判的是
  // `nextProp !== prevProp` 这个引用相等）：父级换数组引用后重新渲染，
  // 但传给子组件的 `item` 引用没变，Vue 直接跳过子组件更新——
  // 于是流式文本冻结在首批到达的几个字上，光标一直闪（`status` 从 streaming
  // 变为 done 的改动同样看不见）。数据在内存里是完整的，所以「折叠再展开」
  // 触发重新挂载后又显示正常，具有极强的迷惑性。
  //
  // 承载在 reactive 上后，`state.items` 在读取时即被包成响应式数组，
  // 取出的项也是代理，归约器的就地写入经代理触发子组件自身的重渲染依赖，
  // 浅比较的前提不再构成阻碍。归约器本身无需改动——它只依赖数组/对象的
  // 读写语义，代理对它是透明的。
  // （`stores/agent-work.ts` 走 Pinia 的深度响应式，天然没有该问题——
  // 这正是「工作台流式正常、生成侧边栏冻结」的差异来源。）
  const state = reactive(createTimelineState())
  const items = shallowRef<readonly TWorkTimelineItem[]>([])
  const activity = ref<TAgentActivity>('idle')
  const activityLabel = ref<string | undefined>(undefined)
  const connection = ref<TWorkConnection>('offline')
  let stream: IAgentWorkStreamSubscription | undefined
  let disposed = false

  /**
   * 把归约状态的当前值同步到响应式引用。
   *
   * 归约器就地修改 state.items，shallowRef 需要新数组引用才会触发
   * **列表层面**的渲染（新块的插入 / 删除），因此这里做浅拷贝
   * （同时避免外部直接改动内部数组）。
   *
   * 注意本函数**不负责**已有块的内容更新：那是归约状态自身的响应式
   * 代理在负责（见上方 `const state = reactive(...)` 的说明）。
   * 两者缺一不可——少了这次浅拷贝，新插入的块不会渲染；
   * 少了深层响应式，已有块的增长不会渲染。
   */
  function syncRefs(): void {
    items.value = [...state.items]
    activity.value = state.activity
    activityLabel.value = state.activityLabel
  }

  /** 断开事件流订阅。 */
  function detach(): void {
    stream?.close()
    stream = undefined
    connection.value = 'offline'
  }

  /**
   * 打开指定会话：先拉取物化历史恢复时间线，再订阅实时事件流。
   *
   * @param sessionId - 目标会话 ID。
   * @returns 打开完成后兑现的 Promise（历史加载失败时已通过 onError 上报）。
   */
  async function open(sessionId: string): Promise<void> {
    detach()
    clearTimeline(state)
    syncRefs()
    try {
      const { blocks, currentSeq } = await getAgentWorkBlocks(sessionId)
      // 期间可能已切换会话或已卸载：丢弃过期结果。
      if (disposed || options.sessionId.value !== sessionId) return
      resetWithBlocks(state, blocks, currentSeq)
      syncRefs()
    } catch (error) {
      options.onError?.(error)
      // 历史恢复失败不阻断实时流：仍继续订阅，至少能看到后续事件。
    }
    if (disposed || options.sessionId.value !== sessionId) return
    stream = subscribeAgentWorkStream(
      sessionId,
      () => (state.lastSeq > 0 ? state.lastSeq : undefined),
      {
        onEvent: (event) => {
          applyEventToTimeline(state, event)
          syncRefs()
        },
        onConnectionChange: (value) => {
          connection.value = value
        },
      },
    )
  }

  watch(
    () => options.sessionId.value,
    (sessionId) => {
      if (!sessionId) {
        detach()
        clearTimeline(state)
        syncRefs()
        return
      }
      void open(sessionId)
    },
    { immediate: true },
  )

  /** 断开订阅并标记已释放（避免迟到的异步结果写回）。 */
  function dispose(): void {
    disposed = true
    detach()
  }

  // 组件内使用时自动随组件卸载释放；在 store / 模块作用域创建时不存在活动
  // 组件实例，此时由调用方显式 dispose（生成流程 store 在关闭侧边栏时统一释放）。
  if (getCurrentInstance()) onBeforeUnmount(dispose)

  return { items, activity, activityLabel, connection, dispose }
}

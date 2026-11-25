/**
 * Agent 工作台 Pinia store：把客户端事件流归并为渲染友好的工作时间线。
 *
 * 职责：
 *   - 会话列表与当前会话管理（创建 / 恢复 / 续聊 / 中止）；
 *   - 历史工作块 + 实时事件的统一归并；
 *   - 旁路事件分发：status → 状态条，file_change → 文件树刷新信号。
 *
 * 归约逻辑已抽到 ../modules/agent-work/timeline/reducer，本 store 只持有状态，
 * 使同一套归约语义可被生成弹窗（useAgentWorkTimeline）复用而不争抢单例状态。
 */
import { defineStore } from 'pinia'
import type {
  IAgentSessionSummary,
  TAgentActivity,
  TAgentClientEvent,
} from '@fynn90-e2e_assistant/types'
import {
  abortAgentSession,
  createAgentSession,
  getAgentWorkBlocks,
  listAgentSessions,
  sendAgentMessage,
  subscribeAgentWorkStream,
  type IAgentWorkStreamSubscription,
} from '../services/agent-work-api'
import {
  applyEventToTimeline,
  clearTimeline,
  resetWithBlocks,
  type IFileChangeSignal,
  type IInteractionTimelineItem,
  type TWorkConnection,
  type TWorkTimelineItem,
} from '../modules/agent-work/timeline'

/**
 * 待发布的 /agent 任务完成提示（v17 C7）。
 *
 * 由 store 在「任务终态 + 视图未挂载」时写入，宿主组件消费后发全局通知。
 */
export interface IPendingTerminalNotice {
  /** 会话 ID（点击提示回到该会话用）。 */
  sessionId: string
  /** 目标用例标题。 */
  skillTitle: string
  /** 任务种类：执行 / 生成 / 连续执行。 */
  taskKind: 'execution' | 'generation' | 'batch'
  /** 任务终态。 */
  taskStatus: 'completed' | 'failed' | 'interrupted'
  /** 有报告时的运行编号（提示里的「查看报告」入口用）。 */
  runId?: string
  /** 目标用例 ID（报告入口需要）。 */
  skillId: string
}

export const useAgentWorkStore = defineStore('agent-work', {
  state: () => ({
    /** 会话列表（恢复入口）。 */
    sessions: [] as IAgentSessionSummary[],
    /** 当前打开的会话 ID。 */
    sessionId: null as string | null,
    /** 当前会话的时间线（历史 + 实时归并后）。 */
    items: [] as TWorkTimelineItem[],
    /** 状态条：当前活动与文案。 */
    activity: 'idle' as TAgentActivity,
    activityLabel: undefined as string | undefined,
    /** 事件流连接状态。 */
    connection: 'offline' as TWorkConnection,
    /** 已见最大事件序号（断线续传依据）。 */
    lastSeq: 0,
    /** 消息发送中（禁用输入）。 */
    sending: false,
    /** 最近的文件变更信号（文件树实时刷新用）。 */
    fileChanges: [] as IFileChangeSignal[],
    /** blockId → items 下标（原位更新定位用）。 */
    itemIndex: new Map<string, number>(),
    /** 当前事件流订阅（非组件渲染数据）。 */
    stream: undefined as IAgentWorkStreamSubscription | undefined,
    /**
     * 视图是否挂载（v17 C7）。
     *
     * 与「是否保持订阅」是两件事：离开 `/agent` 后仍可能因为**有任务在跑**
     * 而保持订阅，此时任务终态要转成全局提示（见 `pendingNotice`）。
     */
    viewAttached: false,
    /**
     * 待发布的完成提示（v17 C7）。
     *
     * 只在 `viewAttached === false` 且任务进入终态时写入；由应用级宿主
     * （`AgentSessionNoticeHost`）消费后置空。放在 store 而不是事件回调里直接
     * 发通知：`useNotification()` 只能在组件 setup 的同步调用链上取到，
     * store 里没有注入上下文。
     */
    pendingNotice: null as IPendingTerminalNotice | null,
  }),

  getters: {
    /** 待回答的交互卡片（置顶提醒用）。 */
    pendingInteractions (state): IInteractionTimelineItem[] {
      return state.items.filter(
        (item): item is IInteractionTimelineItem =>
          item.kind === 'interaction' && item.status === 'pending',
      )
    },
    /** 当前会话是否正在运行（用于输入区禁用/中止按钮展示）。 */
    isRunning (state): boolean {
      return state.activity !== 'idle'
    },
    /**
     * 是否存在运行中的任务（v17 C7 的「离开页面是否要保持订阅」判据）。
     *
     * 判据是「有 `workbench_task` 且 `taskStatus === 'running'`」——**不看
     * activity**：activity 反映的是 Agent 轮次（模型是否在回话），而任务卡片的
     * running 反映的是执行 / 生成 / 批次本身。用户在任务运行中离开页面时，
     * 轮次可能已结束而任务仍在跑，用 activity 会漏掉。
     */
    hasRunningTask (state): boolean {
      return state.items.some(
        (item) =>
          item.kind === 'workbench_task' && item.taskStatus === 'running',
      )
    },
  },

  actions: {
    /** 加载会话列表。 */
    async loadSessions (): Promise<void> {
      this.sessions = await listAgentSessions()
    },

    /**
     * 静默刷新会话列表（失败不打断对话流）。
     *
     * 列表里的状态与标题是**服务端字段**，只在拉取的那一刻定格：进入页面时拉过一次，
     * 之后若不再刷新，会话跑完了列表还停在「运行中」，标题也停在建会话时的预览。
     * 因此每轮结束都刷一次——它是纯展示数据，失败无需打扰用户。
     *
     * @returns 刷新完成后兑现的 Promise。
     * @throws 不抛出异常。
     */
    async refreshSessionsQuietly (): Promise<void> {
      try {
        await this.loadSessions()
      } catch {
        // 静默降级：列表是辅助入口，刷新失败不影响正在进行的对话。
      }
    },

    /**
     * 创建新会话并发送首条消息。
     *
     * @param message - 首条用户消息。
     */
    async startSession (message: string): Promise<void> {
      this.sending = true
      try {
        const sessionId = await createAgentSession(message)
        await this.openSession(sessionId)
        void this.loadSessions()
      } finally {
        this.sending = false
      }
    },

    /**
     * 打开会话：拉取历史工作块渲染时间线，并订阅实时事件流。
     *
     * @param sessionId - 会话 ID。
     */
    async openSession (sessionId: string): Promise<void> {
      this.detachStream()
      this.sessionId = sessionId
      // 复用归约器的历史恢复逻辑，保证与弹窗时间线的语义一致。
      clearTimeline(this.timelineState())
      this.fileChanges = []

      const { blocks, currentSeq } = await getAgentWorkBlocks(sessionId)
      resetWithBlocks(this.timelineState(), blocks, currentSeq)
      this.attachStream()
    },

    /**
     * 构造归约器可操作的状态视图。
     *
     * 数组与 Map 直接共享引用（归约器只做原地修改）；
     * 标量字段用取值器/赋值器代理回 store——若用普通属性复制，
     * 归约器对 lastSeq / activity 的写入会落在副本上，导致幂等去重失效。
     *
     * @returns 与 store 状态双向绑定的状态对象。
     */
    timelineState () {
      const store = this
      return {
        items: store.items,
        itemIndex: store.itemIndex,
        fileChanges: store.fileChanges,
        get lastSeq (): number {
          return store.lastSeq
        },
        set lastSeq (value: number) {
          store.lastSeq = value
        },
        get activity (): TAgentActivity {
          return store.activity
        },
        set activity (value: TAgentActivity) {
          store.activity = value
        },
        get activityLabel (): string | undefined {
          return store.activityLabel
        },
        set activityLabel (value: string | undefined) {
          store.activityLabel = value
        },
      }
    },

    /**
     * 在当前会话中发送新消息（续接新一轮）。
     *
     * @param message - 用户消息。
     */
    async sendMessage (message: string): Promise<void> {
      if (!this.sessionId) {
        await this.startSession(message)
        return
      }
      this.sending = true
      try {
        await sendAgentMessage(this.sessionId, message)
        // 发出去即刷新一次：列表的「运行中」状态与标题由服务端在轮次开始时更新，
        // 不刷新的话用户点完发送看到的仍是上一轮的终态。
        // 不 await：列表是旁路展示，不该拖住输入区解禁。
        void this.refreshSessionsQuietly()
      } finally {
        this.sending = false
      }
    },

    /** 中止当前会话的轮次。 */
    async abort (): Promise<void> {
      if (!this.sessionId) return
      await abortAgentSession(this.sessionId)
    },

    /** 离开工作台：断开事件流并清空时间线。 */
    dispose (): void {
      this.detachStream()
      this.sessionId = null
      clearTimeline(this.timelineState())
      this.fileChanges = []
      this.connection = 'offline'
    },

    /**
     * 视图卸载（v17 C7）：页面离开时调用，**不等于 dispose**。
     *
     * 有运行中的任务时保持 SSE 订阅——否则任务完成的事件根本到不了前端，
     * C7 的完成提示无从触发（技术方案 §7.3 的 F19）。没有任务在跑时按既有
     * 语义正常释放，避免留下一条无人使用的订阅。
     *
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    detachView (): void {
      this.viewAttached = false
      if (!this.hasRunningTask) {
        this.dispose()
      }
    },

    /** 订阅实时事件流（断线自动重连，重连带 afterSeq 补发）。 */
    attachStream (): void {
      if (!this.sessionId) return
      const sessionId = this.sessionId
      this.stream = subscribeAgentWorkStream(
        sessionId,
        () => (this.lastSeq > 0 ? this.lastSeq : undefined),
        {
          onEvent: (event) => this.applyEvent(event),
          onConnectionChange: (state) => {
            this.connection = state
          },
        },
      )
    },

    /** 断开实时事件流。 */
    detachStream (): void {
      this.stream?.close()
      this.stream = undefined
      this.connection = 'offline'
    },

    /**
     * 归并一条工作事件到时间线（幂等：seq <= lastSeq 直接丢弃）。
     *
     * 归约语义统一由 timeline/reducer 提供，与生成弹窗时间线保持一致。
     *
     * @param event - 客户端工作事件。
     */
    applyEvent (event: TAgentClientEvent): void {
      // 会话过滤属于 store 特有职责（弹窗版由独立实例天然隔离）。
      if (event.sessionId !== this.sessionId) return

      // 轮次结束＝服务端会话状态回落（running → idle），此时刷新列表最合适：
      // 状态与标题都已定型，且不会在本轮进行中反复请求。
      const wasRunning = this.activity !== 'idle'
      // 任务终态提示（C7）的判定要在归约**之前**取「变化前」的状态：归约器
      // 是就地改写的，归约后再读 items 只会看到新状态。
      const previousTaskStatus = this.taskStatusOf(event.blockId)
      applyEventToTimeline(this.timelineState(), event)

      const notice = this.buildTerminalNotice(event, previousTaskStatus)
      if (notice) {
        this.pendingNotice = notice
        // 终态到达且页面已离开：订阅使命完成，主动断开（C7 第 4 条）——
        // 否则会长期挂着一条无人消费的 SSE。
        if (!this.viewAttached) this.detachStream()
      }

      if (wasRunning && this.activity === 'idle') {
        void this.refreshSessionsQuietly()
      }
    },

    /**
     * 读取某个块当前的任务状态（v17 C7 的终态判定用）。
     *
     * @param blockId - 工作块 ID。
     * @returns 该块是 `workbench_task` 时的任务状态；否则 undefined。
     * @throws 不抛出异常。
     */
    taskStatusOf (blockId: string): string | undefined {
      const item = this.items.find((entry) => entry.blockId === blockId)
      return item?.kind === 'workbench_task' ? item.taskStatus : undefined
    },

    /**
     * 判断本次事件是否让任务从「运行中」落到终态，并组装待发布的提示。
     *
     * 判据是**状态迁移**而不是「当前是不是终态」：历史恢复时物化的终态块走的是
     * `resetWithBlocks` 而不是本函数，因此不会误报旧任务；而用户刚建好的
     * 批次卡片可能一上来就是终态（取消），那不是「跑完了」，也不该提示。
     *
     * @param event - 客户端工作事件。
     * @param previousTaskStatus - 归约前该块的任务状态。
     * @returns 待发布的提示；不构成「运行 → 终态」时返回 null。
     * @throws 不抛出异常。
     */
    buildTerminalNotice (
      event: TAgentClientEvent,
      previousTaskStatus: string | undefined,
    ): IPendingTerminalNotice | null {
      if (event.type !== 'workbench_task') return null
      if (event.status === 'running') return null
      if (previousTaskStatus !== 'running') return null
      return {
        sessionId: event.sessionId,
        skillId: event.skillId,
        skillTitle: event.skillTitle,
        taskKind: event.taskKind,
        taskStatus: event.status,
        ...(event.summary?.runId ? { runId: event.summary.runId } : {}),
      }
    },

    /**
     * 取走待发布的提示（宿主消费后置空，避免同一条提示重复弹出）。
     *
     * @returns 待发布的提示；没有时返回 null。
     * @throws 不抛出异常。
     */
    takePendingNotice (): IPendingTerminalNotice | null {
      const notice = this.pendingNotice
      this.pendingNotice = null
      return notice
    },
  },
})

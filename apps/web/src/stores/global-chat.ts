/**
 * Agent 工作台的应用级界面状态 store。
 *
 * 职责（本版起）：持有**工作台是否展开**与**当前显示主体**两项界面状态。
 *
 * v13 的两处关键变化：
 *
 * 1. **全局唯一实例**：工作台从 Skill 开发页上移到应用外壳，因此它的
 *    「展开 / 收起」与「承载谁」都是应用级状态，不再与任何路由绑定。
 * 2. **显示主体取代路由派生**：v9 用 `route.params.skillId` 判断「当前是哪个
 *    Skill」，离开 Skill 开发页即失效。本版改为显式记录主体（`subject`），
 *    由发起动作确定，此后不随用户所在页面变化（PRD E-3）。
 *
 * 为什么只放界面状态、不放进度数据：工作项的进度仍由各自的 store 持有
 * （生成在 `generation-flow`，执行在 `execution`）。若在此复制一份，
 * 同一份事实就会有两个来源，二者迟早分叉。
 *
 * 为什么本 store 不 import 任何业务 store：`generation-flow` 已经 import 本
 * store（用于 expand / collapse），反向 import 会形成模块环。跨 store 的编排
 * 放在 `modules/agent-work/workbench-subject.ts`，由组件调用。
 */
import { defineStore } from 'pinia'

/** 工作台当前承载的工作项种类（PRD §4.2 C-1：同一时刻只有一种）。 */
export type TWorkbenchSubjectKind = 'generation' | 'execution'

/**
 * 工作台的显示主体：同一时刻只有一个（PRD §4.2 C-1）。
 *
 * 只承载「是谁」与「跳到哪」，不承载进度数据（进度在各自的 store 里）。
 */
export interface IWorkbenchSubject {
  /** 工作项种类。 */
  kind: TWorkbenchSubjectKind
  /** 来源 Skill（PRD E-3）。 */
  skillId: string
  /** 来源 Skill 标题；生成侧无标题数据时缺省。 */
  skillTitle?: string
  /**
   * 执行工作项的展示键（仅 `kind === 'execution'` 时存在）。
   *
   * 记录它才能区分「同一次执行」与「同一 Skill 的另一次执行」：
   * 执行记录按 Skill 存放，新执行会覆盖旧记录（技术方案 F10）。
   */
  executionId?: string
}

export const useGlobalChatStore = defineStore('global-chat', {
  state: () => ({
    /** 工作台是否展开。 */
    visible: false,
    /** 当前显示主体；null 表示空态（PRD §4.2 C-1、§5.2）。 */
    subject: null as IWorkbenchSubject | null,
  }),

  getters: {
    /** 是否存在工作项（空态判定与底部操作区显隐的依据，PRD B-3）。 */
    hasSubject(state): boolean {
      return state.subject !== null
    },
  },

  actions: {
    /**
     * 展开工作台。
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    expand(): void {
      this.visible = true
    },

    /**
     * 收起工作台；仅隐藏界面，不影响正在运行的任务与已承载的内容。
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    collapse(): void {
      this.visible = false
    },

    /**
     * 切换工作台展开 / 收起。
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    toggle(): void {
      this.visible = !this.visible
    },

    /**
     * 设置显示主体（新工作项真正启动后调用，PRD §4.2 C-2）。
     *
     * @param subject - 新的显示主体。
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    setSubject(subject: IWorkbenchSubject): void {
      this.subject = subject
    },

    /**
     * 丢弃显示主体（回到空态），**不触碰任何进度 store**。
     *
     * 清空执行工作项时只丢引用、不删执行记录——那些记录与 `/agent` 页的
     * 卡片共享（技术方案 F19/R-5）。生成侧的内容销毁由调用方另行处理。
     *
     * @returns 无返回值。
     * @throws 不抛出异常。
     */
    dropSubject(): void {
      this.subject = null
    },
  },
})

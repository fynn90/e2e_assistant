/**
 * 实时保存编排：防抖、合并、串行、跳过无变化、退避重试与收尾 flush。
 *
 * 三个不变式（PRD 7.3 的性能要求）：
 *
 * | 不变式       | 实现方式                                                         |
 * | ------------ | ---------------------------------------------------------------- |
 * | 输入永不阻塞 | `markDirty()` 只写本地状态 + 重置定时器，**不 await 任何 Promise** |
 * | 合并请求     | 防抖窗口内的多次 `markDirty()` 只重置同一个定时器                  |
 * | 串行发送     | `drain()` 入口的 `inFlight` 卫兵保证同一时刻只有一个请求在途        |
 *
 * 失败语义（PRD 7.5）：`failed` / `conflict` 状态下**从不回滚编辑器本地内容**，
 * 用户输入永远保留在屏幕上，只有用户显式选择「重新加载」才会用磁盘内容覆盖。
 */
import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import type { IEnvFileIssue } from '@authine-e2e-agent/types'
import { ApiClientError } from '../../services/http-client'
import type { ISaveTarget, ISaveTargetResult, TAutoSaveState } from './types'
import { isBlockedError, isConflictError } from './types'

/** 防抖窗口：停止输入 800ms 后才发起保存（PRD 7.3）。 */
const DEBOUNCE_MS = 800

/** 退避重试间隔：1s → 2s → 4s，最多 3 次（PRD 7.5）。 */
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const

export interface IUseAutoSaveOptions {
  /**
   * 读取当前编辑器内容。
   *
   * 每次 drain 都重新调用（而非由调用方缓存），这样保存期间的新改动
   * 能在下一轮被自动合并发送。
   */
  getContent: () => string
  /** 保存目标；为 null 时不可保存（只读、孤儿文件或未选中文件）。 */
  target: Ref<ISaveTarget | null> | ComputedRef<ISaveTarget | null>
  /** 保存成功回调（回填版本、刷新文件树等）。 */
  onSaved?: (result: ISaveTargetResult, content: string) => void
  /** 用户点击「重新加载」：放弃本地改动，由调用方重新拉取磁盘内容。 */
  onReload?: () => void | Promise<void>
  /**
   * 宿主组件卸载时是否自动释放（默认 `true`）。
   *
   * 为什么需要这个开关（v13 PRD R-6）：默认值依赖 `getCurrentInstance()`
   * ——在组件 `setup` 中创建会挂上卸载钩子，在**事件处理器**中创建则不会
   * （实测：`getCurrentInstance()` 在事件处理器中为 `null`）。这让「实例何时
   * 被释放」取决于调用点所在的上下文，同一段代码移动位置就会改变行为。
   *
   * 工作台的产物卡片需要**跨页面存活**（用户离开 Skill 开发页后仍能编辑与保存），
   * 因此 store 中的调用方显式传 `false`，改由 store 的 `reset()` 统一释放。
   */
  autoDispose?: boolean
}

export interface IUseAutoSave {
  /** 当前保存状态。 */
  state: Ref<TAutoSaveState>
  /** 最近一次校验诊断。 */
  diagnostics: Ref<
    readonly import('@authine-e2e-agent/types').IFileSaveDiagnostic[]
  >
  /**
   * 最近一次校验阻断的问题明细（blocked 态专属，v10 PRD 5.3）。
   *
   * 由保存目标适配器携带（客户端主路径）或服务端响应透传（兜底路径）；
   * 供 env.json 编辑页的校验反馈区渲染「行:列 + 原因」。非 blocked 态为空。
   */
  blockedIssues: Ref<IEnvFileIssue[]>
  /** 最近一次失败的错误信息（用于错误条文案）。 */
  errorMessage: Ref<string>
  /** 是否存在未落盘的改动（防抖窗口内或失败态）。 */
  dirty: ComputedRef<boolean>
  /** 目标是否可保存（只读 / 孤儿 / 未选中时为 false）。 */
  canSave: ComputedRef<boolean>
  /**
   * 标记本地内容已变化。
   *
   * **同步返回、不 await 任何 Promise**——编辑器绑定本地 ref，
   * 输入上屏与保存完全解耦（PRD 7.3「输入永不阻塞」）。
   */
  markDirty: () => void
  /** 立即发起保存并等待完成（Ctrl+S / 页头保存按钮）。 */
  saveNow: () => Promise<boolean>
  /** 静默 flush 待发改动；用于关闭侧边栏、切换文件、页面卸载前。 */
  flushSilently: () => Promise<void>
  /** 用户选择「重试保存」。 */
  retry: () => Promise<boolean>
  /** 用户选择「重新加载」：放弃本地改动。 */
  reload: () => Promise<void>
  /** 用户选择「覆盖保存」：用本地内容覆盖磁盘。 */
  overwrite: () => Promise<boolean>
  /**
   * 用磁盘内容重置保存基准。
   *
   * 调用方完成「重新加载」后调用，使「跳过无变化」判定以新的磁盘内容为参照。
   *
   * @param content - 磁盘上的最新正文。
   * @param version - 磁盘版本（供调用方回填文件版本）。
   */
  syncFromDisk: (content: string, version: string) => void
  /** 释放实例（中止在途请求并停止定时器）。 */
  dispose: () => void
}

/**
 * 创建实时保存编排实例。
 *
 * @param options - 内容读取器、保存目标与保存成功/重新加载回调。
 * @returns 状态、诊断与操作方法。
 * @throws 不抛出异常；保存失败通过状态与 errorMessage 体现。
 */
export function useAutoSave(options: IUseAutoSaveOptions): IUseAutoSave {
  const state = ref<TAutoSaveState>('saved')
  const diagnostics = ref<
    readonly import('@authine-e2e-agent/types').IFileSaveDiagnostic[]
  >([])
  const blockedIssues = ref<IEnvFileIssue[]>([])
  const errorMessage = ref('')

  /** 最近一次成功保存的内容：用于「跳过无变化」判定（PRD 7.3）。 */
  let lastSavedContent: string | null = null
  /** 防抖定时器。 */
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 串行卫兵：同一时刻只允许一个 drain 在途。 */
  let inFlight: Promise<void> | null = null
  /** 每次保存尝试独立的取消信号。 */
  let controller = new AbortController()
  let disposed = false

  const canSave = computed(() => options.target.value !== null)
  const dirty = computed(() => state.value !== 'saved' || hasPendingChanges())

  /**
   * 判断当前内容是否与最近一次成功保存的内容不同。
   *
   * @returns 内容有差异时返回 true。
   */
  function hasPendingChanges(): boolean {
    return (
      lastSavedContent !== null && options.getContent() !== lastSavedContent
    )
  }

  /**
   * 记录一次成功保存并同步状态。
   *
   * @param content - 本次发送的正文。
   * @param result - 保存目标返回的版本与诊断。
   */
  function acceptSaved(content: string, result: ISaveTargetResult): void {
    lastSavedContent = content
    diagnostics.value = result.diagnostics
    blockedIssues.value = []
    errorMessage.value = ''
    options.onSaved?.(result, content)
  }

  /**
   * 判断当前内容是否已与磁盘一致（用于「跳过无变化」）。
   *
   * @returns 无变化时返回 true。
   */
  function isUnchanged(): boolean {
    return (
      lastSavedContent !== null && options.getContent() === lastSavedContent
    )
  }

  /**
   * 提取校验阻断异常携带的问题明细。
   *
   * @param error - 捕获到的异常。
   * @returns 问题明细；异常未携带时返回空数组。
   */
  function extractBlockedIssues(error: unknown): IEnvFileIssue[] {
    if (error && typeof error === 'object' && 'issues' in error) {
      const issues = (error as { issues?: unknown }).issues
      return Array.isArray(issues) ? (issues as IEnvFileIssue[]) : []
    }
    return []
  }

  /**
   * 进入校验阻断态（v10 PRD 5.3）。
   *
   * 与冲突同类：内容非法时重试必然再次失败，只有用户修改才能推进，
   * 因此直接落态、不进入退避重试。本地内容不回滚——用户修正后再次保存即恢复；
   * 反馈区（blockedIssues）即该状态的专属呈现，不重复显示「保存失败」错误条。
   *
   * @param error - 校验阻断异常。
   * @returns 固定返回 false：退出 drain 循环。
   */
  function enterBlockedState(error: unknown): false {
    state.value = 'blocked'
    blockedIssues.value = extractBlockedIssues(error)
    // 问题明细缺失时（如版本偏差下的服务端兜底拒绝），退回通用错误文案。
    errorMessage.value =
      blockedIssues.value.length === 0 ? describeError(error) : ''
    return false
  }

  /**
   * 保存失败分流。
   *
   * 校验阻断与冲突都不做退避重试（重试必然再次失败，只有用户决策才能推进）；
   * 其它失败按 1s/2s/4s 退避重试，耗尽后转 `failed` 等待用户显式重试。
   *
   * @param error - 捕获到的异常。
   * @returns 已通过重试恢复时返回 true；需要退出 drain 循环时返回 false。
   */
  async function handleFailure(error: unknown): Promise<boolean> {
    if (isConflictError(error)) {
      state.value = 'conflict'
      errorMessage.value = '文件已被外部修改，请选择重新加载或覆盖保存。'
      return false
    }

    // 校验阻断（v10）：本地内容非法，重试无意义，直接落 blocked 态。
    if (isBlockedError(error)) {
      return enterBlockedState(error)
    }

    for (const delay of RETRY_DELAYS_MS) {
      await sleep(delay)
      if (disposed || controller.signal.aborted) return false

      try {
        const content = options.getContent()
        const target = options.target.value
        if (!target) return false
        const result = await target.save(content, controller.signal)
        acceptSaved(content, result)
        state.value = hasPendingChanges() ? 'pending' : 'saved'
        return true
      } catch (retryError) {
        if (isConflictError(retryError)) {
          state.value = 'conflict'
          errorMessage.value = '文件已被外部修改，请选择重新加载或覆盖保存。'
          return false
        }
        if (isBlockedError(retryError)) {
          return enterBlockedState(retryError)
        }
      }
    }

    state.value = 'failed'
    errorMessage.value = describeError(error)
    return false
  }

  /**
   * 串行排空待发改动。
   *
   * 循环处理「保存期间又发生的新改动」：每次发送前重新读取内容，
   * 发送后若内容已变则进入下一轮，把多次改动合并为一次请求。
   *
   * @returns 排空完成后的 Promise。
   */
  async function drain(): Promise<void> {
    if (inFlight) return inFlight

    inFlight = (async () => {
      try {
        while (true) {
          const target = options.target.value
          if (!target) {
            state.value = lastSavedContent === null ? 'saved' : 'pending'
            break
          }

          // 跳过无变化：内容与上次成功保存一致则不发起请求（PRD 7.3）。
          if (isUnchanged()) {
            state.value = 'saved'
            break
          }

          const content = options.getContent()
          state.value = 'saving'

          try {
            const result = await target.save(content, controller.signal)
            acceptSaved(content, result)

            // 若保存期间用户又改了，继续下一轮（合并后的下一次保存）。
            if (options.getContent() === content) {
              state.value = 'saved'
              break
            }
            state.value = 'pending'
          } catch (error) {
            if (controller.signal.aborted) return
            if (!(await handleFailure(error))) break
          }
        }
      } finally {
        inFlight = null
      }
    })()

    return inFlight
  }

  /** 清除待触发的防抖定时器。 */
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function markDirty(): void {
    errorMessage.value = ''
    state.value = 'pending'
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void drain()
    }, DEBOUNCE_MS)
  }

  /**
   * 立即保存并等待完成。
   *
   * @returns 保存成功时返回 true；失败/冲突/无目标时返回 false。
   */
  async function saveNow(): Promise<boolean> {
    clearTimer()
    if (!options.target.value) return false
    if (isUnchanged()) {
      state.value = 'saved'
      return true
    }
    await drain()
    return state.value === 'saved'
  }

  /**
   * 静默 flush：等待待发改动写完，失败不打扰用户。
   *
   * 用于关闭侧边栏、切换文件、页面卸载前（PRD 7.6）。
   *
   * @returns 排空完成后的 Promise。
   */
  async function flushSilently(): Promise<void> {
    clearTimer()
    if (!options.target.value) return
    if (isUnchanged()) return
    await drain()
  }

  /** 用户点击「重试保存」。 */
  async function retry(): Promise<boolean> {
    errorMessage.value = ''
    return saveNow()
  }

  /** 用户选择「重新加载」：放弃本地改动，重新拉取磁盘内容。 */
  async function reload(): Promise<void> {
    clearTimer()
    state.value = 'saved'
    diagnostics.value = []
    blockedIssues.value = []
    errorMessage.value = ''
    lastSavedContent = null
    await options.onReload?.()
  }

  /**
   * 用户选择「覆盖保存」：用本地内容覆盖磁盘。
   *
   * 服务端始终执行版本校验，因此做法是重置本地版本基准后重新保存——
   * 若磁盘确实已被外部修改，服务端仍会返回冲突，此时提示用户先重新加载。
   */
  async function overwrite(): Promise<boolean> {
    // 把基准清空，使「跳过无变化」判定不会误判为已同步。
    lastSavedContent = null
    return saveNow()
  }

  /**
   * 用磁盘内容重置基准（调用方完成重新加载后调用）。
   *
   * @param content - 磁盘上的最新正文。
   * @param version - 磁盘版本（保留参数以便调用方回填文件版本）。
   */
  function syncFromDisk(content: string, version: string): void {
    void version
    lastSavedContent = content
    state.value = 'saved'
    diagnostics.value = []
    blockedIssues.value = []
    errorMessage.value = ''
  }

  // 切换保存目标即换文件：中止在途请求、清空基准，避免旧结果写回新文件。
  //
  // 必须 `flush: 'sync'`：默认的 pre 时机把重置推迟到下一个 tick，会清掉
  // 切换后同一 tick 内 markDirty() 刚设好的防抖定时器，导致这次输入被静默丢弃。
  watch(
    () => options.target.value?.key ?? null,
    () => {
      controller.abort()
      controller = new AbortController()
      clearTimer()
      lastSavedContent = null
      diagnostics.value = []
      blockedIssues.value = []
      errorMessage.value = ''
      state.value = 'saved'
    },
    { flush: 'sync' },
  )

  /**
   * 释放实例：中止在途请求并停止定时器。
   *
   * 在 store 中创建实例时（不存在活动组件）由调用方显式释放；
   * 组件内创建时随卸载自动释放。
   */
  function dispose(): void {
    disposed = true
    clearTimer()
    controller.abort()
  }

  // 显式关闭自动释放，或当前不在组件上下文中，则交由调用方释放。
  const wantAutoDispose = options.autoDispose !== false
  if (wantAutoDispose && getCurrentInstance()) onBeforeUnmount(dispose)

  return {
    state,
    diagnostics,
    blockedIssues,
    errorMessage,
    dirty,
    canSave,
    markDirty,
    saveNow,
    flushSilently,
    retry,
    reload,
    overwrite,
    syncFromDisk,
    dispose,
  }
}

/**
 * 把未知异常转换为面向用户的失败文案。
 *
 * @param error - 捕获到的异常。
 * @returns 可展示的错误信息。
 */
function describeError(error: unknown): string {
  if (error instanceof ApiClientError) return error.message
  return error instanceof Error ? error.message : '保存失败。'
}

/**
 * 等待指定毫秒数。
 *
 * @param ms - 等待时长。
 * @returns 计时结束后的 Promise。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

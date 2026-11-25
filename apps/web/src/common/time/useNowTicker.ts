/**
 * 每秒推进的响应式「当前时间」，供运行中的时长计数展示使用。
 *
 * **为什么需要它**：Agent 工作事件流是**离散**的——思考块只在 `append` 时下发
 * 事件，模型推理静默期与工具执行期间都不会有任何事件到达。因此「已思考 N 秒」
 * 这类文案若只依赖事件驱动更新，会在静默期**卡住不动**，与「实时」的承诺相违。
 * 必须有一个定时器独立推进时间。
 *
 * **职责边界**：本模块**只提供时间，不含任何业务语义**——它不知道什么是阶段、
 * 什么是思考块，只负责按间隔给出当前的毫秒时间戳。要不要用、怎么算时长，全部
 * 由调用方决定（例如 `summarizeStage` 把 `now` 作为显式入参，从而保持纯函数可测）。
 */
import {
  getCurrentInstance,
  onBeforeUnmount,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'

/** 默认轮询间隔：1 秒，与「已思考 N 秒」的展示精度一致。 */
const DEFAULT_INTERVAL_MS = 1000

/** useNowTicker 的入参。 */
export interface IUseNowTickerOptions {
  /**
   * 是否运行。
   *
   * 为 false 时**不持有定时器**，`now` 停在最后一次的值上。调用方应把「是否
   * 还需要计时」的判断放在这里（如阶段到达终态后停止），避免无谓的每秒重渲染。
   */
  enabled: Ref<boolean> | ComputedRef<boolean>
  /** 轮询间隔（毫秒），默认 1000。 */
  intervalMs?: number
}

/** useNowTicker 的返回值。 */
export interface IUseNowTicker {
  /** 当前时间的毫秒时间戳；`enabled` 为 false 时停留在最后值。 */
  now: Ref<number>
  /** 停止计时并释放定时器（组件卸载时自动调用）。 */
  dispose: () => void
}

/**
 * 创建一个按固定间隔推进的响应式当前时间。
 *
 * 定时器仅在 `enabled` 为 true 时存在：转为 false 立即清除，避免阶段结束后
 * 仍在后台每秒触发一次组件重渲染。
 *
 * @param options - 启用条件与轮询间隔。
 * @returns 当前时间引用与释放方法。
 * @throws 不抛出异常。
 */
export function useNowTicker(options: IUseNowTickerOptions): IUseNowTicker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  /** 清除定时器（不存在时安全空转）。 */
  function stop(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  /** 启动定时器并立刻对齐一次当前时间。 */
  function start(): void {
    // 立刻取一次而非等第一个间隔：否则从启动到首个 tick 之间（最长 1 秒）
    // `now` 仍是旧值，秒数会肉眼可见地「第一秒不动」。
    now.value = Date.now()
    stop()
    timer = setInterval(() => {
      now.value = Date.now()
    }, intervalMs)
  }

  // `immediate`：挂载时阶段可能已在运行（侧边栏收起期间任务继续跑），
  // 此时应立即开始计时，而不是等到下一次 enabled 变化。
  watch(
    () => options.enabled.value,
    (enabled) => {
      if (enabled) start()
      else stop()
    },
    { immediate: true },
  )

  /**
   * 停止计时并释放（幂等）。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function dispose(): void {
    stop()
  }

  // 组件内使用时随组件卸载释放；在 store / 模块作用域创建时不存在活动组件实例，
  // 此时由调用方显式 dispose。
  if (getCurrentInstance()) onBeforeUnmount(dispose)

  return { now, dispose }
}

/**
 * 工作台的任务中断守卫（v13 需求 1）。
 *
 * 工作台的任务在**服务端**运行，但生成的运行轮次依赖前端的流式连接
 * （技术方案 §3.5）：刷新或关闭页签会断开该连接，服务端随即终止生成。
 * 执行同理——前端断开虽不终止服务端进程，但用户会失去对整个过程的观察。
 *
 * 因此当有任务在跑时，必须在页签被刷新/关闭前提醒用户。这正是
 * `beforeunload` 的用途：它能触发浏览器的原生确认对话框。
 *
 * **与 `useUnloadGuard` 的区别**（不要合并）：
 *   - `useUnloadGuard` 守的是「**未保存的编辑**」，脏判定为真时才提醒，
 *     并在卸载前尽力触发一次保存；
 *   - 本守卫守的是「**正在运行的 Agent 任务**」，与编辑无关，
 *     也不需要在卸载前抢救什么（任务由服务端持有，前端无能为力）。
 *
 * 限制（如实记录）：浏览器不允许自定义确认文案，只能显示其内置提示；
 * 本模块的 message 仅用于测试与文档，不会出现在对话框里。
 */
import { getCurrentInstance, onBeforeUnmount } from 'vue'

export interface IUseWorkbenchUnloadGuardOptions {
  /**
   * 当前是否有 Agent 任务在运行。
   *
   * 由调用方提供而非本模块自行读取 store：判定涉及生成与执行两个 store
   * 以及「主体」概念，让本模块保持无业务依赖才能独立测试。
   */
  isWorking: () => boolean
}

/**
 * 注册「任务进行中离开页面」的提醒守卫。
 *
 * @param options - 任务运行判定。
 * @returns 无返回值；守卫在组件卸载时自动移除。
 * @throws 不抛出异常。
 */
export function useWorkbenchUnloadGuard(
  options: IUseWorkbenchUnloadGuardOptions,
): void {
  /**
   * 页签即将卸载（刷新 / 关闭 / 跳转到站外）时的确认。
   *
   * 浏览器只在 `preventDefault()` + `returnValue` 同时设置时才弹出确认框；
   * 这是唯一能拦住用户的手段，文案由浏览器决定。
   */
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!options.isWorking()) return
    event.preventDefault()
    // 兼容旧式浏览器：部分实现要求给 returnValue 赋非空值才弹确认。
    event.returnValue = ''
  }

  // 只监听 beforeunload：pagehide / visibilitychange 在**切换页签**时也会触发，
  // 而需求明确限定为「刷新或关闭」，切走再切回并不会中断任务（服务端照常跑）。
  window.addEventListener('beforeunload', beforeUnload)

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      window.removeEventListener('beforeunload', beforeUnload)
    })
  }
}

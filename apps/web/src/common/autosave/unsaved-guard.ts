/**
 * 实时保存的页面卸载守卫。
 *
 * `beforeunload` / `pagehide` 是保存链路的**最后一道提示**，而不是主要保障——
 * 浏览器不允许在卸载时等待异步请求，因此这里只把请求发出去、不等待结果。
 * 真正的保障是「每次改动后 800ms 内落盘」使待发窗口极小（v9 PRD 7.6）。
 *
 * 路由切换的守卫不在此模块：它需要区分结构化编辑器与文本文件两类草稿语义，
 * 由 `useSkillDevelopment` 结合自身状态处理（避免本模块反向依赖业务）。
 */
import { getCurrentInstance, onBeforeUnmount } from 'vue'

export interface IUseUnloadGuardOptions {
  /** 当前是否存在未落盘的本地改动。 */
  isDirty: () => boolean
  /**
   * 尽力触发一次保存。
   *
   * 实现方**不得**依赖其完成：浏览器可能在请求发出后立即销毁页面上下文。
   *
   * @returns 保存尝试的 Promise（调用方不等待）。
   */
  flush: () => Promise<void>
}

/**
 * 注册页面卸载守卫。
 *
 * @param options - 脏判定与尽力而为的保存动作。
 * @returns 无返回值；守卫在组件卸载时自动移除。
 */
export function useUnloadGuard(options: IUseUnloadGuardOptions): void {
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!options.isDirty()) return

    // 尽力而为地触发保存：不 await（浏览器不允许卸载时等待异步请求）。
    void options.flush()
    event.preventDefault()
    event.returnValue = ''
  }

  /**
   * 页面隐藏/进入后台时也尝试落盘。
   *
   * 移动端与「切标签页」场景下 `pagehide` 比 `beforeunload` 更可靠，
   * 且没有确认弹窗的副作用。
   */
  const onPageHide = (): void => {
    if (!options.isDirty()) return
    void options.flush()
  }

  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('pagehide', onPageHide)

  // 仅在存在活动组件实例时注册清理，避免在非组件上下文触发 Vue 警告。
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('pagehide', onPageHide)
    })
  }
}

/** 便于调用方在无组件上下文时手动清理。 */
export type TUnloadGuardCleanup = () => void

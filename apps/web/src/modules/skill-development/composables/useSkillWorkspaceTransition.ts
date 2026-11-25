/**
 * 管理 Skill 子工作区的路由切换动画与显式 Chat 聚焦时机。
 */
import {
  nextTick,
  onBeforeUnmount,
  readonly,
  shallowRef,
  type ShallowRef,
} from 'vue'
import { useRoute, useRouter, type RouteLocationNormalized } from 'vue-router'
import { parseSkillDevelopmentWorkspaceTarget } from '../../../router/skill-development-navigation'
import type { IChatPanelHandle } from '../types'

export type TSkillWorkspaceTransitionName =
  'skill-workspace-panel' | 'skill-workspace-none'

interface IPendingChatFocus {
  skillId: string
  trigger: Element | null
}

export interface IUseSkillWorkspaceTransitionOptions {
  getChatPanelHandle(): IChatPanelHandle | null
  getActiveElement?: () => Element | null
}

export interface IUseSkillWorkspaceTransition {
  transitionName: Readonly<ShallowRef<TSkillWorkspaceTransitionName>>
  queueChatFocus(): void
  cancelPendingChatFocus(): void
  handleAfterEnter(): Promise<void>
}

/**
 * 创建同一 Skill 内工作区面板切换与安全焦点恢复能力。
 * @param options Chat 句柄和当前焦点读取函数。
 * @returns 只读动画名称、Chat 聚焦队列和入场完成处理函数。
 * @throws 不抛出异常。
 */
export function useSkillWorkspaceTransition(
  options: IUseSkillWorkspaceTransitionOptions,
): IUseSkillWorkspaceTransition {
  const route = useRoute()
  const router = useRouter()
  const transitionName = shallowRef<TSkillWorkspaceTransitionName>(
    'skill-workspace-none',
  )
  const getActiveElement =
    options.getActiveElement ?? (() => document.activeElement)
  let pendingChatFocus: IPendingChatFocus | null = null

  const removeAfterEach = router.afterEach((to, from, failure) => {
    transitionName.value = shouldAnimateWorkspaceChange(
      to,
      from,
      Boolean(failure),
    )
      ? 'skill-workspace-panel'
      : 'skill-workspace-none'

    if (failure) {
      cancelPendingChatFocus()
    }
  })

  onBeforeUnmount(() => {
    removeAfterEach()
    cancelPendingChatFocus()
  })

  /**
   * 记录由用户显式触发的 Chat 聚焦意图，等待目标面板完成入场。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function queueChatFocus(): void {
    pendingChatFocus = {
      skillId: getRouteSkillId(route),
      trigger: getActiveElement(),
    }
  }

  /**
   * 清除尚未执行的 Chat 聚焦意图。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function cancelPendingChatFocus(): void {
    pendingChatFocus = null
  }

  /**
   * 在工作区入场完成后执行仍然有效且不会抢夺其他控件焦点的 Chat 聚焦。
   * @returns DOM 更新和焦点判断完成后兑现的 Promise。
   * @throws 不抛出异常。
   */
  async function handleAfterEnter(): Promise<void> {
    const pendingFocus = pendingChatFocus
    if (!pendingFocus) return

    await nextTick()

    const target = parseSkillDevelopmentWorkspaceTarget(route)
    const activeElement = getActiveElement()
    const focusAllowed =
      target?.panel === 'chat' &&
      getRouteSkillId(route) === pendingFocus.skillId &&
      isChatFocusAllowed(activeElement, pendingFocus.trigger)

    pendingChatFocus = null

    if (focusAllowed) {
      options.getChatPanelHandle()?.focusComposer()
    }
  }

  return {
    transitionName: readonly(transitionName),
    queueChatFocus,
    cancelPendingChatFocus,
    handleAfterEnter,
  }
}

/**
 * 判断一次已完成路由导航是否应使用工作区面板动画。
 * @param to 已完成导航的目标路由。
 * @param from 导航前路由。
 * @param failed 导航是否被取消、终止或以其他方式失败。
 * @returns 仅同一 Skill 的有效跨面板导航返回 true。
 * @throws 不抛出异常。
 */
function shouldAnimateWorkspaceChange(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  failed: boolean,
): boolean {
  if (failed || to.redirectedFrom) return false

  const toSkillId = getRouteSkillId(to)
  const fromSkillId = getRouteSkillId(from)
  if (!toSkillId || toSkillId !== fromSkillId) return false

  const toTarget = parseSkillDevelopmentWorkspaceTarget(to)
  const fromTarget = parseSkillDevelopmentWorkspaceTarget(from)

  return Boolean(toTarget && fromTarget && toTarget.panel !== fromTarget.panel)
}

/**
 * 读取规范化路由中的单值 Skill ID。
 * @param routeLocation 待读取的规范化路由。
 * @returns 有效字符串 Skill ID；缺失或为数组时返回空字符串。
 * @throws 不抛出异常。
 */
function getRouteSkillId(
  routeLocation: Pick<RouteLocationNormalized, 'params'>,
): string {
  return typeof routeLocation.params.skillId === 'string'
    ? routeLocation.params.skillId
    : ''
}

/**
 * 判断入场完成时是否仍可响应原始 Chat 操作移动焦点。
 * @param activeElement 当前活动元素。
 * @param trigger 触发 Chat 操作时的活动元素。
 * @returns 焦点未被用户移动到其他交互目标时返回 true。
 * @throws 不抛出异常。
 */
function isChatFocusAllowed(
  activeElement: Element | null,
  trigger: Element | null,
): boolean {
  return (
    activeElement === null ||
    activeElement === document.body ||
    activeElement === document.documentElement ||
    activeElement === trigger ||
    Boolean(trigger && trigger.contains(activeElement))
  )
}

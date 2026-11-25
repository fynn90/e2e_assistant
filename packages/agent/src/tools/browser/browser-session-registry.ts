/**
 * 浏览器会话注册表：把「某个生成会话当前可用的浏览器宿主」暴露给 Agent 配置工厂。
 *
 * 设计动机（v7-technical-design 3「依赖倒转」）：
 *   - browser_navigate / browser_snapshot / browser_query 是普通 AgentTool，
 *     在会话创建时装配进工具列表，但浏览器会话的生命周期由 CLI 的
 *     generation-runtime 拥有（它才知道 Chromium 是否可用、何时该释放）。
 *   - 两者唯一能对齐的是 sessionId：任务运行器在构建 Agent 配置时会传入它。
 * 因此本模块用 sessionId 作为接缝：运行时在生成任务开始前 register，
 * 任务结束后 unregister；配置工厂据此决定是否注入浏览器工具。
 *
 * 未注册浏览器宿主的会话（例如普通 Chat、SKILL.md 生成）不会获得浏览器工具，
 * 从而保证 Agent 只能在显式授权的生成任务中访问目标页面（PRD 4.2）。
 */

import type { IBrowserSessionHost } from './Browser_session'

/**
 * 浏览器会话注册表接口。
 *
 * 实现必须是进程内单例语义：同一 sessionId 的注册与查询发生在不同调用栈
 * （CLI 编排层注册，Agent 配置工厂查询），因此不能依赖请求级作用域。
 */
export interface IBrowserSessionRegistry {
  /**
   * 为指定生成会话登记浏览器宿主。
   *
   * @param sessionId - 生成会话 ID（与 SSE start 事件下发的一致）。
   * @param host - 已启动的浏览器会话宿主。
   * @returns 无返回值；同一 sessionId 重复注册会覆盖旧值。
   * @throws 不抛出异常。
   */
  register(sessionId: string, host: IBrowserSessionHost): void
  /**
   * 查询指定会话的浏览器宿主。
   *
   * @param sessionId - 生成会话 ID。
   * @returns 已登记的宿主；未登记时返回 undefined。
   * @throws 不抛出异常。
   */
  get(sessionId: string): IBrowserSessionHost | undefined
  /**
   * 注销指定会话的浏览器宿主。
   *
   * @param sessionId - 生成会话 ID。
   * @returns 无返回值；未登记时安全无操作。
   * @throws 不抛出异常。
   */
  unregister(sessionId: string): void
}

/**
 * 创建进程内浏览器会话注册表。
 *
 * @returns 可供 CLI 编排层与 Agent 配置工厂共享的注册表实例。
 * @throws 不抛出异常。
 */
export function createBrowserSessionRegistry(): IBrowserSessionRegistry {
  const hosts = new Map<string, IBrowserSessionHost>()

  return {
    register(sessionId: string, host: IBrowserSessionHost): void {
      hosts.set(sessionId, host)
    },

    get(sessionId: string): IBrowserSessionHost | undefined {
      return hosts.get(sessionId)
    },

    unregister(sessionId: string): void {
      // 生成任务结束后必须注销：否则同 ID 会话复活时会拿到已关闭的浏览器宿主。
      hosts.delete(sessionId)
    },
  }
}

/**
 * 默认注册表：由 Agent 配置工厂在装配工具时查询。
 *
 * 平台内只有 CLI 一个消费方，且注册与查询跨越不同模块，
 * 因此使用模块级单例而非参数传递；测试可通过 createBrowserSessionRegistry
 * 构造独立实例，或直接向本单例注册后清理。
 */
export const browserSessionRegistry: IBrowserSessionRegistry =
  createBrowserSessionRegistry()

/**
 * 优雅关闭端点：`POST /api/shutdown`。
 *
 * 存在的理由（PRD v19 §4.4）：Windows 上 `process.kill(pid, 'SIGTERM')` 是硬杀，
 * 目标的信号处理器根本不会执行，因此 `e2e_assistant stop` 需要一个「请服务自行收尾」
 * 的通道。端点只做三件事：校验凭据 → 应答 202 → 通知宿主（CLI）执行关闭。
 *
 * 边界（v18 原则二不破）：本模块不含 `process.exit` / `process.kill` / 信号处理器。
 * 关闭序列与进程退出由宿主决定——端点只负责「通知」。
 *
 * 注册位置（不可移动）：必须注册在 `app.all('/api/*')` 兜底**之前**——
 * 先注册的兜底会遮蔽后注册的精确路由（技术方案 M3，实测 404）。
 */
import { Hono } from 'hono'
import type { IApiSuccessResponse } from '@fynn90-e2e_assistant/types'
import type { IAppEnv } from '../app-types'
import { ApiError } from '../../shared/errors/api-error'

/**
 * 应答写回客户端后再触发关闭的延迟。
 *
 * 关闭序列会强制关闭全部连接（含本请求的连接），因此必须让 202 先落到客户端，
 * 否则 `stop` 会把「连接被重置」误判为端点不可用。
 */
export const SHUTDOWN_RESPONSE_FLUSH_DELAY_MS = 100

/** 携带一次性凭据的请求头名称。 */
export const SHUTDOWN_TOKEN_HEADER = 'x-authine-shutdown-token'

export interface IShutdownRouteOptions {
  /** 一次性凭据；由调用方（CLI）生成并随运行态记录保存。 */
  token: string
  /** 校验通过并应答后触发的关闭请求；由宿主（CLI）接管进程退出。 */
  onShutdownRequested: () => void
}

/**
 * 创建优雅关闭路由。
 *
 * @param options - 一次性凭据与关闭请求回调。
 * @returns 挂载到 `/api` 前缀下的 Hono 实例。
 * @throws 不抛出异常；凭据不匹配与跨站来源在请求处理时以 403 拒绝。
 */
export function createShutdownRoutes (
  options: IShutdownRouteOptions,
): Hono<IAppEnv> {
  const routes = new Hono<IAppEnv>()
  /** 只触发一次：重复请求仍应答 202，但不重复调用关闭回调。 */
  let requested = false

  routes.post('/shutdown', (context) => {
    // 带 Origin 的请求来自浏览器页面（CLI 用 fetch 不带 Origin）：
    // 挡掉「本机其他网页发起跨站请求关闭服务」这一条路径。
    if (context.req.header('Origin')) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 403,
        message: '关闭端点不接受携带 Origin 的跨站请求。',
      })
    }

    if (context.req.header(SHUTDOWN_TOKEN_HEADER) !== options.token) {
      throw new ApiError({
        code: 'INVALID_REQUEST',
        status: 403,
        message: '关闭凭据不匹配。',
      })
    }

    if (!requested) {
      requested = true
      // 延迟一拍再触发：让本次 202 先写回客户端，避免连接被关闭序列提前销毁。
      const shutdownTimer = setTimeout(
        options.onShutdownRequested,
        SHUTDOWN_RESPONSE_FLUSH_DELAY_MS,
      )
      shutdownTimer.unref?.()
    }

    const responseBody: IApiSuccessResponse<{ message: string }> = {
      success: true,
      data: { message: '服务正在关闭。' },
    }

    return context.json(responseBody, 202)
  })

  return routes
}

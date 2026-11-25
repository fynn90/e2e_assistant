/**
 * 本地服务启动入口：在可用端口上监听并返回实际端口与关闭句柄。
 *
 * 与「CLI 进程语义」的分界（PRD v18 §4.2 / G4）：
 * 本文件的 `serve()` 是「在本进程内提供一个服务」，属服务层的正当能力；
 * 被禁止的是 `process.exit` / `process.kill` / 信号钩子——那些作用于
 * 「管理其它进程或终结自身」，全部留在调用方（CLI）。
 *
 * 绑定地址固定为回环地址且不对外开放：服务能读写用户工作区文件，
 * 绑回环是它的安全性质；集中在此处，任何客户端都无法把它误暴露到网络。
 */
import type { ServerType } from '@hono/node-server'
import { serve } from '@hono/node-server'
import { createSkillChatRuntime } from '@fynn90-e2e_assistant/agent'
import type { Hono } from 'hono'
import { createHttpApp } from './app'
import type { IAppEnv } from './app-types'
import { ChatConcurrencyGate } from './chat-concurrency'
import { createAgentWorkRuntimeRegistry } from '../agent-runtime/index'
import { findAvailablePort, requireAvailablePort } from './port'

export interface IStartLocalServerOptions {
  /** 首选端口；被占用时由严格模式决定「顺延」还是「报错」。 */
  port: number
  /** 严格模式：首选端口必须可用，否则报错而不是顺延（`--strict-port`）。 */
  strictPort?: boolean
  /** bash 可执行文件绝对路径（启动时探测注入）；缺省由 pi-agent-core 自行探测。 */
  shellPath?: string
  /**
   * 优雅关闭的一次性凭据；由调用方（CLI）生成。
   *
   * 提供时服务注册 `POST /api/shutdown`，并对携带该凭据的请求执行关闭序列（§4.3）。
   * 缺省不注册——纯 API 部署没有「谁有权关掉我」这个问题。
   */
  shutdownToken?: string
  /**
   * 应用扩展点：在 API 路由注册完成后挂载额外路由（见 `ICreateHttpAppOptions.extendApp`）。
   *
   * 调用方（CLI）用它把前端静态资源挂到同一个地址上——服务层因此不需要依赖任何前端包。
   * 缺省不挂载：此时该地址是纯 API 服务（可独立部署的形态）。
   */
  extendApp?: (app: Hono<IAppEnv>) => void
}

export interface IStartedLocalServer {
  port: number
  serverUrl: string
  closeServer: () => Promise<void>
  /**
   * 注册「关闭端点被合法请求」的通知处理器（v19 §4.3 / C3）。
   *
   * 端点只做校验、应答与通知：收到通知后**由宿主决定**是否关闭、用什么退出码。
   * 服务层因此不含 `process.exit` / 信号钩子（v18 原则二不破）。
   *
   * @param handler 通知处理器；重复注册时后者取代前者。
   */
  registerShutdownRequestHandler: (handler: () => void) => void
}

/** 启动入口的函数类型；调用方（CLI）用它声明可注入的依赖点，取代跨包不可用的 `typeof`。 */
export type TStartLocalServer = typeof startLocalServer

export async function startLocalServer (
  options: IStartLocalServerOptions,
): Promise<IStartedLocalServer> {
  const availablePort = options.strictPort
    ? await requireAvailablePort({ port: options.port })
    : await findAvailablePort({ preferredPort: options.port })
  const { shellPath } = options
  // 工作通道运行时注册表：按工作区缓存常驻 AgentService，服务关闭时统一释放；
  // bash 路径在注册表构造时绑定，创建运行时自动合并，路由层无需感知。
  const workRuntimeRegistry = createAgentWorkRuntimeRegistry({
    ...(shellPath ? { shellPath } : {}),
  })
  /**
   * 关闭序列（服务侧部分）；由 `createHttpApp` 装配完成后经 `registerShutdownHandler`
   * 回传，因此 app 与 server 各持一份「谁负责哪一段」而无需重复装配逻辑。
   */
  let disposeServiceResources: (() => Promise<void>) | null = null

  /**
   * 关闭端点的宿主回调。
   *
   * 端点在 app 层，而「释放资源 + 退出进程」的序列在 server 层的 `closeServer`——
   * 端点只能通过这个通道请求它（§4.3）。这里捕获启动完成的 `closeServer`。
   */
  let requestHostShutdown: (() => void) | null = null

  const app = createHttpApp({
    // Skill Chat 运行时：每个 /chat 请求由 agent 包的 createSkillChatRuntime
    // 内建 AgentService 执行一轮任务，事件流经路由翻译为 SSE 输出。
    chatRuntimeFactory: (runtimeOptions) =>
      createSkillChatRuntime({
        ...runtimeOptions,
        ...(shellPath ? { shellPath } : {}),
      }),
    chatConcurrencyGate: new ChatConcurrencyGate(2, 1),
    workRuntimeRegistry,
    ...(options.shutdownToken ? { shutdownToken: options.shutdownToken } : {}),
    registerShutdownHandler: (handler) => {
      disposeServiceResources = handler
    },
    // 端点合法请求 → 转发给宿主。宿主通过 `registerShutdownRequestHandler`
    // 登记（CLI 在那里接上「清理记录 + 退出进程」的例行程序）。
    onShutdownRequested: () => requestHostShutdown?.(),
    ...(options.extendApp ? { extendApp: options.extendApp } : {}),
  })

  return await new Promise((resolve, reject) => {
    const nodeServer = serve(
      {
        fetch: app.fetch,
        port: availablePort,
        hostname: '127.0.0.1',
      },
      (serverInfo) => {
        // 幂等：重复调用安全（端点与信号可能同时到达）。
        let isClosed = false

        const closeServer = async (): Promise<void> => {
          if (isClosed) {
            return
          }
          isClosed = true

          // 1-3. 中止在跑任务 → 关浏览器 → 释放 Agent 运行时（app 侧序列，逐步容错）。
          await disposeServiceResources?.()
          // 兜底：app 未提供序列时（纯 API 装配）仍释放注册表。
          await workRuntimeRegistry.disposeAll().catch(() => undefined)

          // 4. 关闭 Node server，并强制销毁全部连接。
          //    `close()` 会等待既有连接结束，而 SSE 是永不结束的响应——
          //    只调 close() 会让关闭挂住（F4 的成因）。
          await closeNodeServer(nodeServer)
        }

        // 端点请求关闭：只释放本层资源，**不退出进程**——宿主（CLI）收到后
        // 会走它自己的例行程序（含退出码），那里才是 `process.exit` 的落点。
        requestHostShutdown = () => {
          void closeServer().catch(() => undefined)
        }

        resolve({
          port: serverInfo.port,
          serverUrl: `http://127.0.0.1:${serverInfo.port}`,
          closeServer,
          registerShutdownRequestHandler: (handler) => {
            requestHostShutdown = handler
          },
        })
      },
    )

    nodeServer.once('error', reject)
  })
}

function closeNodeServer (nodeServer: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeServer.close((error?: Error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })

    // closeAllConnections 主动销毁套接字，SSE 的 onAbort 随之触发、路由层
    // 取消剩余生成/执行流。仅 HTTP/1 的 Server 具备该方法（http2 无此 API），
    // 因此按能力探测调用，不硬转类型（§4.2）。
    if (
      'closeAllConnections' in nodeServer &&
      typeof nodeServer.closeAllConnections === 'function'
    ) {
      nodeServer.closeAllConnections()
    }
  })
}

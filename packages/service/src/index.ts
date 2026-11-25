/**
 * @fynn90-e2e_assistant/service 对外出口。
 *
 * 本地服务层：承载 Web 工作台的全部后端能力（HTTP API、Agent 工作通道运行时、
 * 生成与执行编排、平台配置、Skill 存储）。
 *
 * 本包不含任何进程生命周期管理——不登记 PID、不注册信号钩子、不结束进程。
 * 「启动/停止服务」的进程语义由调用方（apps/cli）负责，见 PRD v18 §4.2。
 */

// —— 服务启动入口（CLI 用它起服务）——
export {
  startLocalServer,
  type IStartLocalServerOptions,
  type IStartedLocalServer,
  type TStartLocalServer,
} from './http/server'

// —— HTTP 应用装配（供测试与未来的内嵌形态直接使用）——
export { createHttpApp, type ICreateHttpAppOptions } from './http/app'

// —— 优雅关闭端点的凭据契约（CLI 与端点各持一端，请求头名不复制第二份）——
export { SHUTDOWN_TOKEN_HEADER } from './http/routes/shutdown'
